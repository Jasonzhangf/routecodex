import {
  failNative,
  extractNativeErrorMessage,
  formatUnknownError,
  isNativeDisabledByEnv,
  readNativeFunction,
  safeStringify
} from './native-hub-pipeline-resp-semantics-shared.js';

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
const JSON_PARSE_FAILED = Symbol('native-hub-pipeline-resp-semantics-inbound-tools.parse-failed');

function logNativeRespInboundParserNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingRespInboundParseLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_RESP_INBOUND_PARSE_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingRespInboundParseLogState.set(stage, now);
  console.warn(
    `[native-hub-pipeline-resp-semantics-inbound-tools] ${stage} parse failed (non-blocking): ${formatUnknownError(error)}`
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
