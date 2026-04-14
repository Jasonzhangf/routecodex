import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../handlers/types.js';
import type { ProviderHandle } from '../types.js';
import { asRecord } from '../provider-utils.js';
import {
  convertProviderResponse as bridgeConvertProviderResponse,
  createSnapshotRecorder as bridgeCreateSnapshotRecorder
} from '../../../../modules/llmswitch/bridge.js';
import { applyClientConnectionStateToContext } from '../../../utils/client-connection-state.js';
import {
  resolveStopMessageClientInjectReadiness,
  runClientInjectionFlowBeforeReenter
} from './client-injection-flow.js';
import {
  extractClientModelId,
  normalizeProviderResponse
} from './provider-response-utils.js';
import { isVerboseErrorLoggingEnabled } from './env-config.js';
import { extractSseWrapperError } from './sse-error-handler.js';
import { isRateLimitLikeError } from './request-retry-helpers.js';
import { extractUsageFromResult } from './usage-aggregator.js';
import { deriveFinishReason, STREAM_LOG_FINISH_REASON_KEY } from '../../../utils/finish-reason.js';
import { logPipelineStage } from '../../../utils/stage-logger.js';
import { syncReasoningStopModeFromRequest } from '../../../../modules/llmswitch/bridge.js';

const FOLLOWUP_SESSION_HEADER_KEYS = new Set([
  'sessionid',
  'conversationid',
  'xsessionid',
  'xconversationid',
  'anthropicsessionid',
  'anthropicconversationid',
  'xroutecodexsessionid',
  'xroutecodexconversationid',
  'xroutecodexclientdaemonid',
  'xroutecodexclientdid',
  'xrccclientdaemonid',
  'xroutecodexsessiondaemonid',
  'xroutecodexdaemonid',
  'xrccsessiondaemonid',
  'xroutecodexclienttmuxsessionid',
  'xrccclienttmuxsessionid',
  'xroutecodextmuxsessionid',
  'xrcctmuxsessionid',
  'xtmuxsessionid',
  'xroutecodexclientworkdir',
  'xrccclientworkdir',
  'xroutecodexworkdir',
  'xrccworkdir',
  'xworkdir'
]);

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
const NON_BLOCKING_LOG_THROTTLE_MS = 60_000;
const nonBlockingLogState = new Map<string, number>();
const FOLLOWUP_LOG_REASON_MAX_LEN = 180;
const KNOWN_QWEN_HIDDEN_NATIVE_TOOLS = new Set([
  'web_extractor',
  'tool_code_interpreter',
  'code_interpreter',
  'python',
  'browser',
  'web_search',
  'read_file',
  'file_read',
  'cat',
  'bash'
]);

const FATAL_CONVERSION_ERROR_CODES = new Set([
  'CLIENT_TOOL_ARGS_INVALID',
  'QWENCHAT_INVALID_TOOL_ARGS'
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

function backfillAdapterContextSessionIdentifiersFromOriginalRequest(
  baseContext: Record<string, unknown>,
  originalRequest: unknown
): void {
  const original = asFlatRecord(originalRequest);
  if (!original) {
    return;
  }
  const requestMetadata = asFlatRecord(original.metadata);
  const capturedRequest = asFlatRecord(baseContext.capturedChatRequest);
  const capturedMetadata = asFlatRecord(capturedRequest?.metadata);

  const sessionId =
    readSessionLikeToken(baseContext.sessionId) ??
    readSessionLikeToken(original.sessionId) ??
    readSessionLikeToken(original.session_id) ??
    readSessionLikeToken(requestMetadata?.sessionId) ??
    readSessionLikeToken(requestMetadata?.session_id) ??
    readSessionLikeToken(capturedRequest?.sessionId) ??
    readSessionLikeToken(capturedRequest?.session_id) ??
    readSessionLikeToken(capturedMetadata?.sessionId) ??
    readSessionLikeToken(capturedMetadata?.session_id);
  const conversationId =
    readSessionLikeToken(baseContext.conversationId) ??
    readSessionLikeToken(original.conversationId) ??
    readSessionLikeToken(original.conversation_id) ??
    readSessionLikeToken(requestMetadata?.conversationId) ??
    readSessionLikeToken(requestMetadata?.conversation_id) ??
    readSessionLikeToken(capturedRequest?.conversationId) ??
    readSessionLikeToken(capturedRequest?.conversation_id) ??
    readSessionLikeToken(capturedMetadata?.conversationId) ??
    readSessionLikeToken(capturedMetadata?.conversation_id);

  if (sessionId && !readSessionLikeToken(baseContext.sessionId)) {
    baseContext.sessionId = sessionId;
  }
  if (conversationId && !readSessionLikeToken(baseContext.conversationId)) {
    baseContext.conversationId = conversationId;
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

function inferQwenChatBusinessStatusCode(reason: string, code: string): number {
  const normalized = `${code} ${reason}`.trim().toLowerCase();
  if (
    normalized.includes('ratelimit') ||
    normalized.includes('rate_limit') ||
    normalized.includes('daily usage limit') ||
    normalized.includes('allocated quota exceeded') ||
    normalized.includes('quota exceeded') ||
    normalized.includes('quota limit') ||
    normalized.includes('insufficient quota') ||
    normalized.includes('no resource') ||
    normalized.includes('resource exhausted') ||
    normalized.includes('too many request') ||
    normalized.includes('达到今日的使用上限') ||
    normalized.includes('请求过于频繁')
  ) {
    return 429;
  }
  if (
    normalized.includes('forbidden') ||
    normalized.includes('permission denied') ||
    normalized.includes('没有权限') ||
    normalized.includes('无权限') ||
    normalized.includes('permission')
  ) {
    return 403;
  }
  if (
    normalized.includes('unauthorized') ||
    normalized.includes('invalid token') ||
    normalized.includes('login') ||
    normalized.includes('auth') ||
    normalized.includes('未登录')
  ) {
    return 401;
  }
  return 502;
}

function extractQwenChatBusinessRejection(payload: unknown): {
  message: string;
  statusCode: number;
  code: string;
} | undefined {
  const record = asFlatRecord(payload);
  if (!record) {
    return undefined;
  }
  const data = asFlatRecord(record.data);
  const error = asFlatRecord(record.error);
  const success = record.success;
  const rawCode =
    (typeof record.code === 'string' ? record.code : '') ||
    (typeof data?.code === 'string' ? data.code : '') ||
    (typeof error?.code === 'string' ? error.code : '');
  const rawMessage =
    (typeof record.message === 'string' ? record.message : '') ||
    (typeof data?.details === 'string' ? data.details : '') ||
    (typeof data?.message === 'string' ? data.message : '') ||
    (typeof error?.details === 'string' ? error.details : '') ||
    (typeof error?.message === 'string' ? error.message : '');
  const hasFailureSignal = success === false || Boolean(rawCode) || Boolean(error);
  if (!hasFailureSignal) {
    return undefined;
  }
  const reason = rawMessage.trim() || rawCode.trim() || 'upstream rejected request';
  const statusCode = inferQwenChatBusinessStatusCode(reason, rawCode);
  return {
    message: `QwenChat upstream rejected completion request: ${reason}`,
    statusCode,
    code: statusCode === 429 ? 'QWENCHAT_RATE_LIMITED' : 'QWENCHAT_COMPLETION_REJECTED'
  };
}

function findQwenChatBusinessRejectionDeep(
  payload: unknown,
  depth = 6,
  seen = new Set<unknown>()
): {
  message: string;
  statusCode: number;
  code: string;
} | undefined {
  if (depth < 0 || payload === null || payload === undefined) {
    return undefined;
  }
  if (typeof payload === 'string') {
    const parsed = tryParseJsonLikeString(payload);
    if (parsed !== undefined) {
      return findQwenChatBusinessRejectionDeep(parsed, depth - 1, seen);
    }
    return undefined;
  }
  if (typeof payload !== 'object') {
    return undefined;
  }
  if (seen.has(payload)) {
    return undefined;
  }
  seen.add(payload);

  const direct = extractQwenChatBusinessRejection(payload);
  if (direct) {
    return direct;
  }

  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const nested = findQwenChatBusinessRejectionDeep(entry, depth - 1, seen);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  for (const key of ['body', 'data', 'payload', 'response', 'error', 'raw']) {
    const nested = findQwenChatBusinessRejectionDeep(record[key], depth - 1, seen);
    if (nested) {
      return nested;
    }
  }
  for (const value of Object.values(record)) {
    const nested = findQwenChatBusinessRejectionDeep(value, depth - 1, seen);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function extractQwenChatSseAssistantText(raw: string): string {
  if (!raw.trim()) {
    return '';
  }
  const chunks: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) {
      continue;
    }
    const payloadText = trimmed.slice(5).trim();
    if (!payloadText || payloadText === '[DONE]') {
      continue;
    }
    try {
      const payload = JSON.parse(payloadText) as Record<string, unknown>;
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      for (const choice of choices) {
        if (!choice || typeof choice !== 'object' || Array.isArray(choice)) {
          continue;
        }
        const delta = asFlatRecord((choice as Record<string, unknown>).delta);
        const content = typeof delta?.content === 'string' ? delta.content : '';
        if (content) {
          chunks.push(content);
        }
      }
    } catch {
      continue;
    }
  }
  return chunks.join('');
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

function analyzeQwenChatRecoveredToolCalls(args: {
  body: unknown;
  baseContext?: Record<string, unknown>;
}): {
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  invalidCall?: {
    name: string;
    reason: string;
    message?: string;
    missingFields?: string[];
  };
} {
  const raw = findNestedRawString(args.body);
  const assistantText = extractQwenChatSseAssistantText(raw);
  const declaredToolNames = collectDeclaredToolNames(args.baseContext ?? {});
  const carrier = assistantText || raw;
  const markerMatch = carrier.match(/<<RCC_TOOL_CALLS(?:_JSON)?/i);
  if (!markerMatch) {
    return { toolCalls: [] };
  }
  const tail = carrier.slice(markerMatch.index ?? 0);
  const jsonBody = extractFirstBalancedJsonObject(tail);
  if (jsonBody) {
    try {
      const parsed = JSON.parse(jsonBody) as Record<string, unknown>;
      return normalizeRecoveredToolCalls(parsed.tool_calls, declaredToolNames);
    } catch {
      return { toolCalls: [] };
    }
  }
  const partialNameMatch = tail.match(/"name"\s*:\s*"([^"]+)"/i);
  const partialInputMatch = tail.match(/"input"\s*:\s*(\{[\s\S]*\})/i);
  if (partialNameMatch?.[1] && partialInputMatch?.[1]) {
    const inputJson = extractFirstBalancedJsonObject(partialInputMatch[1]);
    if (inputJson) {
      try {
        const parsedInput = JSON.parse(inputJson);
        return normalizeRecoveredToolCalls(
          [{ name: partialNameMatch[1], input: parsedInput }],
          declaredToolNames
        );
      } catch {
        return { toolCalls: [] };
      }
    }
  }
  return { toolCalls: [] };
}

function tryRecoverQwenChatToolCalls(args: {
  body: unknown;
  baseContext?: Record<string, unknown>;
}): Array<{ name: string; input: Record<string, unknown> }> {
  return analyzeQwenChatRecoveredToolCalls(args).toolCalls;
}

function buildRecoveredQwenChatProviderResponse(args: {
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  model?: string;
  requestId: string;
}): Record<string, unknown> | undefined {
  if (!args.toolCalls.length) {
    return undefined;
  }
  return {
    id: `${args.requestId}:qwenchat-recovered`,
    object: 'chat.completion',
    model: args.model || 'qwenchat-recovered',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: args.toolCalls.map((toolCall, index) => ({
            id: `call_qwenchat_recovered_${index + 1}`,
            type: 'function',
            function: {
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.input ?? {})
            }
          }))
        }
      }
    ]
  };
}

function extractIncompleteQwenChatToolPrelude(raw: string): string | undefined {
  const markerMatch = raw.match(/<<RCC_TOOL_CALLS(?:_JSON)?/i);
  if (!markerMatch) {
    return undefined;
  }
  const tail = raw.slice(markerMatch.index ?? 0);
  const hasToolCallJson = /"tool_calls"\s*:/i.test(tail);
  const hasBalancedJsonObject = Boolean(extractFirstBalancedJsonObject(tail));
  const bodyWithoutOpener = tail.slice(markerMatch[0].length);
  const hasClosingLine = /(?:^|\r?\n)RCC_TOOL_CALLS(?:_JSON)?(?:\r?\n|$)/i.test(bodyWithoutOpener);
  if (hasToolCallJson && hasBalancedJsonObject && hasClosingLine) {
    return undefined;
  }
  return markerMatch[0];
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

function extractQwenChatTerminalStreamError(payload: unknown): {
  message: string;
  code?: string;
  statusCode?: number;
  retryable?: boolean;
  toolName?: string;
  phase?: string;
} | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const streamLike =
    record.__sse_responses && typeof record.__sse_responses === 'object' && !Array.isArray(record.__sse_responses)
      ? (record.__sse_responses as Record<string, unknown>)
      : undefined;
  const terminalError =
    streamLike &&
    streamLike.__routecodexTerminalError &&
    typeof streamLike.__routecodexTerminalError === 'object' &&
    !Array.isArray(streamLike.__routecodexTerminalError)
      ? (streamLike.__routecodexTerminalError as Record<string, unknown>)
      : undefined;
  if (!terminalError) {
    return undefined;
  }
  const message = typeof terminalError.message === 'string' ? terminalError.message.trim() : '';
  if (!message) {
    return undefined;
  }
  return {
    message,
    ...(typeof terminalError.code === 'string' && terminalError.code.trim()
      ? { code: terminalError.code.trim() }
      : {}),
    ...(typeof terminalError.statusCode === 'number' && Number.isFinite(terminalError.statusCode)
      ? { statusCode: terminalError.statusCode }
      : typeof terminalError.status === 'number' && Number.isFinite(terminalError.status)
        ? { statusCode: terminalError.status }
        : {}),
    ...(typeof terminalError.retryable === 'boolean' ? { retryable: terminalError.retryable } : {}),
    ...(typeof terminalError.toolName === 'string' && terminalError.toolName.trim()
      ? { toolName: terminalError.toolName.trim() }
      : {}),
    ...(typeof terminalError.phase === 'string' && terminalError.phase.trim()
      ? { phase: terminalError.phase.trim() }
      : {})
  };
}

function remapMalformedQwenChatError(args: {
  error: Record<string, unknown>;
  body: unknown;
  baseContext?: Record<string, unknown>;
}): Error | undefined {
  const code = typeof args.error.code === 'string' ? args.error.code.trim() : '';
  const message = typeof args.error.message === 'string' ? args.error.message : '';
  if (code !== 'MALFORMED_RESPONSE' && !message.toLowerCase().includes('canonicalize response payload')) {
    return undefined;
  }

  const terminalStreamError = extractQwenChatTerminalStreamError(args.body);
  if (terminalStreamError?.code === 'QWENCHAT_HIDDEN_NATIVE_TOOL') {
    const err = new Error(terminalStreamError.message) as Error & {
      code?: string;
      status?: number;
      statusCode?: number;
      retryable?: boolean;
      upstreamCode?: string;
      toolName?: string;
      phase?: string;
    };
    err.code = 'QWENCHAT_HIDDEN_NATIVE_TOOL';
    err.status = terminalStreamError.statusCode ?? 502;
    err.statusCode = terminalStreamError.statusCode ?? 502;
    err.retryable = terminalStreamError.retryable ?? false;
    err.upstreamCode = 'QWENCHAT_HIDDEN_NATIVE_TOOL';
    err.toolName = terminalStreamError.toolName;
    err.phase = terminalStreamError.phase;
    return err;
  }

  const raw = findNestedRawString(args.body);
  const errorMarker = findNestedErrorMarker(args.body).toUpperCase();
  const rawUpper = raw.toUpperCase();
  const declaredToolNames = collectDeclaredToolNames(args.baseContext ?? {});
  const functionNameMatch =
    raw.match(/"function_call"\s*:\s*\{\s*"name"\s*:\s*"([^"]+)"/i) ||
    raw.match(/"tool_calls"\s*:\s*\[[\s\S]*?"name"\s*:\s*"([^"]+)"/i);
  const phaseMatch = raw.match(/"phase"\s*:\s*"([^"]+)"/i);
  const functionName = functionNameMatch?.[1]?.trim() || '';
  const phase = phaseMatch?.[1]?.trim() || '';
  const isKnownQwenHiddenNativeTool = KNOWN_QWEN_HIDDEN_NATIVE_TOOLS.has(functionName.toLowerCase());
  if (
    functionName &&
    (
      (declaredToolNames.size > 0 && !declaredToolNames.has(functionName.toLowerCase()))
      || isKnownQwenHiddenNativeTool
    )
  ) {
    const err = new Error(
      `QwenChat upstream emitted undeclared native tool "${functionName}"${phase ? ` (phase=${phase})` : ''}`
    ) as Error & {
      code?: string;
      status?: number;
      statusCode?: number;
      retryable?: boolean;
      upstreamCode?: string;
      toolName?: string;
      phase?: string;
    };
    err.code = 'QWENCHAT_HIDDEN_NATIVE_TOOL';
    err.status = 502;
    err.statusCode = 502;
    err.retryable = false;
    err.upstreamCode = 'QWENCHAT_HIDDEN_NATIVE_TOOL';
    err.toolName = functionName;
    err.phase = phase || undefined;
    return err;
  }

  if (
    errorMarker === 'UPSTREAM_STREAM_TIMEOUT' ||
    rawUpper.includes('UPSTREAM_STREAM_TIMEOUT')
  ) {
    const err = new Error('QwenChat upstream stream timed out before producing a canonical assistant payload') as Error & {
      code?: string;
      status?: number;
      statusCode?: number;
      retryable?: boolean;
      upstreamCode?: string;
    };
    err.code = 'QWENCHAT_UPSTREAM_STREAM_TIMEOUT';
    err.status = 502;
    err.statusCode = 502;
    err.retryable = true;
    err.upstreamCode = 'UPSTREAM_STREAM_TIMEOUT';
    return err;
  }

  const businessRejection = findQwenChatBusinessRejectionDeep(args.body);
  if (businessRejection) {
    const err = new Error(businessRejection.message) as Error & {
      code?: string;
      status?: number;
      statusCode?: number;
      retryable?: boolean;
      upstreamCode?: string;
    };
    err.code = businessRejection.code;
    err.status = businessRejection.statusCode;
    err.statusCode = businessRejection.statusCode;
    err.retryable = businessRejection.statusCode === 429;
    err.upstreamCode = businessRejection.code;
    return err;
  }

  const recoveredToolAnalysis = analyzeQwenChatRecoveredToolCalls({
    body: args.body,
    baseContext: args.baseContext
  });
  if (recoveredToolAnalysis.invalidCall) {
    const err = new Error(
      recoveredToolAnalysis.invalidCall.message
        ? `QwenChat upstream emitted invalid client tool arguments for "${recoveredToolAnalysis.invalidCall.name}": ${recoveredToolAnalysis.invalidCall.message}`
        : `QwenChat upstream emitted invalid client tool arguments for "${recoveredToolAnalysis.invalidCall.name}" (${recoveredToolAnalysis.invalidCall.reason})`
    ) as Error & {
      code?: string;
      status?: number;
      statusCode?: number;
      retryable?: boolean;
      upstreamCode?: string;
      toolName?: string;
      validationReason?: string;
      validationMessage?: string;
      missingFields?: string[];
      details?: Record<string, unknown>;
    };
    err.code = 'QWENCHAT_INVALID_TOOL_ARGS';
    err.status = 502;
    err.statusCode = 502;
    err.retryable = false;
    err.upstreamCode = 'QWENCHAT_INVALID_TOOL_ARGS';
    err.toolName = recoveredToolAnalysis.invalidCall.name;
    err.validationReason = recoveredToolAnalysis.invalidCall.reason;
    err.validationMessage = recoveredToolAnalysis.invalidCall.message;
    if (recoveredToolAnalysis.invalidCall.missingFields?.length) {
      err.missingFields = recoveredToolAnalysis.invalidCall.missingFields;
    }
    err.details = {
      ...(err.details ?? {}),
      toolName: recoveredToolAnalysis.invalidCall.name,
      validationReason: recoveredToolAnalysis.invalidCall.reason,
      ...(recoveredToolAnalysis.invalidCall.message
        ? { validationMessage: recoveredToolAnalysis.invalidCall.message }
        : {}),
      ...(recoveredToolAnalysis.invalidCall.missingFields?.length
        ? { missingFields: recoveredToolAnalysis.invalidCall.missingFields }
        : {})
    };
    return err;
  }

  const incompletePrelude = extractIncompleteQwenChatToolPrelude(raw);
  if (incompletePrelude) {
    const err = new Error(
      `QwenChat upstream emitted incomplete dry-run tool container starting with ${incompletePrelude}; retry required`
    ) as Error & {
      code?: string;
      status?: number;
      statusCode?: number;
      retryable?: boolean;
      upstreamCode?: string;
    };
    err.code = 'QWENCHAT_INCOMPLETE_TOOL_DRYRUN';
    err.status = 502;
    err.statusCode = 502;
    err.retryable = true;
    err.upstreamCode = 'QWENCHAT_INCOMPLETE_TOOL_DRYRUN';
    return err;
  }

  return undefined;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function logProviderResponseConverterNonBlockingError(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  const now = Date.now();
  const last = nonBlockingLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingLogState.set(stage, now);
  try {
    const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(
      `[provider-response-converter] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`
    );
  } catch {
    // Never throw from non-blocking logging.
  }
}

function compactFollowupLogReason(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return undefined;
  }
  const httpMatch =
    normalized.match(/^http\s+(\d{3})\s*:/i) ||
    normalized.match(/\bhttp\s+(\d{3})\b/i);
  if (httpMatch?.[1]) {
    return `HTTP_${httpMatch[1]}`;
  }
  if (/<\s*!doctype\s+html\b/i.test(normalized) || /<\s*html\b/i.test(normalized)) {
    return 'UPSTREAM_HTML_ERROR';
  }
  if (normalized.length <= FOLLOWUP_LOG_REASON_MAX_LEN) {
    return normalized;
  }

  return `${normalized.slice(0, FOLLOWUP_LOG_REASON_MAX_LEN)}…`;
}

function backfillCapturedChatRequestToolsFromRequestSemantics(
  baseContext: Record<string, unknown>,
  requestSemantics: unknown
): void {
  const capturedChatRequest =
    baseContext.capturedChatRequest &&
    typeof baseContext.capturedChatRequest === 'object' &&
    !Array.isArray(baseContext.capturedChatRequest)
      ? (baseContext.capturedChatRequest as Record<string, unknown>)
      : undefined;
  const semanticsRecord =
    requestSemantics && typeof requestSemantics === 'object' && !Array.isArray(requestSemantics)
      ? (requestSemantics as Record<string, unknown>)
      : undefined;
  const toolsRecord =
    semanticsRecord?.tools && typeof semanticsRecord.tools === 'object' && !Array.isArray(semanticsRecord.tools)
      ? (semanticsRecord.tools as Record<string, unknown>)
      : undefined;
  const clientToolsRaw = Array.isArray(toolsRecord?.clientToolsRaw) ? toolsRecord.clientToolsRaw : undefined;
  if (!capturedChatRequest || !clientToolsRaw?.length) {
    return;
  }
  const existingTools = Array.isArray(capturedChatRequest.tools) ? capturedChatRequest.tools : undefined;
  if (existingTools?.length) {
    return;
  }
  capturedChatRequest.tools = clientToolsRaw;
}

function preferOriginalRequestForReasoningStopSync(
  baseContext: Record<string, unknown>,
  originalRequest: unknown
): void {
  if (!asFlatRecord(originalRequest)) {
    return;
  }
  if (!hasStoplessDirectiveInRequestPayload(originalRequest)) {
    return;
  }
  if (hasStoplessDirectiveInRequestPayload(baseContext.capturedChatRequest)) {
    return;
  }
  baseContext.capturedChatRequest = originalRequest as Record<string, unknown>;
}

function seedReasoningStopStateFromCapturedRequest(
  baseContext: Record<string, unknown>
): void {
  try {
    syncReasoningStopModeFromRequest(baseContext, 'on');
  } catch (error) {
    logProviderResponseConverterNonBlockingError(
      'seedReasoningStopStateFromCapturedRequest',
      error
    );
  }
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

function canonicalizeHeaderName(headerName: string): string {
  return headerName.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractFollowupSessionHeaders(
  headers: unknown
): Record<string, string> | undefined {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return undefined;
  }
  const source = headers as Record<string, unknown>;
  const preserved: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(source)) {
    if (!FOLLOWUP_SESSION_HEADER_KEYS.has(canonicalizeHeaderName(headerName))) {
      continue;
    }
    if (typeof headerValue !== 'string') {
      continue;
    }
    const normalizedValue = headerValue.trim();
    if (!normalizedValue) {
      continue;
    }
    preserved[headerName] = normalizedValue;
  }
  return Object.keys(preserved).length ? preserved : undefined;
}

function extractPreservedSessionToken(
  headers: Record<string, string> | undefined,
  field: 'session' | 'conversation'
): string | undefined {
  if (!headers) {
    return undefined;
  }
  for (const [headerName, headerValue] of Object.entries(headers)) {
    const normalizedName = canonicalizeHeaderName(headerName);
    if (field === 'session' && normalizedName.endsWith('sessionid')) {
      return headerValue;
    }
    if (field === 'conversation' && normalizedName.endsWith('conversationid')) {
      return headerValue;
    }
  }
  return undefined;
}

function extractPreservedDaemonOrInjectToken(
  headers: Record<string, string> | undefined,
  field: 'daemon' | 'tmux' | 'workdir'
): string | undefined {
  if (!headers) {
    return undefined;
  }
  for (const [headerName, headerValue] of Object.entries(headers)) {
    const normalizedName = canonicalizeHeaderName(headerName);
    if (field === 'daemon' && (normalizedName.endsWith('sessiondaemonid') || normalizedName.endsWith('daemonid'))) {
      return headerValue;
    }
    if (field === 'tmux' && normalizedName.endsWith('tmuxsessionid')) {
      return headerValue;
    }
    if (field === 'workdir' && normalizedName.endsWith('workdir')) {
      return headerValue;
    }
  }
  return undefined;
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
      };
      error.code = 'SSE_DECODE_ERROR';
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
    const originalModelId = extractClientModelId(metadataBag, options.originalRequest);
    const assignedModelId =
      typeof (metadataBag as Record<string, unknown> | undefined)?.assignedModelId === 'string'
        ? String((metadataBag as Record<string, unknown>).assignedModelId)
        : metadataBag &&
            typeof metadataBag === 'object' &&
            metadataBag.target &&
            typeof metadataBag.target === 'object' &&
            typeof (metadataBag.target as Record<string, unknown>).modelId === 'string'
          ? ((metadataBag.target as Record<string, unknown>).modelId as string)
          : typeof (metadataBag as Record<string, unknown> | undefined)?.modelId === 'string'
            ? String((metadataBag as Record<string, unknown>).modelId)
            : undefined;
    const baseContext: Record<string, unknown> = {
      ...(metadataBag ?? {})
    };
    const hasValidCapturedChatRequest =
      baseContext.capturedChatRequest &&
      typeof baseContext.capturedChatRequest === 'object' &&
      !Array.isArray(baseContext.capturedChatRequest);
    if (
      !hasValidCapturedChatRequest &&
      options.originalRequest &&
      typeof options.originalRequest === 'object' &&
      !Array.isArray(options.originalRequest)
    ) {
      baseContext.capturedChatRequest = options.originalRequest;
    }
    preferOriginalRequestForReasoningStopSync(baseContext, options.originalRequest);
    backfillAdapterContextSessionIdentifiersFromOriginalRequest(baseContext, options.originalRequest);
    backfillCapturedChatRequestToolsFromRequestSemantics(baseContext, options.requestSemantics);
    seedReasoningStopStateFromCapturedRequest(baseContext);
    if (typeof (metadataBag as Record<string, unknown> | undefined)?.routeName === 'string') {
      baseContext.routeId = (metadataBag as Record<string, unknown>).routeName as string;
    }
    baseContext.requestId = options.requestId;
    baseContext.entryEndpoint = options.entryEndpoint || entry;
    baseContext.providerProtocol = options.providerProtocol;
    baseContext.originalModelId = originalModelId;
    if (assignedModelId && assignedModelId.trim()) {
      baseContext.modelId = assignedModelId.trim();
    }
    applyClientConnectionStateToContext(metadataBag, baseContext);
    adapterContext = baseContext;
    const stopMessageInjectReadiness = resolveStopMessageClientInjectReadiness(baseContext);
    {
      const rt = asRecord((adapterContext as Record<string, unknown>).__rt) ?? {};
      (adapterContext as Record<string, unknown>).__rt = {
        ...rt,
        stopMessageClientInjectReady: stopMessageInjectReadiness.ready,
        stopMessageClientInjectReason: stopMessageInjectReadiness.reason,
        ...(stopMessageInjectReadiness.sessionScope
          ? { stopMessageClientInjectSessionScope: stopMessageInjectReadiness.sessionScope }
          : {}),
        ...(stopMessageInjectReadiness.tmuxSessionId
          ? { stopMessageClientInjectTmuxSessionId: stopMessageInjectReadiness.tmuxSessionId }
          : {})
      };
    }
    const hasTargetMetadata =
      metadataBag &&
      typeof metadataBag === 'object' &&
      metadataBag.target &&
      typeof metadataBag.target === 'object';
    const targetCompatProfile =
      hasTargetMetadata &&
      typeof (metadataBag.target as Record<string, unknown>).compatibilityProfile === 'string'
        ? ((metadataBag.target as Record<string, unknown>).compatibilityProfile as string)
        : undefined;
    const metadataCompatProfile =
      typeof (metadataBag as Record<string, unknown> | undefined)?.compatibilityProfile === 'string'
        ? String((metadataBag as Record<string, unknown>).compatibilityProfile)
        : undefined;
    const compatProfile = hasTargetMetadata ? targetCompatProfile : metadataCompatProfile;
    if (compatProfile && compatProfile.trim()) {
      adapterContext.compatibilityProfile = compatProfile.trim();
    }
    const serverToolsEnabled = options.serverToolsEnabled !== false;
    (adapterContext as Record<string, unknown>).serverToolsEnabled = serverToolsEnabled;
    if (!serverToolsEnabled) {
      (adapterContext as Record<string, unknown>).serverToolsDisabled = true;
    }
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
      logPipelineStage('convert.reenter.start', reenterOpts.requestId, {
        entryEndpoint: reenterOpts.entryEndpoint || options.entryEndpoint || entry
      });
      const nestedEntry = reenterOpts.entryEndpoint || options.entryEndpoint || entry;
      const nestedExtra = asRecord(reenterOpts.metadata) ?? {};

      const buildNestedMetadata = (extra: Record<string, unknown>, resolvedEntry: string): Record<string, unknown> => {
        const out: Record<string, unknown> = {
          ...(metadataBag ?? {}),
          ...extra,
          entryEndpoint: resolvedEntry,
          direction: 'request',
          stage: 'inbound'
        };
        try {
          const baseRt = asRecord((metadataBag as any)?.__rt) ?? {};
          const extraRt = asRecord((extra as any)?.__rt) ?? {};
          if (Object.keys(baseRt).length || Object.keys(extraRt).length) {
            (out as any).__rt = { ...baseRt, ...extraRt };
          }
        } catch (error) {
          logProviderResponseConverterNonBlockingError('reenter.buildNestedMetadata.mergeRuntimeMeta', error, {
            requestId: reenterOpts.requestId,
            entryEndpoint: resolvedEntry
          });
        }

        if (asRecord((out as any).__rt)?.serverToolFollowup === true) {
          const preservedClientHeaders = extractFollowupSessionHeaders(out.clientHeaders);
          if (preservedClientHeaders) {
            out.clientHeaders = preservedClientHeaders;
            const sessionId = extractPreservedSessionToken(preservedClientHeaders, 'session');
            const conversationId = extractPreservedSessionToken(preservedClientHeaders, 'conversation');
            if (sessionId) {
              out.sessionId = sessionId;
            }
            if (conversationId) {
              out.conversationId = conversationId;
            }
          } else {
            delete out.clientHeaders;
          }
          delete out.clientRequestId;
        }
        return out;
      };

      const nestedMetadata: Record<string, unknown> = buildNestedMetadata(nestedExtra, nestedEntry);

      const nestedInput: PipelineExecutionInput = {
        entryEndpoint: nestedEntry,
        method: 'POST',
        requestId: reenterOpts.requestId,
        headers: {},
        query: {},
        body: reenterOpts.body,
        metadata: nestedMetadata
      };

      const nestedResult = await deps.executeNested(nestedInput);
      logPipelineStage('convert.reenter.completed', reenterOpts.requestId, {
        entryEndpoint: nestedEntry,
        status: nestedResult.status,
        elapsedMs: Date.now() - reenterStartMs
      });
      const nestedBody =
        nestedResult.body && typeof nestedResult.body === 'object'
          ? (nestedResult.body as Record<string, unknown>)
          : undefined;
      return { body: nestedBody };
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
      const nestedExtra = asRecord(injectOpts.metadata) ?? {};
      const nestedMetadata: Record<string, unknown> = (() => {
        const out: Record<string, unknown> = {
        ...(metadataBag ?? {}),
        ...nestedExtra,
        entryEndpoint: nestedEntry,
        direction: 'request',
        stage: 'inbound'
      };
      try {
        const baseRt = asRecord((metadataBag as any)?.__rt) ?? {};
        const extraRt = asRecord((nestedExtra as any)?.__rt) ?? {};
        if (Object.keys(baseRt).length || Object.keys(extraRt).length) {
            (out as any).__rt = { ...baseRt, ...extraRt };
        }
      } catch (error) {
        logProviderResponseConverterNonBlockingError('clientInjectDispatch.mergeRuntimeMeta', error, {
          requestId: injectOpts.requestId,
          entryEndpoint: nestedEntry
        });
      }

      if (asRecord((out as any).__rt)?.serverToolFollowup === true) {
        const preservedClientHeaders = extractFollowupSessionHeaders(out.clientHeaders);
        if (preservedClientHeaders) {
          out.clientHeaders = preservedClientHeaders;
        } else {
          delete out.clientHeaders;
        }
        delete out.clientRequestId;
      }
        return out;
      })();

      const requestBody =
        injectOpts.body && typeof injectOpts.body === 'object' && !Array.isArray(injectOpts.body)
          ? (injectOpts.body as Record<string, unknown>)
          : {};
      const injectResult = await runClientInjectionFlowBeforeReenter({
        nestedMetadata,
        requestBody,
        requestId: injectOpts.requestId
      });
      clientInjectWaitMs += Math.max(0, Date.now() - clientInjectAttemptStartedAt);
      if (injectResult.clientInjectOnlyHandled) {
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
        reason: 'client_inject_not_handled',
        elapsedMs: Date.now() - clientInjectStartMs
      });
      return { ok: false, reason: 'client_inject_not_handled' };
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
      const body: Record<string, unknown> = { __sse_responses: converted.__sse_responses };
      if (usage) {
        body.usage = usage;
      }
      if (finishReason) {
        body[STREAM_LOG_FINISH_REASON_KEY] = finishReason;
      }
      return attachTimingBreakdown({
        ...options.response,
        body
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
    const malformedQwenFallbackContext = (() => {
      const metadataBag = asRecord(options.pipelineMetadata);
      const fallbackContext: Record<string, unknown> = {
        ...(metadataBag ?? {})
      };
      if (
        !fallbackContext.capturedChatRequest &&
        options.originalRequest &&
        typeof options.originalRequest === 'object' &&
        !Array.isArray(options.originalRequest)
      ) {
        fallbackContext.capturedChatRequest = options.originalRequest;
      }
      preferOriginalRequestForReasoningStopSync(fallbackContext, options.originalRequest);
      backfillAdapterContextSessionIdentifiersFromOriginalRequest(fallbackContext, options.originalRequest);
      backfillCapturedChatRequestToolsFromRequestSemantics(fallbackContext, options.requestSemantics);
      return fallbackContext;
    })();
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
    const isServerToolFollowupError =
      errCode === 'SERVERTOOL_FOLLOWUP_FAILED' ||
      errCode === 'SERVERTOOL_EMPTY_FOLLOWUP' ||
      (typeof errCode === 'string' && errCode.startsWith('SERVERTOOL_'));
    const normalizedMessage = message.toLowerCase();
    const isContextLengthExceeded = isContextLengthExceededError(
      normalizedMessage,
      upstreamCode || detailUpstreamCode,
      detailReason
    );
    const remappedMalformedQwenChatError = remapMalformedQwenChatError({
      error: errRecord,
      body,
      baseContext: malformedQwenFallbackContext
    });
    const recoveredQwenChatToolCalls = tryRecoverQwenChatToolCalls({
      body,
      baseContext: malformedQwenFallbackContext
    });

    if (recoveredQwenChatToolCalls.length > 0) {
      const recoveredProviderResponse = buildRecoveredQwenChatProviderResponse({
        toolCalls: recoveredQwenChatToolCalls,
        model:
          typeof options.originalRequest?.model === 'string'
            ? String(options.originalRequest.model)
            : undefined,
        requestId: options.requestId
      });
      if (recoveredProviderResponse) {
        try {
          const convertedRecovered = await bridgeConvertProviderResponse({
            providerProtocol: options.providerProtocol,
            providerResponse: recoveredProviderResponse,
            context: adapterContext ?? malformedQwenFallbackContext,
            entryEndpoint: options.entryEndpoint || entry,
            wantsStream: options.wantsStream,
            requestSemantics: options.requestSemantics
          });
          validateConvertedProviderToolCallsOrThrow(
            convertedRecovered.body ?? recoveredProviderResponse,
            collectDeclaredToolNames(malformedQwenFallbackContext)
          );
          logPipelineStage('convert.bridge.recovered_partial_tool_container', options.requestId, {
            recoveredToolCalls: recoveredQwenChatToolCalls.length,
            toolNames: recoveredQwenChatToolCalls.map((item) => item.name).join(',')
          });
          if (convertedRecovered.__sse_responses) {
            return attachTimingBreakdown({
              ...options.response,
              body: { __sse_responses: convertedRecovered.__sse_responses }
            });
          }
          return attachTimingBreakdown({
            ...options.response,
            body: convertedRecovered.body ?? body
          });
        } catch (recoveryError) {
          logProviderResponseConverterNonBlockingError('recoverQwenChatToolCalls', recoveryError, {
            requestId: options.requestId,
            recoveredToolCalls: recoveredQwenChatToolCalls.length
          });
        }
      }
    }

    if (remappedMalformedQwenChatError) {
      logPipelineStage('convert.bridge.error', options.requestId, {
        code: (remappedMalformedQwenChatError as { code?: string }).code,
        upstreamCode: (remappedMalformedQwenChatError as { upstreamCode?: string }).upstreamCode,
        message: remappedMalformedQwenChatError.message
      });
      throw remappedMalformedQwenChatError;
    }

    if (isSseDecodeError || isServerToolFollowupError || isContextLengthExceeded) {
      if (isSseDecodeError || isContextLengthExceeded) {
        remapBridgeSseErrorToHttp(errRecord, message);
      }
      const normalizedCode = typeof errRecord.code === 'string' ? errRecord.code : errCode;
      if (isServerToolFollowupError) {
        const compactReason = compactFollowupLogReason(detailReason) || compactFollowupLogReason(message);
        const compactUpstreamCode = compactFollowupLogReason(upstreamCode || detailUpstreamCode);
        const compactCode = compactFollowupLogReason(normalizedCode) || normalizedCode || 'UNKNOWN';
        console.warn(
          `[RequestExecutor] ServerTool followup failed req=${options.requestId}` +
            ` code=${compactCode}` +
            (compactUpstreamCode ? ` upstreamCode=${compactUpstreamCode}` : '') +
            (compactReason ? ` reason=${JSON.stringify(compactReason)}` : '')
        );
        if (normalizedUpstreamCode === 'client_inject_failed') {
          // Followup rejection should not break the main assistant response.
          return options.response;
        }
      }
      logPipelineStage('convert.bridge.error', options.requestId, {
        code: normalizedCode,
        upstreamCode: upstreamCode || detailUpstreamCode,
        reason: compactFollowupLogReason(detailReason),
        message
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
    return options.response;
  }
}
