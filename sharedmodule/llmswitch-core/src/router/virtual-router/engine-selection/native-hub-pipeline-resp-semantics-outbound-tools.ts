import {
  parseAnthropicChatCompletionOutcome,
  parseAnthropicStopReasonResolution,
  parseClockReservationFromContext,
  parseJsonObjectCandidate,
  parseProviderResponseContextHelpers,
  parseProviderResponseToolCallSummary,
  parseRecord,
  parseResponsesHostPolicyResult,
  parseStringOrUndefined
} from './native-hub-pipeline-resp-semantics-parsers.js';
import {
  failNative,
  extractNativeErrorMessage,
  isNativeDisabledByEnv,
  readNativeFunction,
  safeStringify
} from './native-hub-pipeline-resp-semantics-shared.js';
import type {
  AnthropicChatCompletionOutcome,
  AnthropicStopReasonResolution,
  ClockReservationFromContextOutput,
  ProviderResponseContextHelpersOutput,
  ProviderResponseToolCallSummary,
  ResponsesHostPolicyResult
} from './native-hub-pipeline-resp-semantics-types.js';

export function resolveAnthropicStopReasonWithNative(
  stopReason: string | undefined
): AnthropicStopReasonResolution {
  const capability = 'resolveAnthropicStopReasonJson';
  const fail = (reason?: string): AnthropicStopReasonResolution => failNative<AnthropicStopReasonResolution>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const stopReasonJson = safeStringify(typeof stopReason === 'string' ? stopReason : null);
  if (!stopReasonJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(stopReasonJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseAnthropicStopReasonResolution(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveAnthropicChatCompletionOutcomeWithNative(options: {
  stopReason: string | undefined;
  toolCallCount: number;
  hasVisibleAssistantOutput: boolean;
}): AnthropicChatCompletionOutcome {
  const capability = 'resolveAnthropicChatCompletionOutcomeJson';
  const fail = (reason?: string): AnthropicChatCompletionOutcome =>
    failNative<AnthropicChatCompletionOutcome>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const stopReasonJson = safeStringify(typeof options.stopReason === 'string' ? options.stopReason : null);
  if (!stopReasonJson) {
    return fail('json stringify failed');
  }
  const toolCallCount = Number.isFinite(options.toolCallCount)
    ? Math.max(0, Math.floor(options.toolCallCount))
    : 0;
  try {
    const raw = fn(stopReasonJson, toolCallCount, Boolean(options.hasVisibleAssistantOutput));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseAnthropicChatCompletionOutcome(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function summarizeToolCallsFromProviderResponseWithNative(
  payload: unknown
): ProviderResponseToolCallSummary {
  const capability = 'summarizeToolCallsFromProviderResponseJson';
  const fail = (reason?: string): ProviderResponseToolCallSummary =>
    failNative<ProviderResponseToolCallSummary>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseProviderResponseToolCallSummary(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveProviderTypeFromProtocolWithNative(
  protocol: string | undefined
): string | undefined {
  const capability = 'resolveProviderTypeFromProtocolJson';
  const fail = (reason?: string): string | undefined => failNative<string | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const protocolJson = safeStringify(typeof protocol === 'string' ? protocol : null);
  if (!protocolJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(protocolJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseStringOrUndefined(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveProviderResponseContextHelpersWithNative(input: {
  context: unknown;
  serverToolFollowupRaw: unknown;
  entryEndpoint: string | undefined;
  toolSurfaceModeRaw: string | undefined;
}): ProviderResponseContextHelpersOutput {
  const capability = 'resolveProviderResponseContextHelpersJson';
  const fail = (reason?: string): ProviderResponseContextHelpersOutput =>
    failNative<ProviderResponseContextHelpersOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const contextJson = safeStringify(input.context ?? {});
  if (!contextJson) {
    return fail('context json stringify failed');
  }
  const followupRawJson = safeStringify(input.serverToolFollowupRaw ?? null);
  if (!followupRawJson) {
    return fail('followup json stringify failed');
  }
  const entryEndpointJson = safeStringify(typeof input.entryEndpoint === 'string' ? input.entryEndpoint : null);
  if (!entryEndpointJson) {
    return fail('entryEndpoint json stringify failed');
  }
  const toolSurfaceModeRawJson = safeStringify(input.toolSurfaceModeRaw ?? null);
  if (!toolSurfaceModeRawJson) {
    return fail('toolSurface json stringify failed');
  }
  try {
    const raw = fn(contextJson, followupRawJson, entryEndpointJson, toolSurfaceModeRawJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseProviderResponseContextHelpers(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveClockReservationFromContextWithNative(
  context: unknown
): ClockReservationFromContextOutput | undefined {
  const capability = 'resolveClockReservationFromContextJson';
  const fail = (reason?: string): ClockReservationFromContextOutput | undefined =>
    failNative<ClockReservationFromContextOutput | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const contextJson = safeStringify(context ?? {});
  if (!contextJson) {
    return fail('context json stringify failed');
  }
  try {
    const raw = fn(contextJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseClockReservationFromContext(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeResponsesToolCallArgumentsForClientWithNative(
  responsesPayload: unknown,
  toolsRaw: unknown[]
): Record<string, unknown> {
  const capability = 'normalizeResponsesToolCallArgumentsForClientJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(responsesPayload);
  const toolsRawJson = safeStringify(toolsRaw ?? []);
  if (!payloadJson || !toolsRawJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson, toolsRawJson);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      return fail(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeResponsesUsageWithNative(
  usageRaw: unknown
): unknown {
  const capability = 'normalizeResponsesUsageJson';
  const fail = (reason?: string) => failNative<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const usageJson = safeStringify(usageRaw ?? null);
  if (!usageJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(usageJson);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      return fail(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    try {
      return JSON.parse(raw);
    } catch {
      return fail('invalid payload');
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildResponsesPayloadFromChatWithNative(
  payload: unknown,
  context: {
    requestId?: string;
    toolsRaw?: unknown[];
    metadata?: Record<string, unknown>;
    responseSemantics?: Record<string, unknown>;
    parallelToolCalls?: unknown;
    toolChoice?: unknown;
    include?: unknown;
    store?: unknown;
    stripHostManagedFields?: boolean;
    sourceForRetention?: Record<string, unknown>;
  } = {}
): Record<string, unknown> {
  const capability = 'buildResponsesPayloadFromChatJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload);
  const contextJson = safeStringify({
    requestId: context.requestId,
    toolsRaw: Array.isArray(context.toolsRaw) ? context.toolsRaw : [],
    metadata: context.metadata,
    responseSemantics: context.responseSemantics,
    parallelToolCalls: context.parallelToolCalls,
    toolChoice: context.toolChoice,
    include: context.include,
    store: context.store,
    stripHostManagedFields: context.stripHostManagedFields,
    sourceForRetention: context.sourceForRetention
  });
  if (!payloadJson || !contextJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson, contextJson);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      return fail(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function looksLikeJsonStreamPrefixWithNative(
  firstChunkText: string
): boolean {
  const capability = 'looksLikeJsonStreamPrefixJson';
  const fail = (reason?: string) => failNative<boolean>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('looksLikeJsonStreamPrefixJson');
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(String(firstChunkText || ''));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'boolean' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function parseJsonObjectCandidateWithNative(
  rawText: string,
  maxBytes: number
): Record<string, unknown> | null {
  const capability = 'parseJsonObjectCandidateJson';
  const fail = (reason?: string) => failNative<Record<string, unknown> | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('parseJsonObjectCandidateJson');
  if (!fn) {
    return fail();
  }
  const bounded = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0;
  try {
    const raw = fn(String(rawText || ''), bounded);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJsonObjectCandidate(raw);
    return parsed === undefined ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function evaluateResponsesHostPolicyWithNative(
  context: unknown,
  targetProtocol?: string
): ResponsesHostPolicyResult {
  const capability = 'evaluateResponsesHostPolicyJson';
  const fail = (reason?: string) => failNative<ResponsesHostPolicyResult>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    context: context && typeof context === 'object' && !Array.isArray(context) ? context : undefined,
    targetProtocol
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseResponsesHostPolicyResult(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
