import type {
  AnthropicChatCompletionOutcome,
  AnthropicStopReasonResolution,
  ClockReservationFromContextOutput,
  ContextLengthDiagnosticsOutput,
  ProviderResponseContextHelpersOutput,
  ProviderResponseToolCallSummary,
  RespInboundSseErrorDescriptor,
  ResponsesHostPolicyResult
} from './native-hub-pipeline-resp-semantics-types.js';

const NON_BLOCKING_PARSE_LOG_THROTTLE_MS = 60_000;
const nonBlockingParseLogState = new Map<string, number>();
const JSON_PARSE_FAILED = Symbol('native-hub-pipeline-resp-semantics.parse-failed');

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error ?? 'unknown');
  }
}

function logNativeRespSemanticsParserNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingParseLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_PARSE_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingParseLogState.set(stage, now);
  console.warn(
    `[native-hub-pipeline-resp-semantics-parsers] ${stage} parse failed (non-blocking): ${formatUnknownError(error)}`
  );
}

function parseJson(stage: string, raw: string): unknown | typeof JSON_PARSE_FAILED {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logNativeRespSemanticsParserNonBlocking(stage, error);
    return JSON_PARSE_FAILED;
  }
}

export function parseAliasMap(raw: string): Record<string, string> | undefined | null {
  const parsed = parseJson('parseAliasMap', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null) {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof key !== 'string' || typeof value !== 'string') {
      return null;
    }
    const trimmedKey = key.trim();
    const trimmedValue = value.trim();
    if (!trimmedKey || !trimmedValue) {
      return null;
    }
    out[trimmedKey] = trimmedValue;
  }
  return Object.keys(out).length ? out : undefined;
}

export function parseClientToolsRaw(raw: string): unknown[] | undefined | null {
  const parsed = parseJson('parseClientToolsRaw', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null) {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  return parsed;
}

export function parseRecord(raw: string, stage = 'parseRecord'): Record<string, unknown> | null {
  const parsed = parseJson(stage, raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

export function parseBoolean(raw: string): boolean | null {
  const parsed = parseJson('parseBoolean', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  return typeof parsed === 'boolean' ? parsed : null;
}

export function parseUnknown(raw: string): unknown | null {
  const parsed = parseJson('parseUnknown', raw);
  return parsed === JSON_PARSE_FAILED ? null : parsed;
}

export function parseStringOrUndefined(raw: string): string | undefined | null {
  const parsed = parseJson('parseStringOrUndefined', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null) {
    return undefined;
  }
  return typeof parsed === 'string' ? parsed : null;
}

export function parseContextLengthDiagnostics(raw: string): ContextLengthDiagnosticsOutput | null {
  const row = parseRecord(raw, 'parseContextLengthDiagnostics');
  if (!row) {
    return null;
  }
  const output: ContextLengthDiagnosticsOutput = {};
  const estimated = row.estimatedPromptTokens;
  const maxContext = row.maxContextTokens;
  if (typeof estimated === 'number' && Number.isFinite(estimated)) {
    output.estimatedPromptTokens = Math.floor(estimated);
  }
  if (typeof maxContext === 'number' && Number.isFinite(maxContext)) {
    output.maxContextTokens = Math.floor(maxContext);
  }
  return output;
}

export function parseRespInboundSseErrorDescriptor(raw: string): RespInboundSseErrorDescriptor | null {
  const row = parseRecord(raw, 'parseRespInboundSseErrorDescriptor');
  if (!row) {
    return null;
  }
  const code = row.code;
  const protocol = row.protocol;
  const errorMessage = row.errorMessage;
  const details = row.details;
  const stageRecord = row.stageRecord;
  const status = row.status;
  const providerType = row.providerType;
  if ((code !== 'SSE_DECODE_ERROR' && code !== 'HTTP_502') || typeof protocol !== 'string' || !protocol.trim()) {
    return null;
  }
  if (typeof errorMessage !== 'string' || !errorMessage.trim()) {
    return null;
  }
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return null;
  }
  if (!stageRecord || typeof stageRecord !== 'object' || Array.isArray(stageRecord)) {
    return null;
  }
  if (providerType != null && typeof providerType !== 'string') {
    return null;
  }
  if (status != null && (typeof status !== 'number' || !Number.isFinite(status))) {
    return null;
  }
  return {
    code,
    protocol: protocol.trim(),
    providerType: typeof providerType === 'string' && providerType.trim() ? providerType.trim() : undefined,
    errorMessage,
    details: details as Record<string, unknown>,
    stageRecord: stageRecord as Record<string, unknown>,
    status: typeof status === 'number' ? Math.floor(status) : undefined
  };
}

export function parseJsonObjectCandidate(raw: string): Record<string, unknown> | null | undefined {
  const parsed = parseJson('parseJsonObjectCandidate', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return undefined;
  }
  if (parsed === null) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

export function parseResponsesHostPolicyResult(raw: string): ResponsesHostPolicyResult | null {
  const row = parseRecord(raw, 'parseResponsesHostPolicyResult');
  if (!row || typeof row.shouldStripHostManagedFields !== 'boolean' || typeof row.targetProtocol !== 'string') {
    return null;
  }
  const targetProtocol = row.targetProtocol.trim();
  if (!targetProtocol.length) {
    return null;
  }
  return {
    shouldStripHostManagedFields: row.shouldStripHostManagedFields,
    targetProtocol
  };
}

export function parseAnthropicStopReasonResolution(raw: string): AnthropicStopReasonResolution | null {
  const row = parseRecord(raw, 'parseAnthropicStopReasonResolution');
  if (
    !row
    || typeof row.normalized !== 'string'
    || typeof row.finishReason !== 'string'
    || !row.finishReason.trim()
    || typeof row.isContextOverflow !== 'boolean'
  ) {
    return null;
  }
  return {
    normalized: row.normalized.trim().toLowerCase(),
    finishReason: row.finishReason.trim(),
    isContextOverflow: row.isContextOverflow
  };
}

export function parseAnthropicChatCompletionOutcome(raw: string): AnthropicChatCompletionOutcome | null {
  const row = parseRecord(raw, 'parseAnthropicChatCompletionOutcome');
  if (
    !row
    || typeof row.normalized !== 'string'
    || typeof row.finishReason !== 'string'
    || !row.finishReason.trim()
    || typeof row.isContextOverflow !== 'boolean'
    || typeof row.shouldFailEmptyContextOverflow !== 'boolean'
  ) {
    return null;
  }
  return {
    normalized: row.normalized.trim().toLowerCase(),
    finishReason: row.finishReason.trim(),
    isContextOverflow: row.isContextOverflow,
    shouldFailEmptyContextOverflow: row.shouldFailEmptyContextOverflow
  };
}

export function parseProviderResponseToolCallSummary(raw: string): ProviderResponseToolCallSummary | null {
  const row = parseRecord(raw, 'parseProviderResponseToolCallSummary');
  if (!row) {
    return null;
  }
  const out: ProviderResponseToolCallSummary = {};
  if ('toolCallCount' in row) {
    const count = row.toolCallCount;
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
      return null;
    }
    out.toolCallCount = Math.floor(count);
  }
  if ('toolNames' in row) {
    const names = row.toolNames;
    if (!Array.isArray(names)) {
      return null;
    }
    const normalized = names
      .filter((name) => typeof name === 'string')
      .map((name) => String(name).trim())
      .filter((name) => name.length > 0);
    out.toolNames = normalized.slice(0, 10);
  }
  return out;
}

export function parseProviderResponseContextHelpers(raw: string): ProviderResponseContextHelpersOutput | null {
  const row = parseRecord(raw, 'parseProviderResponseContextHelpers');
  if (!row || typeof row.isServerToolFollowup !== 'boolean' || typeof row.toolSurfaceShadowEnabled !== 'boolean') {
    return null;
  }
  if (
    row.clientProtocol !== 'openai-chat'
    && row.clientProtocol !== 'openai-responses'
    && row.clientProtocol !== 'anthropic-messages'
  ) {
    return null;
  }
  const output: ProviderResponseContextHelpersOutput = {
    isServerToolFollowup: row.isServerToolFollowup,
    toolSurfaceShadowEnabled: row.toolSurfaceShadowEnabled,
    clientProtocol: row.clientProtocol
  };
  if (typeof row.displayModel === 'string' && row.displayModel.trim()) {
    output.displayModel = row.displayModel.trim();
  }
  if (typeof row.clientFacingRequestId === 'string' && row.clientFacingRequestId.trim()) {
    output.clientFacingRequestId = row.clientFacingRequestId.trim();
  }
  return output;
}

export function parseClockReservationFromContext(
  raw: string
): ClockReservationFromContextOutput | undefined | null {
  const parsed = parseJson('parseClockReservationFromContext', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null) {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  if (typeof row.reservationId !== 'string' || !row.reservationId.trim()) {
    return null;
  }
  if (typeof row.sessionId !== 'string' || !row.sessionId.trim()) {
    return null;
  }
  if (!Array.isArray(row.taskIds)) {
    return null;
  }
  const taskIds = row.taskIds
    .filter((taskId) => typeof taskId === 'string')
    .map((taskId) => String(taskId).trim())
    .filter((taskId) => taskId.length > 0);
  if (taskIds.length === 0) {
    return null;
  }
  if (typeof row.reservedAtMs !== 'number' || !Number.isFinite(row.reservedAtMs)) {
    return null;
  }
  return {
    reservationId: row.reservationId.trim(),
    sessionId: row.sessionId.trim(),
    taskIds,
    reservedAtMs: Math.floor(row.reservedAtMs)
  };
}
