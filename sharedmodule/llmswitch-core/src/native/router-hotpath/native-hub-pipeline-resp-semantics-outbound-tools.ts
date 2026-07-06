import {
  failNative,
  extractNativeErrorMessage,
  isNativeDisabledByEnv,
  readNativeFunction,
  safeStringify
} from './native-hub-pipeline-resp-semantics-shared.js';
import { formatUnknownError } from '../../shared/common-utils.js';
import type { JsonObject } from '../../conversion/hub/types/json.js';

export interface AnthropicStopReasonResolution {
  normalized: string;
  finishReason: string;
  isContextOverflow: boolean;
}

export interface AnthropicChatCompletionOutcome extends AnthropicStopReasonResolution {
  shouldFailEmptyContextOverflow: boolean;
}

export interface ProviderResponseToolCallSummary {
  toolCallCount?: number;
  toolNames?: string[];
}

export interface ProviderResponseContextHelpersOutput {
  isServerToolFollowup: boolean;
  toolSurfaceShadowEnabled: boolean;
  clientProtocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages';
  displayModel?: string;
  clientFacingRequestId?: string;
}

export interface ResponsesHostPolicyResult {
  shouldStripHostManagedFields: boolean;
  targetProtocol: string;
}

export interface ResponsesClientSseProjectionState {
  pendingApplyPatchArgumentDeltas?: Record<string, string>;
  applyPatchCallIds?: string[];
  emittedApplyPatchDoneCallIds?: string[];
}

export interface ResponsesClientSseFrameProjection {
  emit: boolean;
  frame: string;
  state: ResponsesClientSseProjectionState;
}

const NON_BLOCKING_RESP_OUTBOUND_PARSE_LOG_THROTTLE_MS = 60_000;
const nonBlockingRespOutboundParseLogState = new Map<string, number>();
const JSON_PARSE_FAILED = Symbol('native-hub-pipeline-resp-semantics-outbound-tools.parse-failed');

function logNativeRespOutboundParserNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingRespOutboundParseLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_RESP_OUTBOUND_PARSE_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingRespOutboundParseLogState.set(stage, now);
  console.warn(
    `[native-hub-pipeline-resp-semantics-outbound-tools] ${stage} parse failed (non-blocking): ${formatUnknownError(error)}`
  );
}

function parseJson(stage: string, raw: string): unknown | typeof JSON_PARSE_FAILED {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logNativeRespOutboundParserNonBlocking(stage, error);
    return JSON_PARSE_FAILED;
  }
}

function parseRecord(raw: string, stage = 'parseRecord'): Record<string, unknown> | null {
  const parsed = parseJson(stage, raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function parseStringOrUndefined(raw: string): string | undefined | null {
  const parsed = parseJson('parseStringOrUndefined', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null) {
    return undefined;
  }
  return typeof parsed === 'string' ? parsed : null;
}

function parseJsonObjectCandidate(raw: string): Record<string, unknown> | null | undefined {
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

function parseResponsesHostPolicyResult(raw: string): ResponsesHostPolicyResult | null {
  const row = parseRecord(raw, 'parseResponsesHostPolicyResult');
  return row as unknown as ResponsesHostPolicyResult | null;
}

function parseResponsesClientSseFrameProjection(raw: string): ResponsesClientSseFrameProjection | null {
  const row = parseRecord(raw, 'parseResponsesClientSseFrameProjection');
  return row as unknown as ResponsesClientSseFrameProjection | null;
}

function parseAnthropicStopReasonResolution(raw: string): AnthropicStopReasonResolution | null {
  const row = parseRecord(raw, 'parseAnthropicStopReasonResolution');
  return row as unknown as AnthropicStopReasonResolution | null;
}

function parseAnthropicChatCompletionOutcome(raw: string): AnthropicChatCompletionOutcome | null {
  const row = parseRecord(raw, 'parseAnthropicChatCompletionOutcome');
  return row as unknown as AnthropicChatCompletionOutcome | null;
}

function parseProviderResponseToolCallSummary(raw: string): ProviderResponseToolCallSummary | null {
  const row = parseRecord(raw, 'parseProviderResponseToolCallSummary');
  return row as ProviderResponseToolCallSummary | null;
}

function parseProviderResponseContextHelpers(raw: string): ProviderResponseContextHelpersOutput | null {
  const row = parseRecord(raw, 'parseProviderResponseContextHelpers');
  return row as unknown as ProviderResponseContextHelpersOutput | null;
}

function callNativeRequired(capability: string, ...args: unknown[]): unknown {
  if (isNativeDisabledByEnv()) {
    return failNative<unknown>(capability, 'native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return failNative<unknown>(capability);
  }
  try {
    return fn(...args);
  } catch (error) {
    return failNative<unknown>(capability, extractNativeErrorMessage(error));
  }
}

function stringifyRegistryPayload(capability: string, value: unknown): string {
  const encoded = safeStringify(value);
  if (!encoded) {
    return failNative<string>(capability, 'json stringify failed');
  }
  return encoded;
}

function parseRegistryPayload<T>(capability: string, raw: unknown): T | undefined {
  if (raw === null || raw === undefined || raw === '') {
    return undefined;
  }
  if (typeof raw !== 'string') {
    return failNative<T>(capability, 'native returned non-string payload');
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    return failNative<T>(capability, `invalid native json: ${extractNativeErrorMessage(error)}`);
  }
}

export function registerResponsesPayloadSnapshotWithNative(
  id: unknown,
  snapshot: Record<string, unknown> | undefined,
  options?: { clone?: boolean },
): void {
  if (typeof id !== 'string') return;
  if (!snapshot || typeof snapshot !== 'object') return;
  const capability = 'registerResponsesPayloadSnapshotJson';
  callNativeRequired(capability, id, stringifyRegistryPayload(capability, snapshot), options?.clone ?? true);
}

export function consumeResponsesPayloadSnapshotWithNative(
  id: unknown,
): Record<string, unknown> | undefined {
  if (typeof id !== 'string') return undefined;
  const capability = 'consumeResponsesPayloadSnapshotJson';
  const result = callNativeRequired(capability, id);
  return parseRegistryPayload<Record<string, unknown>>(capability, result);
}

export function consumeResponsesPayloadSnapshotByAliasesWithNative(
  ids: unknown[],
): Record<string, unknown> | undefined {
  const capability = 'consumeResponsesPayloadSnapshotByAliasesJson';
  const result = callNativeRequired(capability, stringifyRegistryPayload(capability, ids));
  return parseRegistryPayload<Record<string, unknown>>(capability, result);
}

export function registerResponsesPassthroughWithNative(
  id: unknown,
  payload: Record<string, unknown> | undefined,
  options?: { clone?: boolean },
): void {
  if (typeof id !== 'string') return;
  if (!payload || typeof payload !== 'object') return;
  const capability = 'registerResponsesPassthroughJson';
  callNativeRequired(capability, id, stringifyRegistryPayload(capability, payload), options?.clone ?? true);
}

export function consumeResponsesPassthroughWithNative(
  id: unknown,
): Record<string, unknown> | undefined {
  if (typeof id !== 'string') return undefined;
  const capability = 'consumeResponsesPassthroughJson';
  const result = callNativeRequired(capability, id);
  return parseRegistryPayload<Record<string, unknown>>(capability, result);
}

export function consumeResponsesPassthroughByAliasesWithNative(
  ids: unknown[],
): Record<string, unknown> | undefined {
  const capability = 'consumeResponsesPassthroughByAliasesJson';
  const result = callNativeRequired(capability, stringifyRegistryPayload(capability, ids));
  return parseRegistryPayload<Record<string, unknown>>(capability, result);
}

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
    return fail(extractNativeErrorMessage(error));
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
  legacyFollowupMarkerRaw: unknown;
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
  const followupRawJson = safeStringify(input.legacyFollowupMarkerRaw ?? null);
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

export function projectResponsesClientBodyForClientWithNative(
  responsesPayload: unknown,
  toolsRaw: unknown[]
): Record<string, unknown> {
  const capability = 'projectResponsesClientBodyForClientJson';
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
    const parsed = parseRecord(raw, 'parseProjectResponsesClientBodyForClient');
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function projectResponsesClientPayloadForClientWithNative(
  responsesPayload: unknown,
  toolsRaw: unknown[],
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> {
  const capability = 'projectResponsesClientPayloadForClientJson';
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
  const metadataJson = safeStringify(metadata ?? {});
  const contextJson = safeStringify(null);
  if (!payloadJson || !toolsRawJson || !metadataJson || !contextJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson, toolsRawJson, metadataJson, contextJson);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      return fail(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw, 'parseProjectResponsesClientPayloadForClient');
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function projectResponsesSseFrameForClientWithNative(input: {
  frame: string;
  eventName?: string;
  data: Record<string, unknown>;
  toolsRaw: unknown[];
  metadata?: Record<string, unknown>;
  state: ResponsesClientSseProjectionState;
}): ResponsesClientSseFrameProjection {
  const capability = 'projectResponsesSseFrameForClientJson';
  const fail = (reason?: string) => failNative<ResponsesClientSseFrameProjection>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const frameJson = safeStringify(input.frame);
  const eventNameJson = safeStringify(input.eventName ?? null);
  const dataJson = safeStringify(input.data);
  const toolsRawJson = safeStringify(input.toolsRaw ?? []);
  const metadataJson = safeStringify(input.metadata ?? {});
  const stateJson = safeStringify(input.state ?? {});
  if (!frameJson || !eventNameJson || !dataJson || !toolsRawJson || !metadataJson || !stateJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(frameJson, eventNameJson, dataJson, toolsRawJson, metadataJson, stateJson);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      return fail(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseResponsesClientSseFrameProjection(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function projectSseErrorEventPayloadWithNative(input: {
  requestId: string;
  status: number;
  message: string;
  code: string;
  error?: Record<string, unknown>;
}): Record<string, unknown> {
  const capability = 'projectSseErrorEventPayloadJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify({
    requestId: input.requestId,
    status: Number.isFinite(input.status) ? Math.floor(input.status) : input.status,
    message: input.message,
    code: input.code,
    error: input.error
  });
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      return fail(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    const error = parsed?.error;
    if (
      !parsed
      || parsed.type !== 'error'
      || typeof parsed.status !== 'number'
      || !error
      || typeof error !== 'object'
      || Array.isArray(error)
      || typeof (error as Record<string, unknown>).message !== 'string'
      || typeof (error as Record<string, unknown>).code !== 'string'
      || typeof (error as Record<string, unknown>).request_id !== 'string'
    ) {
      return fail('invalid payload');
    }
    return parsed;
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

export function normalizeChatUsageWithNative(
  usageRaw: unknown
): unknown {
  const capability = 'normalizeChatUsageJson';
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
    const payloadRecord =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : undefined;
    const sourceModel =
      payloadRecord && typeof payloadRecord.model === 'string' && payloadRecord.model.trim().length
        ? payloadRecord.model.trim()
        : undefined;
    if (parsed && sourceModel) {
      parsed.model = sourceModel;
    }
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planResponsesPayloadFromChatCloseoutWithNative(
  payload: unknown,
  context: Record<string, unknown> = {}
): Record<string, unknown> {
  const capability = 'planResponsesPayloadFromChatCloseoutJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload);
  const contextJson = safeStringify(context);
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
    return parseRecord(raw) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function projectPostServertoolHubRespOutbound04ClientSemanticWithNative(input: {
  payload: unknown;
  entryEndpoint?: string;
  requestId?: string;
  responseSemantics?: Record<string, unknown>;
}): JsonObject {
  const capability = 'projectPostServertoolHubRespOutbound04ClientSemanticJson';
  const fail = (reason?: string) => failNative<JsonObject>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(input.payload);
  const entryEndpointJson = safeStringify(typeof input.entryEndpoint === 'string' ? input.entryEndpoint : null);
  const requestIdJson = safeStringify(typeof input.requestId === 'string' ? input.requestId : null);
  const responseSemanticsJson = safeStringify(input.responseSemantics ?? {});
  if (!payloadJson || !entryEndpointJson || !requestIdJson || !responseSemanticsJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson, entryEndpointJson, requestIdJson, responseSemanticsJson);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      return fail(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return (parseRecord(raw) as JsonObject | null | undefined) ?? fail('invalid payload');
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

export interface BuildAnthropicFullInput {
  chat_response: string;
  alias_map?: string;
}

export interface BuildOpenAIChatFromAnthropicMessageFullInput {
  payload: string;
}

export function buildOpenAIChatFromAnthropicMessageFullWithNative(
  input: BuildOpenAIChatFromAnthropicMessageFullInput
): string {
  const capability = 'buildOpenaiChatFromAnthropicMessageFullJson';
  const fail = (reason?: string) => failNative<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const inputJson = JSON.stringify(input);
    const raw = fn(inputJson);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      return fail(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return raw as string;
  } catch (error) {
    return fail(extractNativeErrorMessage(error));
  }
}

export function buildAnthropicResponseFromChatFullWithNative(input: BuildAnthropicFullInput): string {
  const capability = 'buildAnthropicResponseFromChatFullJson';
  const fail = (reason?: string) => failNative<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const inputJson = JSON.stringify(input);
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return raw as string;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
