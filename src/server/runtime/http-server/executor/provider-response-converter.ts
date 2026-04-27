import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../handlers/types.js';
import type { ProviderHandle } from '../types.js';
import { asRecord } from '../provider-utils.js';
import {
  convertProviderResponse as bridgeConvertProviderResponse,
  createSnapshotRecorder as bridgeCreateSnapshotRecorder
} from '../../../../modules/llmswitch/bridge.js';
import {
  normalizeProviderResponse
} from './provider-response-utils.js';
import { isVerboseErrorLoggingEnabled } from './env-config.js';
import { logExecutorRuntimeNonBlockingWarning } from './servertool-runtime-log.js';
import { extractSseWrapperError } from './sse-error-handler.js';
import { isRateLimitLikeError } from './request-retry-helpers.js';
import { extractUsageFromResult } from './usage-aggregator.js';
import { deriveFinishReason } from '../../../utils/finish-reason.js';
import { logPipelineStage } from '../../../utils/stage-logger.js';
import {
  buildServerToolSseWrapperBody
} from './servertool-response-normalizer.js';
import {
  buildServerToolAdapterContext
} from './servertool-adapter-context.js';
import {
  executeServerToolClientInjectDispatch,
  executeServerToolReenterPipeline
} from './servertool-followup-dispatch.js';
import {
  compactFollowupLogReason,
  extractServerToolFollowupErrorLogDetails,
  finalizeServerToolBridgeConvertError
} from './servertool-followup-error.js';

const CONTEXT_LENGTH_MESSAGE_HINTS = [
  'context_length_exceeded',
  'context_window_exceeded',
  'model_context_window_exceeded',
  'context length exceeded',
  'context window exceeded',
  "model's maximum context length",
  'maximum context length',
  'max context length',
  'input tokens exceeds',
  'input tokens exceed',
  '对话长度上限',
  '达到对话长度上限'
];

const RETRYABLE_NETWORK_MESSAGE_HINTS = [
  'internal network failure',
  'network failure',
  'network error',
  'api connection error',
  'service unavailable',
  'temporarily unavailable',
  'temporarily unreachable',
  'connection reset',
  'connection closed',
  'timed out',
  'timeout'
];

const RETRYABLE_NETWORK_CODE_HINTS = [
  'internal_network_failure',
  'network_error',
  'api_connection_error',
  'service_unavailable',
  'request_timeout',
  'timeout'
];

const truthy = new Set(['1', 'true', 'yes', 'on']);

const FATAL_CONVERSION_ERROR_CODES = new Set([
  'CLIENT_TOOL_ARGS_INVALID',
]);
const STOPLESS_DIRECTIVE_PATTERN = /<\*\*stopless:[^*]+\*\*>/i;

function isImagePathLike(value: string): boolean {
  return /\.(png|jpg|jpeg|gif|webp|bmp|svg|tiff?|ico|heic|jxl)$/i.test(value);
}

function parseToolArgsRecord(argsString: string): Record<string, unknown> | null {
  const trimmed = String(argsString || '').trim();
  if (!trimmed || !(trimmed.startsWith('{') || trimmed.startsWith('['))) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return asFlatRecord(parsed) ?? null;
  } catch {
    return null;
  }
}

function buildMissingFields(fields: Array<string | undefined>): string[] | undefined {
  const normalized = fields
    .map((field) => (typeof field === 'string' ? field.trim() : ''))
    .filter((field): field is string => Boolean(field));
  return normalized.length ? normalized : undefined;
}

function buildToolValidationFailure(args: {
  reason: string;
  message: string;
  missingFields?: string[];
}): {
  ok: false;
  reason: string;
  message: string;
  missingFields?: string[];
} {
  return {
    ok: false,
    reason: args.reason,
    message: args.message,
    ...(args.missingFields?.length ? { missingFields: args.missingFields } : {})
  };
}

function readReasoningStopBoolean(value: unknown): boolean | undefined {
  if (value === true) {
    return true;
  }
  if (value === false) {
    return false;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  return undefined;
}

function validateCanonicalClientToolCall(
  name: string,
  argsString: string,
  declaredToolNames?: Set<string>
): {
  ok: boolean;
  reason?: string;
  message?: string;
  missingFields?: string[];
  normalizedArgs?: string;
} {
  const parsed = parseToolArgsRecord(argsString);
  const normalizedName = name.trim().toLowerCase();
  switch (normalizedName) {
    case 'exec_command': {
      const cmd = typeof parsed?.cmd === 'string' ? parsed.cmd.trim() : '';
      if (!cmd) {
        return buildToolValidationFailure({
          reason: 'missing_cmd',
          message: 'exec_command requires input.cmd as a non-empty string.',
          missingFields: ['cmd']
        });
      }
      return { ok: true, normalizedArgs: JSON.stringify({ ...parsed, cmd }) };
    }
    case 'view_image': {
      const pathValue = typeof parsed?.path === 'string' ? parsed.path.trim() : '';
      if (!pathValue || !isImagePathLike(pathValue)) {
        return buildToolValidationFailure({
          reason: 'invalid_image_path',
          message: 'view_image requires input.path pointing to an image file.'
        });
      }
      return { ok: true, normalizedArgs: JSON.stringify({ path: pathValue }) };
    }
    case 'apply_patch': {
      const patch =
        typeof parsed?.patch === 'string' && parsed.patch.trim()
          ? parsed.patch
          : typeof parsed?.input === 'string' && parsed.input.trim()
            ? parsed.input
            : '';
      if (!patch) {
        return buildToolValidationFailure({
          reason: 'missing_patch',
          message: 'apply_patch requires patch content in input.patch or input.input.',
          missingFields: ['patch']
        });
      }
      return { ok: true, normalizedArgs: JSON.stringify({ patch, input: patch }) };
    }
    case 'update_plan': {
      if (!Array.isArray(parsed?.plan)) {
        return buildToolValidationFailure({
          reason: 'missing_plan',
          message: 'update_plan requires input.plan as an array.',
          missingFields: ['plan']
        });
      }
      return { ok: true, normalizedArgs: JSON.stringify({ explanation: parsed?.explanation, plan: parsed.plan }) };
    }
    case 'shell_command':
    case 'bash': {
      const command = typeof parsed?.command === 'string' ? parsed.command.trim() : '';
      if (!command) {
        return buildToolValidationFailure({
          reason: 'missing_command',
          message: `${normalizedName} requires input.command as a non-empty string.`,
          missingFields: ['command']
        });
      }
      return { ok: true, normalizedArgs: JSON.stringify(parsed) };
    }
    case 'shell': {
      const command = parsed?.command;
      if (!(Array.isArray(command) && command.every((entry) => typeof entry === 'string' && entry.trim().length > 0))) {
        return buildToolValidationFailure({
          reason: 'invalid_command',
          message: 'shell requires input.command as a non-empty string array.'
        });
      }
      return { ok: true, normalizedArgs: JSON.stringify(parsed) };
    }
    case 'read_mcp_resource': {
      const server = typeof parsed?.server === 'string' ? parsed.server.trim() : '';
      const uri = typeof parsed?.uri === 'string' ? parsed.uri.trim() : '';
      if (!server || !uri) {
        return buildToolValidationFailure({
          reason: 'missing_server_or_uri',
          message: 'read_mcp_resource requires both input.server and input.uri.',
          missingFields: buildMissingFields([
            !server ? 'server' : undefined,
            !uri ? 'uri' : undefined
          ])
        });
      }
      return { ok: true, normalizedArgs: JSON.stringify({ server, uri }) };
    }
    case 'reasoning.stop': {
      if (!parsed) {
        return buildToolValidationFailure({
          reason: 'invalid_reasoning_stop_arguments',
          message: 'reasoning.stop requires a JSON object arguments payload.'
        });
      }
      const taskGoal = typeof parsed.task_goal === 'string'
        ? parsed.task_goal.trim()
        : typeof parsed.taskGoal === 'string'
          ? parsed.taskGoal.trim()
          : typeof parsed.goal === 'string'
            ? parsed.goal.trim()
            : '';
      if (!taskGoal) {
        return buildToolValidationFailure({
          reason: 'invalid_reasoning_stop_arguments',
          message: 'reasoning.stop requires task_goal.',
          missingFields: ['task_goal']
        });
      }
      const completed = readReasoningStopBoolean(parsed.is_completed ?? parsed.isCompleted ?? parsed.completed);
      if (typeof completed !== 'boolean') {
        return buildToolValidationFailure({
          reason: 'invalid_reasoning_stop_arguments',
          message: 'reasoning.stop requires is_completed(boolean).',
          missingFields: ['is_completed']
        });
      }
      return { ok: true, normalizedArgs: JSON.stringify(parsed) };
    }
    case 'list_mcp_resources':
    case 'list_mcp_resource_templates':
      return { ok: true, normalizedArgs: JSON.stringify(parsed ?? {}) };
    default:
      if (declaredToolNames?.has(normalizedName)) {
        if (!parsed) {
          return buildToolValidationFailure({
            reason: 'invalid_declared_tool_arguments',
            message: `Tool "${name.trim()}" requires JSON object arguments.`
          });
        }
        return { ok: true, normalizedArgs: JSON.stringify(parsed) };
      }
      const declaredList = declaredToolNames && declaredToolNames.size > 0
        ? Array.from(declaredToolNames).sort().join(', ')
        : '';
      return buildToolValidationFailure({
        reason: 'unknown_tool',
        message: declaredList
          ? `Tool "${name.trim()}" is not declared for this request. Declared tools: ${declaredList}.`
          : `Tool "${name.trim()}" is not declared for this request.`
      });
  }
}

function readSessionLikeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asFlatRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function tryParseJsonLikeString(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (
    !(trimmed.startsWith('{') || trimmed.startsWith('['))
    && !trimmed.includes('{"')
    && !trimmed.includes("{'")
  ) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const balanced = extractFirstBalancedJsonObject(trimmed);
    if (!balanced) {
      return undefined;
    }
    try {
      return JSON.parse(balanced);
    } catch {
      return undefined;
    }
  }
}

function extractContentTextForStoplessScan(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const text = typeof (item as Record<string, unknown>).text === 'string'
      ? String((item as Record<string, unknown>).text)
      : '';
    if (text) {
      parts.push(text);
    }
  }
  return parts.join('\n');
}

function extractLatestUserTextForStoplessScan(source: unknown): string {
  const record = asFlatRecord(source);
  if (!record) {
    return '';
  }
  const rows = Array.isArray(record.messages)
    ? record.messages
    : Array.isArray(record.input)
      ? record.input
      : [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = asFlatRecord(rows[i]);
    if (!row) {
      continue;
    }
    const role = typeof row.role === 'string' ? row.role.trim().toLowerCase() : '';
    if (role !== 'user') {
      continue;
    }
    const text = extractContentTextForStoplessScan(row.content).trim();
    if (text) {
      return text;
    }
  }
  return '';
}

function hasStoplessDirectiveInRequestPayload(source: unknown): boolean {
  return STOPLESS_DIRECTIVE_PATTERN.test(extractLatestUserTextForStoplessScan(source));
}

function collectDeclaredToolNames(baseContext: Record<string, unknown>): Set<string> {
  const capturedRequest = asFlatRecord(baseContext.capturedChatRequest);
  const tools = Array.isArray(capturedRequest?.tools) ? capturedRequest.tools : [];
  const names = new Set<string>();
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
      continue;
    }
    const row = tool as Record<string, unknown>;
    const fn = row.function && typeof row.function === 'object' && !Array.isArray(row.function)
      ? (row.function as Record<string, unknown>)
      : row;
    const name = typeof fn.name === 'string' ? fn.name.trim().toLowerCase() : '';
    if (name) {
      names.add(name);
    }
  }
  return names;
}

function findNestedRawString(payload: unknown, depth = 3): string {
  if (depth < 0 || payload === null || payload === undefined) {
    return '';
  }
  if (typeof payload === 'string') {
    return payload;
  }
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return '';
  }
  const record = payload as Record<string, unknown>;
  const directRaw = typeof record.raw === 'string' ? record.raw : '';
  if (directRaw) {
    return directRaw;
  }
  for (const key of ['body', 'data', 'payload', 'response', 'error']) {
    const nested = findNestedRawString(record[key], depth - 1);
    if (nested) {
      return nested;
    }
  }
  return '';
}

function findNestedErrorMarker(payload: unknown, depth = 3): string {
  if (depth < 0 || payload === null || payload === undefined) {
    return '';
  }
  if (typeof payload === 'string') {
    return payload;
  }
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return '';
  }
  const record = payload as Record<string, unknown>;
  const directError = typeof record.error === 'string' ? record.error.trim() : '';
  if (directError) {
    return directError;
  }
  for (const key of ['body', 'data', 'payload', 'response']) {
    const nested = findNestedErrorMarker(record[key], depth - 1);
    if (nested) {
      return nested;
    }
  }
  return '';
}





function extractFirstBalancedJsonObject(raw: string): string | undefined {
  const start = raw.indexOf('{');
  if (start < 0) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (ch === '\\') {
        escaping = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

function normalizeRecoveredToolCalls(
  value: unknown,
  declaredToolNames: Set<string>
): {
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  invalidCall?: {
    name: string;
    reason: string;
    message?: string;
    missingFields?: string[];
  };
} {
  const rows = Array.isArray(value) ? value : [];
  const normalized: Array<{ name: string; input: Record<string, unknown> }> = [];
  for (const row of rows) {
    const item = asFlatRecord(row);
    const functionRecord = asFlatRecord(item?.function);
    const nameRaw =
      (typeof item?.name === 'string' ? item.name : '') ||
      (typeof functionRecord?.name === 'string' ? functionRecord.name : '');
    const name = nameRaw.trim();
    if (!name) {
      continue;
    }
    if (declaredToolNames.size > 0 && !declaredToolNames.has(name.toLowerCase())) {
      continue;
    }
    const inputRecord =
      asFlatRecord(item?.input)
      ?? asFlatRecord(item?.arguments)
      ?? asFlatRecord(functionRecord?.arguments)
      ?? {};
    const validation = validateCanonicalClientToolCall(name, JSON.stringify(inputRecord ?? {}), declaredToolNames);
    if (!validation.ok) {
      return {
        toolCalls: normalized,
        invalidCall: {
          name,
          reason: validation.reason || 'invalid_tool_arguments',
          message: validation.message,
          ...(validation.missingFields?.length ? { missingFields: validation.missingFields } : {})
        }
      };
    }
    let normalizedInput = inputRecord;
    if (typeof validation.normalizedArgs === 'string') {
      try {
        const parsed = JSON.parse(validation.normalizedArgs);
        if (asFlatRecord(parsed)) {
          normalizedInput = parsed;
        }
      } catch {
        // keep validated original
      }
    }
    normalized.push({ name, input: normalizedInput });
  }
  return { toolCalls: normalized };
}





function stringifyToolCallArgumentsForValidation(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function collectConvertedProviderToolCalls(payload: unknown): Array<{
  name: string;
  argumentsText: string;
  path: string;
}> {
  const result: Array<{ name: string; argumentsText: string; path: string }> = [];
  const record = asFlatRecord(payload);
  if (!record) {
    return result;
  }

  const choices = Array.isArray(record.choices) ? record.choices : [];
  for (let i = 0; i < choices.length; i += 1) {
    const choice = asFlatRecord(choices[i]);
    const message = asFlatRecord(choice?.message);
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    for (let j = 0; j < toolCalls.length; j += 1) {
      const toolCall = asFlatRecord(toolCalls[j]);
      const fn = asFlatRecord(toolCall?.function);
      const name =
        (typeof fn?.name === 'string' ? fn.name : '')
        || (typeof toolCall?.name === 'string' ? toolCall.name : '');
      if (!name.trim()) {
        continue;
      }
      result.push({
        name: name.trim(),
        argumentsText: stringifyToolCallArgumentsForValidation(fn?.arguments ?? toolCall?.arguments ?? toolCall?.input),
        path: `choices[${i}].message.tool_calls[${j}]`
      });
    }
  }

  const requiredAction = asFlatRecord(record.required_action);
  const submitToolOutputs = asFlatRecord(requiredAction?.submit_tool_outputs);
  const submitToolCalls = Array.isArray(submitToolOutputs?.tool_calls) ? submitToolOutputs.tool_calls : [];
  for (let i = 0; i < submitToolCalls.length; i += 1) {
    const toolCall = asFlatRecord(submitToolCalls[i]);
    const fn = asFlatRecord(toolCall?.function);
    const name =
      (typeof fn?.name === 'string' ? fn.name : '')
      || (typeof toolCall?.name === 'string' ? toolCall.name : '');
    if (!name.trim()) {
      continue;
    }
    result.push({
      name: name.trim(),
      argumentsText: stringifyToolCallArgumentsForValidation(fn?.arguments ?? toolCall?.arguments ?? toolCall?.input),
      path: `required_action.submit_tool_outputs.tool_calls[${i}]`
    });
  }

  return result;
}

function validateConvertedProviderToolCallsOrThrow(
  payload: unknown,
  declaredToolNames?: Set<string>
): void {
  const toolCalls = collectConvertedProviderToolCalls(payload);
  for (const toolCall of toolCalls) {
    const validation = validateCanonicalClientToolCall(toolCall.name, toolCall.argumentsText, declaredToolNames);
    if (validation.ok) {
      continue;
    }
    const err = new Error(
      validation.message
        ? `Converted provider tool call has invalid client arguments at ${toolCall.path}: ${toolCall.name}. ${validation.message}`
        : `Converted provider tool call has invalid client arguments at ${toolCall.path}: ${toolCall.name} (${validation.reason || 'invalid_tool_arguments'})`
    ) as Error & {
      code?: string;
      status?: number;
      statusCode?: number;
      retryable?: boolean;
      toolName?: string;
      validationReason?: string;
      validationMessage?: string;
      missingFields?: string[];
      upstreamCode?: string;
      details?: Record<string, unknown>;
    };
    err.code = 'CLIENT_TOOL_ARGS_INVALID';
    err.status = 502;
    err.statusCode = 502;
    err.retryable = false;
    err.upstreamCode = 'CLIENT_TOOL_ARGS_INVALID';
    err.toolName = toolCall.name;
    err.validationReason = validation.reason || 'invalid_tool_arguments';
    err.validationMessage = validation.message;
    if (validation.missingFields?.length) {
      err.missingFields = validation.missingFields;
    }
    err.details = {
      ...(err.details ?? {}),
      toolName: toolCall.name,
      validationReason: validation.reason || 'invalid_tool_arguments',
      ...(validation.message ? { validationMessage: validation.message } : {}),
      ...(validation.missingFields?.length ? { missingFields: validation.missingFields } : {})
    };
    throw err;
  }
}



function isGenericBridgeResponseContractError(args: {
  error: Record<string, unknown>;
  message: string;
}): boolean {
  const code = typeof args.error.code === 'string' ? args.error.code.trim() : '';
  const name = typeof args.error.name === 'string' ? args.error.name.trim() : '';
  const normalizedMessage = args.message.trim().toLowerCase();
  if (name !== 'ProviderProtocolError') {
    return false;
  }
  if (code !== 'MALFORMED_RESPONSE') {
    return false;
  }
  return (
    normalizedMessage.includes('[hub_response] non-canonical response payload')
    || normalizedMessage.includes('[hub_response] failed to canonicalize response payload')
  );
}

function logProviderResponseConverterNonBlockingError(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  logExecutorRuntimeNonBlockingWarning({
    namespace: 'provider-response-converter',
    stage,
    error,
    details,
    throttleKey: stage
  });
}

function shouldEnableHubStageRecorder(): boolean {
  const raw = String(
    process.env.ROUTECODEX_ENABLE_HUB_STAGE_RECORDER
    ?? process.env.RCC_ENABLE_HUB_STAGE_RECORDER
    ?? ''
  ).trim().toLowerCase();
  return truthy.has(raw);
}

function isContextLengthExceededError(
  message: string,
  upstreamCode?: string,
  detailReason?: string
): boolean {
  const normalizedMessage = message.toLowerCase();
  const normalizedUpstream = typeof upstreamCode === 'string' ? upstreamCode.trim().toLowerCase() : '';
  const normalizedReason = typeof detailReason === 'string' ? detailReason.trim().toLowerCase() : '';
  if (
    normalizedUpstream.includes('context_length_exceeded') ||
    normalizedUpstream.includes('context_window_exceeded') ||
    normalizedUpstream.includes('model_context_window_exceeded')
  ) {
    return true;
  }
  if (
    normalizedReason === 'context_length_exceeded' ||
    normalizedReason === 'context_window_exceeded' ||
    normalizedReason === 'model_context_window_exceeded'
  ) {
    return true;
  }
  return CONTEXT_LENGTH_MESSAGE_HINTS.some((hint) => normalizedMessage.includes(hint));
}

function isRetryableNetworkSseWrapperError(message: string, upstreamCode?: string, statusCode?: number): boolean {
  if (typeof statusCode === 'number' && Number.isFinite(statusCode)) {
    if (statusCode === 408 || statusCode === 425 || statusCode === 502 || statusCode === 503 || statusCode === 504) {
      return true;
    }
  }
  const normalizedMessage = String(message || '').trim().toLowerCase();
  const normalizedUpstream = typeof upstreamCode === 'string' ? upstreamCode.trim().toLowerCase() : '';
  if (normalizedUpstream && RETRYABLE_NETWORK_CODE_HINTS.some((hint) => normalizedUpstream.includes(hint))) {
    return true;
  }
  return RETRYABLE_NETWORK_MESSAGE_HINTS.some((hint) => normalizedMessage.includes(hint));
}

function remapBridgeSseErrorToHttp(error: Record<string, unknown>, message: string): void {
  const detailRecord = asRecord(error.details);
  const upstreamCode =
    typeof error.upstreamCode === 'string'
      ? error.upstreamCode
      : typeof detailRecord?.upstreamCode === 'string'
        ? detailRecord.upstreamCode
        : undefined;
  const detailReason = typeof detailRecord?.reason === 'string' ? detailRecord.reason : undefined;
  const statusCodeRaw =
    typeof error.statusCode === 'number'
      ? error.statusCode
      : typeof error.status === 'number'
        ? error.status
        : typeof detailRecord?.statusCode === 'number'
          ? detailRecord.statusCode
          : undefined;
  const isContextLengthExceeded = isContextLengthExceededError(message, upstreamCode, detailReason);
  if (isContextLengthExceeded) {
    (error as any).status = 400;
    (error as any).statusCode = 400;
    (error as any).retryable = false;
    (error as any).code = 'CONTEXT_LENGTH_EXCEEDED';
    if (typeof error.upstreamCode !== 'string' || !String(error.upstreamCode).trim()) {
      (error as any).upstreamCode = upstreamCode || 'context_length_exceeded';
    }
    return;
  }
  if (isRateLimitLikeError(message, String(error.code || ''), upstreamCode)) {
    (error as any).status = 429;
    (error as any).statusCode = 429;
    (error as any).retryable = true;
    (error as any).code = 'HTTP_429';
    return;
  }
  if (isRetryableNetworkSseWrapperError(message, upstreamCode, statusCodeRaw)) {
    (error as any).status = 502;
    (error as any).statusCode = 502;
    (error as any).retryable = true;
    (error as any).code = 'HTTP_502';
  }
}

function syncHubStageTopBackToPipelineMetadata(options: {
  pipelineMetadata?: Record<string, unknown>;
  adapterContext: Record<string, unknown>;
}): void {
  const pipelineMetadata = asRecord(options.pipelineMetadata);
  if (!pipelineMetadata) {
    return;
  }
  const adapterRt = asRecord((options.adapterContext as Record<string, unknown>).__rt);
  if (!adapterRt || !Array.isArray(adapterRt.hubStageTop) || adapterRt.hubStageTop.length === 0) {
    return;
  }
  const metadataRt = asRecord((pipelineMetadata as Record<string, unknown>).__rt) ?? {};
  (pipelineMetadata as Record<string, unknown>).__rt = {
    ...metadataRt,
    hubStageTop: adapterRt.hubStageTop
  };
}

export type ConvertProviderResponseOptions = {
  entryEndpoint?: string;
  providerProtocol: string;
  providerType?: string;
  requestId: string;
  serverToolsEnabled?: boolean;
  wantsStream: boolean;
  originalRequest?: Record<string, unknown> | undefined;
  requestSemantics?: Record<string, unknown> | undefined;
  processMode?: string;
  response: PipelineExecutionResult;
  pipelineMetadata?: Record<string, unknown>;
};

export type ConvertProviderResponseDeps = {
  runtimeManager: {
    resolveRuntimeKey(providerKey?: string, fallback?: string): string | undefined;
    getHandleByRuntimeKey(runtimeKey?: string): ProviderHandle | undefined;
  };
  executeNested(input: PipelineExecutionInput): Promise<PipelineExecutionResult>;
};

export async function convertProviderResponseIfNeeded(
  options: ConvertProviderResponseOptions,
  deps: ConvertProviderResponseDeps
): Promise<PipelineExecutionResult> {
  const body = options.response.body;
  if (body && typeof body === 'object') {
    const wrapperError = extractSseWrapperError(body as Record<string, unknown>);
    if (wrapperError) {
      const codeSuffix = wrapperError.errorCode ? ` [${wrapperError.errorCode}]` : '';
      const error = new Error(`Upstream SSE error event${codeSuffix}: ${wrapperError.message}`) as Error & {
        code?: string;
        status?: number;
        statusCode?: number;
        retryable?: boolean;
        upstreamCode?: string;
        requestExecutorProviderErrorStage?: string;
      };
      error.code = 'SSE_DECODE_ERROR';
      error.requestExecutorProviderErrorStage = 'provider.sse_decode';
      if (wrapperError.errorCode) {
        error.upstreamCode = wrapperError.errorCode;
      }
      error.retryable = wrapperError.retryable;
      if (typeof wrapperError.statusCode === 'number' && Number.isFinite(wrapperError.statusCode)) {
        error.status = wrapperError.statusCode;
        error.statusCode = wrapperError.statusCode;
      }
      const isContextLengthExceeded = isContextLengthExceededError(wrapperError.message, wrapperError.errorCode);
      if (isContextLengthExceeded) {
        error.code = 'CONTEXT_LENGTH_EXCEEDED';
        error.status = 400;
        error.statusCode = 400;
        error.retryable = false;
        if (typeof error.upstreamCode !== 'string' || !error.upstreamCode.trim()) {
          error.upstreamCode = wrapperError.errorCode || 'context_length_exceeded';
        }
      }
      if (!isContextLengthExceeded && isRateLimitLikeError(wrapperError.message, wrapperError.errorCode)) {
        error.code = 'HTTP_429';
        error.status = 429;
        error.statusCode = 429;
        error.retryable = true;
      } else if (
        !isContextLengthExceeded &&
        isRetryableNetworkSseWrapperError(wrapperError.message, wrapperError.errorCode, wrapperError.statusCode)
      ) {
        error.code = 'HTTP_502';
        error.status = 502;
        error.statusCode = 502;
        error.retryable = true;
      } else if (wrapperError.retryable && error.statusCode === undefined) {
        error.status = 503;
        error.statusCode = 503;
      }
      throw error;
    }
  }
  if (options.processMode === 'passthrough' && !options.wantsStream && options.serverToolsEnabled === false) {
    return options.response;
  }
  const entry = (options.entryEndpoint || '').toLowerCase();
  const needsAnthropicConversion = entry.includes('/v1/messages');
  const needsResponsesConversion = entry.includes('/v1/responses');
  const needsChatConversion = entry.includes('/v1/chat/completions');
  if (!needsAnthropicConversion && !needsResponsesConversion && !needsChatConversion) {
    return options.response;
  }
  if (!body || typeof body !== 'object') {
    return options.response;
  }
  let clientInjectWaitMs = 0;
  const attachTimingBreakdown = (result: PipelineExecutionResult): PipelineExecutionResult => {
    if (!(clientInjectWaitMs > 0)) {
      return result;
    }
    const existing = result.timingBreakdown;
    const nextClientInjectWaitMs = Math.max(
      0,
      Math.floor((existing?.clientInjectWaitMs ?? 0) + clientInjectWaitMs)
    );
    const nextHubResponseExcludedMs = Math.max(
      0,
      Math.floor((existing?.hubResponseExcludedMs ?? 0) + clientInjectWaitMs)
    );
    return {
      ...result,
      timingBreakdown: {
        ...existing,
        clientInjectWaitMs: nextClientInjectWaitMs,
        hubResponseExcludedMs: nextHubResponseExcludedMs
      }
    };
  };
  let adapterContext: Record<string, unknown> | undefined;
  try {
    const metadataBag = asRecord(options.pipelineMetadata);
    const baseContext = buildServerToolAdapterContext({
      metadata: metadataBag,
      originalRequest: options.originalRequest,
      requestSemantics: options.requestSemantics,
      requestId: options.requestId,
      entryEndpoint: options.entryEndpoint || entry,
      providerProtocol: options.providerProtocol,
      serverToolsEnabled: options.serverToolsEnabled !== false,
      onReasoningStopSeedError: (error) => {
        logProviderResponseConverterNonBlockingError(
          'seedReasoningStopStateFromCapturedRequest',
          error
        );
      }
    });
    adapterContext = baseContext;
    const serverToolsEnabled = options.serverToolsEnabled !== false;
    let stageRecorder: unknown;
    if (shouldEnableHubStageRecorder()) {
      logPipelineStage('convert.snapshot_recorder.start', options.requestId, {
        entryEndpoint: options.entryEndpoint || entry,
        providerProtocol: options.providerProtocol
      });
      const snapshotRecorderStartMs = Date.now();
      stageRecorder = await bridgeCreateSnapshotRecorder(
        adapterContext,
        typeof (adapterContext as Record<string, unknown>).entryEndpoint === 'string'
          ? ((adapterContext as Record<string, unknown>).entryEndpoint as string)
          : options.entryEndpoint || entry
      );
      logPipelineStage('convert.snapshot_recorder.completed', options.requestId, {
        entryEndpoint: options.entryEndpoint || entry,
        providerProtocol: options.providerProtocol,
        elapsedMs: Date.now() - snapshotRecorderStartMs
      });
    }

    const providerInvoker = async (invokeOptions: {
      providerKey: string;
      providerType?: string;
      modelId?: string;
      providerProtocol: string;
      payload: Record<string, unknown>;
      entryEndpoint: string;
      requestId: string;
      routeHint?: string;
    }): Promise<{ providerResponse: Record<string, unknown> }> => {
      const providerInvokeStartMs = Date.now();
      logPipelineStage('convert.provider_invoke.start', invokeOptions.requestId, {
        providerKey: invokeOptions.providerKey,
        providerProtocol: invokeOptions.providerProtocol,
        routeHint: invokeOptions.routeHint
      });
      if (invokeOptions.routeHint) {
        const carrier = invokeOptions.payload as { metadata?: Record<string, unknown> };
        const existingMeta =
          carrier.metadata && typeof carrier.metadata === 'object'
            ? (carrier.metadata as Record<string, unknown>)
            : {};
        carrier.metadata = {
          ...existingMeta,
          routeHint: existingMeta.routeHint ?? invokeOptions.routeHint
        };
      }

      const runtimeKey = deps.runtimeManager.resolveRuntimeKey(invokeOptions.providerKey);
      if (!runtimeKey) {
        throw new Error(`Runtime for provider ${invokeOptions.providerKey} not initialized`);
      }
      logPipelineStage('convert.provider_invoke.runtime_resolved', invokeOptions.requestId, {
        providerKey: invokeOptions.providerKey,
        runtimeKey
      });
      const handle = deps.runtimeManager.getHandleByRuntimeKey(runtimeKey);
      if (!handle) {
        throw new Error(`Provider runtime ${runtimeKey} not found`);
      }
      logPipelineStage('convert.provider_invoke.send.start', invokeOptions.requestId, {
        providerKey: invokeOptions.providerKey,
        runtimeKey
      });
      const providerSendStartMs = Date.now();
      const providerResponse = await handle.instance.processIncoming(invokeOptions.payload);
      logPipelineStage('convert.provider_invoke.send.completed', invokeOptions.requestId, {
        providerKey: invokeOptions.providerKey,
        runtimeKey,
        elapsedMs: Date.now() - providerSendStartMs
      });
      const normalizeStartMs = Date.now();
      const normalized = normalizeProviderResponse(providerResponse);
      logPipelineStage('convert.provider_invoke.normalize.completed', invokeOptions.requestId, {
        providerKey: invokeOptions.providerKey,
        runtimeKey,
        status: normalized.status,
        elapsedMs: Date.now() - normalizeStartMs
      });
      const bodyPayload =
        normalized.body && typeof normalized.body === 'object'
          ? (normalized.body as Record<string, unknown>)
          : (normalized as unknown as Record<string, unknown>);
      logPipelineStage('convert.provider_invoke.completed', invokeOptions.requestId, {
        providerKey: invokeOptions.providerKey,
        runtimeKey,
        elapsedMs: Date.now() - providerInvokeStartMs
      });
      return { providerResponse: bodyPayload };
    };

    const reenterPipeline = async (reenterOpts: {
      entryEndpoint: string;
      requestId: string;
      body: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }): Promise<{ body?: Record<string, unknown>; __sse_responses?: unknown; format?: string }> => {
      const reenterStartMs = Date.now();
      const nestedEntry = reenterOpts.entryEndpoint || options.entryEndpoint || entry;
      logPipelineStage('convert.reenter.start', reenterOpts.requestId, {
        entryEndpoint: nestedEntry
      });
      const nestedResult = await executeServerToolReenterPipeline({
        entryEndpoint: reenterOpts.entryEndpoint,
        fallbackEntryEndpoint: options.entryEndpoint || entry,
        requestId: reenterOpts.requestId,
        body: reenterOpts.body,
        metadata: reenterOpts.metadata,
        baseMetadata: metadataBag,
        executeNested: deps.executeNested,
        runClientInjectBeforeNested: false,
        onMergeRuntimeMetaError: (error, details) => {
          logProviderResponseConverterNonBlockingError('reenter.buildNestedMetadata.mergeRuntimeMeta', error, {
            requestId: details.requestId,
            entryEndpoint: details.entryEndpoint
          });
        }
      });
      logPipelineStage('convert.reenter.completed', reenterOpts.requestId, {
        entryEndpoint: nestedEntry,
        elapsedMs: Date.now() - reenterStartMs
      });
      return nestedResult;
    };

    const clientInjectDispatch = async (injectOpts: {
      entryEndpoint: string;
      requestId: string;
      body?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }): Promise<{ ok: boolean; reason?: string }> => {
      const clientInjectAttemptStartedAt = Date.now();
      const clientInjectStartMs = Date.now();
      logPipelineStage('convert.client_inject.start', injectOpts.requestId, {
        entryEndpoint: injectOpts.entryEndpoint || options.entryEndpoint || entry
      });
      const nestedEntry = injectOpts.entryEndpoint || options.entryEndpoint || entry;
      const injectResult = await executeServerToolClientInjectDispatch({
        entryEndpoint: injectOpts.entryEndpoint,
        fallbackEntryEndpoint: options.entryEndpoint || entry,
        requestId: injectOpts.requestId,
        body: injectOpts.body,
        metadata: injectOpts.metadata,
        baseMetadata: metadataBag,
        onMergeRuntimeMetaError: (error, details) => {
          logProviderResponseConverterNonBlockingError('clientInjectDispatch.mergeRuntimeMeta', error, {
            requestId: details.requestId,
            entryEndpoint: details.entryEndpoint
          });
        }
      });
      clientInjectWaitMs += Math.max(0, Date.now() - clientInjectAttemptStartedAt);
      if (injectResult.ok) {
        logPipelineStage('convert.client_inject.completed', injectOpts.requestId, {
          entryEndpoint: nestedEntry,
          handled: true,
          elapsedMs: Date.now() - clientInjectStartMs
        });
        return { ok: true };
      }
      logPipelineStage('convert.client_inject.completed', injectOpts.requestId, {
        entryEndpoint: nestedEntry,
        handled: false,
        reason: injectResult.reason || 'client_inject_not_handled',
        elapsedMs: Date.now() - clientInjectStartMs
      });
      return { ok: false, reason: injectResult.reason || 'client_inject_not_handled' };
    };

    logPipelineStage('convert.bridge.start', options.requestId, {
      entryEndpoint: options.entryEndpoint || entry,
      providerProtocol: options.providerProtocol,
      wantsStream: options.wantsStream
    });
    const bridgeStartMs = Date.now();
    const converted = await bridgeConvertProviderResponse({
      providerProtocol: options.providerProtocol,
      providerResponse: body as Record<string, unknown>,
      context: adapterContext,
      entryEndpoint: options.entryEndpoint || entry,
      wantsStream: options.wantsStream,
      requestSemantics: options.requestSemantics,
      providerInvoker: serverToolsEnabled ? providerInvoker : undefined,
      stageRecorder,
      reenterPipeline: serverToolsEnabled ? reenterPipeline : undefined,
      clientInjectDispatch: serverToolsEnabled ? clientInjectDispatch : undefined
    });
    syncHubStageTopBackToPipelineMetadata({
      pipelineMetadata: options.pipelineMetadata,
      adapterContext
    });
    logPipelineStage('convert.bridge.completed', options.requestId, {
      entryEndpoint: options.entryEndpoint || entry,
      providerProtocol: options.providerProtocol,
      hasSse: Boolean(converted.__sse_responses),
      hasBody: converted.body !== undefined && converted.body !== null,
      elapsedMs: Date.now() - bridgeStartMs
    });
    validateConvertedProviderToolCallsOrThrow(converted.body ?? body, collectDeclaredToolNames(baseContext));
    if (converted.__sse_responses) {
      const usage = converted.body
        ? extractUsageFromResult({ body: converted.body })
        : undefined;
      const finishReason = deriveFinishReason(converted.body);
      logPipelineStage('convert.sse_wrapper_detected', options.requestId, {
        hasUsage: Boolean(usage),
        finishReason
      });
      return attachTimingBreakdown({
        ...options.response,
        body: buildServerToolSseWrapperBody({
          sseResponses: converted.__sse_responses,
          convertedBody: converted.body,
          usage
        })
      });
    }
    return attachTimingBreakdown({
      ...options.response,
      body: converted.body ?? body
    });
  } catch (error) {
    const err = error as Error | unknown;
    const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
    const errRecord = err as Record<string, unknown>;
    const errCode = typeof errRecord.code === 'string' ? errRecord.code : undefined;
    const upstreamCode = typeof errRecord.upstreamCode === 'string' ? errRecord.upstreamCode : undefined;
    const errName = typeof errRecord.name === 'string' ? errRecord.name : undefined;
    const detailRecord = asRecord(errRecord.details);
    const detailUpstreamCode =
      typeof (detailRecord as Record<string, unknown> | undefined)?.upstreamCode === 'string'
        ? String((detailRecord as Record<string, unknown>).upstreamCode)
        : undefined;
    const detailReason =
      typeof (detailRecord as Record<string, unknown> | undefined)?.reason === 'string'
        ? String((detailRecord as Record<string, unknown>).reason)
        : typeof (detailRecord as Record<string, unknown> | undefined)?.error === 'string'
          ? String((detailRecord as Record<string, unknown>).error)
        : undefined;
    const normalizedUpstreamCode = (upstreamCode || detailUpstreamCode || '').trim().toLowerCase();
    const fatalConversionCode =
      (typeof errCode === 'string' && FATAL_CONVERSION_ERROR_CODES.has(errCode) ? errCode : undefined)
      ?? (typeof upstreamCode === 'string' && FATAL_CONVERSION_ERROR_CODES.has(upstreamCode) ? upstreamCode : undefined)
      ?? (typeof detailUpstreamCode === 'string' && FATAL_CONVERSION_ERROR_CODES.has(detailUpstreamCode) ? detailUpstreamCode : undefined);
    if (fatalConversionCode) {
      logPipelineStage('convert.bridge.error', options.requestId, {
        code: errCode,
        upstreamCode: upstreamCode || detailUpstreamCode,
        reason: detailReason,
        message
      });
      throw error;
    }
    const isSseDecodeError =
      errCode === 'SSE_DECODE_ERROR' ||
      errCode === 'HTTP_502' ||
      errCode === 'HTTP_429' ||
      (errName === 'ProviderProtocolError' && message.toLowerCase().includes('sse'));
    const normalizedMessage = message.toLowerCase();
    const isContextLengthExceeded = isContextLengthExceededError(
      normalizedMessage,
      upstreamCode || detailUpstreamCode,
      detailReason
    );

    if (isGenericBridgeResponseContractError({ error: errRecord, message })) {
      errRecord.requestExecutorProviderErrorStage = 'host.response_contract';
    }

    const convertErrorPlan = finalizeServerToolBridgeConvertError({
      error,
      requestId: options.requestId,
      defaultFollowupStatus: 502,
      message,
      isSseDecodeError,
      isContextLengthExceeded,
      code: errCode,
      upstreamCode,
      detailUpstreamCode,
      detailReason
    });
    const isServerToolFollowupFailure = convertErrorPlan.handled
      && (errRecord as { requestExecutorProviderErrorStage?: unknown }).requestExecutorProviderErrorStage === 'provider.followup';
    const followupLogDetails = isServerToolFollowupFailure
      ? extractServerToolFollowupErrorLogDetails(error)
      : undefined;

    if (convertErrorPlan.handled) {
      if (isSseDecodeError || isContextLengthExceeded) {
        remapBridgeSseErrorToHttp(errRecord, message);
      }
      logPipelineStage('convert.bridge.error', options.requestId, {
        ...(isServerToolFollowupFailure
          ? (convertErrorPlan.stageDetails ?? {})
          : (convertErrorPlan.stageDetails ?? {
              code: followupLogDetails?.code || (typeof errRecord.code === 'string' ? errRecord.code : errCode),
              upstreamCode: followupLogDetails?.upstreamCode || upstreamCode || detailUpstreamCode,
              reason: followupLogDetails?.reason || compactFollowupLogReason(detailReason),
              message
            }))
      });
      if (isVerboseErrorLoggingEnabled()) {
        console.error(
          '[RequestExecutor] Fatal conversion error, bubbling as HTTP error',
          error
        );
      }
      throw error;
    }

    logPipelineStage('convert.bridge.error', options.requestId, {
      code: errCode,
      upstreamCode: upstreamCode || detailUpstreamCode,
      reason: detailReason,
      message
    });
    if (isVerboseErrorLoggingEnabled()) {
      console.error('[RequestExecutor] Failed to convert provider response via llmswitch-core', error);
    }
    throw error;
  }
}
