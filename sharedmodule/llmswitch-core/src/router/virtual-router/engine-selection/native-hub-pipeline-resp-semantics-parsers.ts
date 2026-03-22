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

export function parseAliasMap(raw: string): Record<string, string> | undefined | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
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
  } catch {
    return null;
  }
}

export function parseClientToolsRaw(raw: string): unknown[] | undefined | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) {
      return undefined;
    }
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function parseRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseBoolean(raw: string): boolean | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'boolean' ? parsed : null;
  } catch {
    return null;
  }
}

export function parseUnknown(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function parseStringOrUndefined(raw: string): string | undefined | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) {
      return undefined;
    }
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function parseContextLengthDiagnostics(raw: string): ContextLengthDiagnosticsOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
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
  } catch {
    return null;
  }
}

export function parseRespInboundSseErrorDescriptor(raw: string): RespInboundSseErrorDescriptor | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
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
  } catch {
    return null;
  }
}

export function parseJsonObjectCandidate(raw: string): Record<string, unknown> | null | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function parseResponsesHostPolicyResult(raw: string): ResponsesHostPolicyResult | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    if (typeof row.shouldStripHostManagedFields !== 'boolean') {
      return null;
    }
    if (typeof row.targetProtocol !== 'string') {
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
  } catch {
    return null;
  }
}

export function parseAnthropicStopReasonResolution(raw: string): AnthropicStopReasonResolution | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    if (typeof row.normalized !== 'string') {
      return null;
    }
    if (typeof row.finishReason !== 'string' || !row.finishReason.trim()) {
      return null;
    }
    if (typeof row.isContextOverflow !== 'boolean') {
      return null;
    }
    return {
      normalized: row.normalized.trim().toLowerCase(),
      finishReason: row.finishReason.trim(),
      isContextOverflow: row.isContextOverflow
    };
  } catch {
    return null;
  }
}

export function parseAnthropicChatCompletionOutcome(raw: string): AnthropicChatCompletionOutcome | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    if (typeof row.normalized !== 'string') {
      return null;
    }
    if (typeof row.finishReason !== 'string' || !row.finishReason.trim()) {
      return null;
    }
    if (typeof row.isContextOverflow !== 'boolean') {
      return null;
    }
    if (typeof row.shouldFailEmptyContextOverflow !== 'boolean') {
      return null;
    }
    return {
      normalized: row.normalized.trim().toLowerCase(),
      finishReason: row.finishReason.trim(),
      isContextOverflow: row.isContextOverflow,
      shouldFailEmptyContextOverflow: row.shouldFailEmptyContextOverflow
    };
  } catch {
    return null;
  }
}

export function parseProviderResponseToolCallSummary(raw: string): ProviderResponseToolCallSummary | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
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
  } catch {
    return null;
  }
}

export function parseProviderResponseContextHelpers(raw: string): ProviderResponseContextHelpersOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    if (typeof row.isServerToolFollowup !== 'boolean') {
      return null;
    }
    if (typeof row.toolSurfaceShadowEnabled !== 'boolean') {
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
  } catch {
    return null;
  }
}

export function parseClockReservationFromContext(
  raw: string
): ClockReservationFromContextOutput | undefined | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
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
  } catch {
    return null;
  }
}
