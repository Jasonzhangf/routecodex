import {
  parseAliasMap,
  parseBoolean,
  parseClientToolsRaw,
  parseContextLengthDiagnostics,
  parseProviderSseStreamReadErrorDescriptor,
  parseRespFormatEnvelopeResult,
  parseRecord,
  parseRespInboundSseErrorDescriptor,
  parseStringOrUndefined,
  parseUnknown
} from './native-hub-pipeline-resp-semantics-parsers.js';
import {
  failNative,
  extractNativeErrorMessage,
  isNativeDisabledByEnv,
  readNativeFunction,
  safeStringify
} from './native-hub-pipeline-resp-semantics-shared.js';
import type {
  ContextLengthDiagnosticsOutput,
  NativeRespInboundReasoningNormalizeInput,
  ProviderSseStreamReadErrorDescriptor,
  RespInboundSseErrorDescriptor
} from './native-hub-pipeline-resp-semantics-types.js';

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
