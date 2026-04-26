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


