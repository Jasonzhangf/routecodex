import {
  failNative,
  extractNativeErrorMessage,
  formatUnknownError,
  isNativeDisabledByEnv,
  readNativeFunction,
  safeStringify
} from './native-router-hotpath-loader.js';

export interface NativeRespInboundReasoningNormalizeInput {
  payload: Record<string, unknown>;
  protocol: string;
}

export interface ContextLengthDiagnosticsOutput {
  estimatedPromptTokens?: number;
  maxContextTokens?: number;
}

export interface RespInboundSseErrorDescriptor {
  code: 'SSE_DECODE_ERROR' | 'HTTP_502';
  protocol: string;
  providerType?: string;
  errorMessage: string;
  details: Record<string, unknown>;
  stageRecord: Record<string, unknown>;
  status?: number;
}

export interface ProviderSseStreamReadErrorDescriptor {
  message: string;
  code: 'SSE_DECODE_ERROR';
  upstreamCode: string;
  statusCode: number;
  retryable: boolean;
  requestExecutorProviderErrorStage: 'provider.sse_decode';
}

const NON_BLOCKING_RESP_INBOUND_PARSE_LOG_THROTTLE_MS = 60_000;
const nonBlockingRespInboundParseLogState = new Map<string, number>();
const JSON_PARSE_FAILED = Symbol('native-hub-pipeline-resp-semantics-test-helper.parse-failed');

function logNativeRespInboundParserNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingRespInboundParseLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_RESP_INBOUND_PARSE_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingRespInboundParseLogState.set(stage, now);
  console.warn(
    `[native-hub-pipeline-resp-semantics-test-helper] ${stage} parse failed (non-blocking): ${formatUnknownError(error)}`
  );
}

function parseJson(stage: string, raw: string): unknown | typeof JSON_PARSE_FAILED {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logNativeRespInboundParserNonBlocking(stage, error);
    return JSON_PARSE_FAILED;
  }
}

function parseAliasMap(raw: string): Record<string, string> | undefined | null {
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
  return parsed as Record<string, string>;
}

function parseClientToolsRaw(raw: string): unknown[] | undefined | null {
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

function parseRecord(raw: string, stage = 'parseRecord'): Record<string, unknown> | null {
  const parsed = parseJson(stage, raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function parseBoolean(raw: string): boolean | null {
  const parsed = parseJson('parseBoolean', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  return typeof parsed === 'boolean' ? parsed : null;
}

function parseUnknown(raw: string): unknown | null {
  const parsed = parseJson('parseUnknown', raw);
  return parsed === JSON_PARSE_FAILED ? null : parsed;
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

function parseContextLengthDiagnostics(raw: string): ContextLengthDiagnosticsOutput | null {
  const row = parseRecord(raw, 'parseContextLengthDiagnostics');
  return row as ContextLengthDiagnosticsOutput | null;
}

function parseRespInboundSseErrorDescriptor(raw: string): RespInboundSseErrorDescriptor | null {
  const row = parseRecord(raw, 'parseRespInboundSseErrorDescriptor');
  return row as unknown as RespInboundSseErrorDescriptor | null;
}

function parseProviderSseStreamReadErrorDescriptor(raw: string): ProviderSseStreamReadErrorDescriptor | null {
  const row = parseRecord(raw, 'parseProviderSseStreamReadErrorDescriptor');
  return row as unknown as ProviderSseStreamReadErrorDescriptor | null;
}

function parseRespFormatEnvelopeResult(raw: string): Record<string, unknown> | null {
  return parseRecord(raw, 'parseRespFormatEnvelopeResult');
}

// feature_id: sse.responses_decode_projection
// Rust canonical builder: build_responses_json_from_sse_json
export function buildResponsesJsonFromSseJsonWithNative(input: {
  bodyText: string;
}): Record<string, unknown> {
  const capability = 'buildResponsesJsonFromSseJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? { bodyText: '' });
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const envelope = parsed;
    if (!envelope || typeof envelope !== 'object') {
      return fail('missing envelope');
    }
    const payload = envelope.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') {
      return fail('missing payload');
    }
    return payload;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}


export function buildOpenAIChatResponseFromAnthropicMessageWithNative(
  payload: Record<string, unknown>,
  requestId?: string
): Record<string, unknown> {
  const capability = 'buildOpenaiChatResponseFromAnthropicMessageJson';
  const fail = (reason?: string): Record<string, unknown> => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload ?? {});
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson, typeof requestId === 'string' ? requestId : undefined);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeMessageReasoningPayloadWithNative(candidate: unknown): Record<string, unknown> | undefined {
  const capability = 'normalizeMessageReasoningPayloadJson';
  const fail = (reason?: string) => failNative<Record<string, unknown> | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const candidateJson = safeStringify(candidate ?? null);
  if (!candidateJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(candidateJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw, 'normalizeMessageReasoningPayloadWithNative');
    return parsed ?? undefined;
  } catch (error) {
    return fail(extractNativeErrorMessage(error));
  }
}

export function applyReasoningPayloadToMessageWithNative(
  message: Record<string, unknown>,
  reasoning: unknown
): Record<string, unknown> {
  const capability = 'applyReasoningPayloadToMessageJson';
  const fail = (reason?: string): Record<string, unknown> => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const messageJson = safeStringify(message ?? {});
  const reasoningJson = safeStringify(reasoning ?? null);
  if (!messageJson || !reasoningJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(messageJson, reasoningJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseRecord(raw, 'applyReasoningPayloadToMessageWithNative') ?? fail('invalid payload');
  } catch (error) {
    return fail(extractNativeErrorMessage(error));
  }
}

export function resolveAnthropicToolNameWithNative(rawName: string, aliasMap?: Record<string, string>): string {
  const capability = 'resolveAnthropicToolNameJson';
  const fail = (reason?: string): string => failNative<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const aliasMapJson = safeStringify(aliasMap ?? null);
  if (!aliasMapJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(rawName, aliasMapJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseStringOrUndefined(raw);
    return typeof parsed === 'string' ? parsed : fail('invalid payload');
  } catch (error) {
    return fail(extractNativeErrorMessage(error));
  }
}

export function normalizeAliasMapWithNative(
  candidate: unknown
): Record<string, string> | undefined {
  const capability = 'normalizeAliasMapJson';
  const fail = (reason?: string) => failNative<Record<string, string> | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('normalizeAliasMapJson');
  if (!fn) {
    return fail();
  }
  const candidateJson = safeStringify(candidate ?? null);
  if (!candidateJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(candidateJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseAliasMap(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveClientToolsRawWithNative(
  candidate: unknown
): unknown[] | undefined {
  const capability = 'resolveClientToolsRawJson';
  const fail = (reason?: string) => failNative<unknown[] | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('resolveClientToolsRawJson');
  if (!fn) {
    return fail();
  }
  const candidateJson = safeStringify(candidate ?? null);
  if (!candidateJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(candidateJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseClientToolsRaw(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveAliasMapFromRespSemanticsWithNative(
  semantics: unknown
): Record<string, string> | undefined {
  const capability = 'resolveAliasMapFromRespSemanticsJson';
  const fail = (reason?: string) => failNative<Record<string, string> | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('resolveAliasMapFromRespSemanticsJson');
  if (!fn) {
    return fail();
  }
  const semanticsJson = safeStringify(semantics ?? null);
  if (!semanticsJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(semanticsJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseAliasMap(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveAliasMapFromSourcesWithNative(
  adapterContext: unknown,
  chatEnvelope: unknown
): Record<string, string> | undefined {
  const capability = 'resolveAliasMapFromSourcesJson';
  const fail = (reason?: string) => failNative<Record<string, string> | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('resolveAliasMapFromSourcesJson');
  if (!fn) {
    return fail();
  }
  const adapterContextJson = safeStringify(adapterContext ?? null);
  const chatEnvelopeJson = safeStringify(chatEnvelope ?? null);
  if (!adapterContextJson || !chatEnvelopeJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(adapterContextJson, chatEnvelopeJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseAliasMap(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveClientToolsRawFromRespSemanticsWithNative(
  semantics: unknown
): unknown[] | undefined {
  const capability = 'resolveClientToolsRawFromRespSemanticsJson';
  const fail = (reason?: string) => failNative<unknown[] | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('resolveClientToolsRawFromRespSemanticsJson');
  if (!fn) {
    return fail();
  }
  const semanticsJson = safeStringify(semantics ?? null);
  if (!semanticsJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(semanticsJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseClientToolsRaw(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function sanitizeResponsesFunctionNameWithNative(
  rawName: unknown
): string | undefined {
  const capability = 'sanitizeResponsesFunctionNameJson';
  const fail = (reason?: string) => failNative<string | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const rawNameJson = safeStringify(rawName ?? null);
  if (!rawNameJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(rawNameJson);
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

export function extractSseWrapperErrorWithNative(
  payload: unknown
): string | undefined {
  const capability = 'extractSseWrapperErrorJson';
  const fail = (reason?: string) => failNative<string | undefined>(capability, reason);
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
    const parsed = parseStringOrUndefined(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function extractContextLengthDiagnosticsWithNative(
  adapterContext: unknown
): ContextLengthDiagnosticsOutput {
  const capability = 'extractContextLengthDiagnosticsJson';
  const fail = (reason?: string) => failNative<ContextLengthDiagnosticsOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const contextJson = safeStringify(adapterContext ?? null);
  if (!contextJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(contextJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseContextLengthDiagnostics(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function isContextLengthExceededSignalWithNative(
  code: unknown,
  message: string,
  context: Record<string, unknown> | undefined
): boolean {
  const capability = 'isContextLengthExceededSignalJson';
  const fail = (reason?: string) => failNative<boolean>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const contextJson = safeStringify(context ?? null);
  if (!contextJson) {
    return fail('json stringify failed');
  }
  const normalizedCode = typeof code === 'string' ? code : '';
  try {
    const raw = fn(normalizedCode, String(message || ''), contextJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseBoolean(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildRespInboundSseErrorDescriptorWithNative(input: unknown): RespInboundSseErrorDescriptor {
  const capability = 'buildRespInboundSseErrorDescriptorJson';
  const fail = (reason?: string) => failNative<RespInboundSseErrorDescriptor>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? null);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRespInboundSseErrorDescriptor(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function parseRespFormatEnvelopeWithNative(input: {
  payload: unknown;
  protocol: string;
}): Record<string, unknown> {
  const capability = 'parseRespFormatEnvelopeJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? null);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseRespFormatEnvelopeResult(raw) ?? fail('invalid payload');
  } catch (error) {
    return fail(extractNativeErrorMessage(error));
  }
}

export function materializeProviderResponseSsePayloadWithNative(
  input: { payload: unknown; streamBodyText?: string }
): Record<string, unknown> {
  // canonical_builder: materialize_provider_response_sse_payload
  const capability = 'materializeProviderResponseSsePayloadJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? { payload: null });
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseRecord(raw, 'materializeProviderResponseSsePayloadWithNative') ?? fail('invalid payload');
  } catch (error) {
    return fail(extractNativeErrorMessage(error));
  }
}

export function buildProviderSseStreamReadErrorDescriptorWithNative(
  input: { message?: string; code?: string; upstreamCode?: string }
): ProviderSseStreamReadErrorDescriptor {
  // canonical_builder: build_provider_sse_stream_read_error_descriptor
  const capability = 'buildProviderSseStreamReadErrorDescriptorJson';
  const fail = (reason?: string) => failNative<ProviderSseStreamReadErrorDescriptor>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? {});
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseProviderSseStreamReadErrorDescriptor(raw) ?? fail('invalid payload');
  } catch (error) {
    return fail(extractNativeErrorMessage(error));
  }
}

export function normalizeRespInboundReasoningPayloadWithNative(
  input: NativeRespInboundReasoningNormalizeInput
): Record<string, unknown> {
  const capability = 'normalizeRespInboundReasoningPayloadJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseUnknown(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildAnthropicResponseFromChatWithNative(
  chatResponse: unknown,
  aliasMap?: Record<string, string>
): Record<string, unknown> {
  const capability = 'buildAnthropicResponseFromChatJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const chatResponseJson = safeStringify(chatResponse);
  const aliasMapJson = safeStringify(aliasMap ?? null);
  if (!chatResponseJson || !aliasMapJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(chatResponseJson, aliasMapJson);
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

type JsonObject = Record<string, unknown>;

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
const RESP_OUTBOUND_JSON_PARSE_FAILED = Symbol('native-hub-pipeline-resp-semantics-test-helper.outbound-parse-failed');

function logNativeRespOutboundParserNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingRespOutboundParseLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_RESP_OUTBOUND_PARSE_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingRespOutboundParseLogState.set(stage, now);
  console.warn(
    `[native-hub-pipeline-resp-semantics-test-helper] ${stage} parse failed (non-blocking): ${formatUnknownError(error)}`
  );
}

function parseOutboundJson(stage: string, raw: string): unknown | typeof RESP_OUTBOUND_JSON_PARSE_FAILED {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logNativeRespOutboundParserNonBlocking(stage, error);
    return RESP_OUTBOUND_JSON_PARSE_FAILED;
  }
}

function parseOutboundRecord(raw: string, stage = 'parseRecord'): Record<string, unknown> | null {
  const parsed = parseOutboundJson(stage, raw);
  if (parsed === RESP_OUTBOUND_JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function parseOutboundStringOrUndefined(raw: string): string | undefined | null {
  const parsed = parseOutboundJson('parseStringOrUndefined', raw);
  if (parsed === RESP_OUTBOUND_JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null) {
    return undefined;
  }
  return typeof parsed === 'string' ? parsed : null;
}

function parseOutboundJsonObjectCandidate(raw: string): Record<string, unknown> | null | undefined {
  const parsed = parseOutboundJson('parseJsonObjectCandidate', raw);
  if (parsed === RESP_OUTBOUND_JSON_PARSE_FAILED) {
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
  const row = parseOutboundRecord(raw, 'parseResponsesHostPolicyResult');
  return row as unknown as ResponsesHostPolicyResult | null;
}

function parseResponsesClientSseFrameProjection(raw: string): ResponsesClientSseFrameProjection | null {
  const row = parseOutboundRecord(raw, 'parseResponsesClientSseFrameProjection');
  return row as unknown as ResponsesClientSseFrameProjection | null;
}

function parseAnthropicStopReasonResolution(raw: string): AnthropicStopReasonResolution | null {
  const row = parseOutboundRecord(raw, 'parseAnthropicStopReasonResolution');
  return row as unknown as AnthropicStopReasonResolution | null;
}

function parseAnthropicChatCompletionOutcome(raw: string): AnthropicChatCompletionOutcome | null {
  const row = parseOutboundRecord(raw, 'parseAnthropicChatCompletionOutcome');
  return row as unknown as AnthropicChatCompletionOutcome | null;
}

function parseProviderResponseToolCallSummary(raw: string): ProviderResponseToolCallSummary | null {
  const row = parseOutboundRecord(raw, 'parseProviderResponseToolCallSummary');
  return row as ProviderResponseToolCallSummary | null;
}

function parseProviderResponseContextHelpers(raw: string): ProviderResponseContextHelpersOutput | null {
  const row = parseOutboundRecord(raw, 'parseProviderResponseContextHelpers');
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
    const parsed = parseOutboundStringOrUndefined(raw);
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
    const parsed = parseOutboundRecord(raw);
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
    const parsed = parseOutboundRecord(raw, 'parseProjectResponsesClientBodyForClient');
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function projectResponsesClientPayloadForClientWithNative(
  responsesPayload: unknown,
  toolsRaw: unknown[],
  metadata: Record<string, unknown> | undefined,
  context?: Record<string, unknown> | undefined
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
  const contextJson = safeStringify(context ?? null);
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
    const parsed = parseOutboundRecord(raw, 'parseProjectResponsesClientPayloadForClient');
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planResponsesJsonClientDispatchWithNative(input: unknown): Record<string, unknown> {
  const capability = 'planResponsesJsonClientDispatchJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? null);
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
    const parsed = parseOutboundRecord(raw, 'parsePlanResponsesJsonClientDispatch');
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

export function updateResponsesContractProbeFromSseChunkWithNative(
  chunk: unknown,
  probe: Record<string, unknown> | undefined
): Record<string, unknown> {
  const capability = 'updateResponsesContractProbeFromSseChunkJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const chunkJson = safeStringify(typeof chunk === 'string' ? chunk : String(chunk ?? ''));
  const probeJson = safeStringify(probe ?? {});
  if (!chunkJson || !probeJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(chunkJson, probeJson);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      return fail(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function updateResponsesSseTransportTerminalStateWithNative(input: {
  chunk: unknown;
  state: Record<string, unknown> | undefined;
  flushRemainder?: boolean;
}): { state: Record<string, unknown>; observedTerminal: boolean } {
  const capability = 'updateResponsesSseTransportTerminalStateJson';
  const fail = (reason?: string) => failNative<{ state: Record<string, unknown>; observedTerminal: boolean }>(
    capability,
    reason
  );
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const chunkJson = safeStringify(typeof input.chunk === 'string' ? input.chunk : String(input.chunk ?? ''));
  const stateJson = safeStringify(input.state ?? {});
  if (!chunkJson || !stateJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(chunkJson, stateJson, input.flushRemainder === true);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      return fail(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    const state = (parsed as { state?: unknown }).state;
    const sawTerminalEvent = (parsed as { sawTerminalEvent?: unknown }).sawTerminalEvent;
    if (!state || typeof state !== 'object' || Array.isArray(state) || typeof sawTerminalEvent !== 'boolean') {
      return fail('invalid shape');
    }
    return {
      state: state as Record<string, unknown>,
      observedTerminal: sawTerminalEvent
    };
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
    const parsed = parseOutboundRecord(raw);
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
    const parsed = parseOutboundRecord(raw);
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
    return parseOutboundRecord(raw) ?? fail('invalid payload');
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
    const parsed = parseOutboundJsonObjectCandidate(raw);
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
