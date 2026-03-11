import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function parseAliasMap(raw: string): Record<string, string> | undefined | null {
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

function parseClientToolsRaw(raw: string): unknown[] | undefined | null {
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

function parseRecord(raw: string): Record<string, unknown> | null {
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

function parseBoolean(raw: string): boolean | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'boolean' ? parsed : null;
  } catch {
    return null;
  }
}

function parseUnknown(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function parseStringOrUndefined(raw: string): string | undefined | null {
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

export interface NativeRespInboundReasoningNormalizeInput {
  payload: Record<string, unknown>;
  protocol: string;
}

function parseContextLengthDiagnostics(
  raw: string
): { estimatedPromptTokens?: number; maxContextTokens?: number } | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const output: { estimatedPromptTokens?: number; maxContextTokens?: number } = {};
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

function parseRespInboundSseErrorDescriptor(
  raw: string
): {
  code: 'SSE_DECODE_ERROR' | 'HTTP_502';
  protocol: string;
  providerType?: string;
  errorMessage: string;
  details: Record<string, unknown>;
  stageRecord: Record<string, unknown>;
  status?: number;
} | null {
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

function parseJsonObjectCandidate(raw: string): Record<string, unknown> | null | undefined {
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

function parseResponsesHostPolicyResult(
  raw: string
): { shouldStripHostManagedFields: boolean; targetProtocol: string } | null {
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

export function normalizeAliasMapWithNative(
  candidate: unknown
): Record<string, string> | undefined {
  const capability = 'normalizeAliasMapJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, string> | undefined>(capability, reason);
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
  const fail = (reason?: string) => failNativeRequired<unknown[] | undefined>(capability, reason);
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
  const fail = (reason?: string) => failNativeRequired<Record<string, string> | undefined>(capability, reason);
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

export function resolveClientToolsRawFromRespSemanticsWithNative(
  semantics: unknown
): unknown[] | undefined {
  const capability = 'resolveClientToolsRawFromRespSemanticsJson';
  const fail = (reason?: string) => failNativeRequired<unknown[] | undefined>(capability, reason);
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
  const fail = (reason?: string) => failNativeRequired<string | undefined>(capability, reason);
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
  const fail = (reason?: string) => failNativeRequired<string | undefined>(capability, reason);
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
): { estimatedPromptTokens?: number; maxContextTokens?: number } {
  const capability = 'extractContextLengthDiagnosticsJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ estimatedPromptTokens?: number; maxContextTokens?: number }>(capability, reason);
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
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
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

export function buildRespInboundSseErrorDescriptorWithNative(input: unknown): {
  code: 'SSE_DECODE_ERROR' | 'HTTP_502';
  protocol: string;
  providerType?: string;
  errorMessage: string;
  details: Record<string, unknown>;
  stageRecord: Record<string, unknown>;
  status?: number;
} {
  const capability = 'buildRespInboundSseErrorDescriptorJson';
  const fail = (reason?: string) => failNativeRequired<{
    code: 'SSE_DECODE_ERROR' | 'HTTP_502';
    protocol: string;
    providerType?: string;
    errorMessage: string;
    details: Record<string, unknown>;
    stageRecord: Record<string, unknown>;
    status?: number;
  }>(capability, reason);
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

export function normalizeRespInboundReasoningPayloadWithNative(
  input: NativeRespInboundReasoningNormalizeInput
): Record<string, unknown> {
  const capability = 'normalizeRespInboundReasoningPayloadJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
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

export function applyClientPassthroughPatchWithNative(
  clientPayload: unknown,
  sourcePayload: unknown
): Record<string, unknown> {
  const capability = 'applyClientPassthroughPatchJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const clientPayloadJson = safeStringify(clientPayload);
  const sourcePayloadJson = safeStringify(sourcePayload);
  if (!clientPayloadJson || !sourcePayloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(clientPayloadJson, sourcePayloadJson);
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

export function buildAnthropicResponseFromChatWithNative(
  chatResponse: unknown,
  aliasMap?: Record<string, string>
): Record<string, unknown> {
  const capability = 'buildAnthropicResponseFromChatJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
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
    const nativeErrorMessage =
      raw instanceof Error
        ? raw.message
        : raw && typeof raw === 'object' && 'message' in (raw as Record<string, unknown>)
          ? (() => {
              const candidate = (raw as Record<string, unknown>).message;
              return typeof candidate === 'string' ? candidate : '';
            })()
          : '';
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

export function normalizeResponsesToolCallArgumentsForClientWithNative(
  responsesPayload: unknown,
  toolsRaw: unknown[]
): Record<string, unknown> {
  const capability = 'normalizeResponsesToolCallArgumentsForClientJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
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
    const nativeErrorMessage =
      raw instanceof Error
        ? raw.message
        : raw && typeof raw === 'object' && 'message' in (raw as Record<string, unknown>)
          ? (() => {
              const candidate = (raw as Record<string, unknown>).message;
              return typeof candidate === 'string' ? candidate : '';
            })()
          : '';
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
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
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
    const nativeErrorMessage =
      raw instanceof Error
        ? raw.message
        : raw && typeof raw === 'object' && 'message' in (raw as Record<string, unknown>)
          ? (() => {
              const candidate = (raw as Record<string, unknown>).message;
              return typeof candidate === 'string' ? candidate : '';
            })()
          : '';
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
    parallelToolCalls?: unknown;
    toolChoice?: unknown;
    include?: unknown;
    store?: unknown;
    stripHostManagedFields?: boolean;
    sourceForRetention?: Record<string, unknown>;
  } = {}
): Record<string, unknown> {
  const capability = 'buildResponsesPayloadFromChatJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
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
    const nativeErrorMessage =
      raw instanceof Error
        ? raw.message
        : raw && typeof raw === 'object' && 'message' in (raw as Record<string, unknown>)
          ? (() => {
              const candidate = (raw as Record<string, unknown>).message;
              return typeof candidate === 'string' ? candidate : '';
            })()
          : '';
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
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
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
    const parsed = parseBoolean(raw);
    return parsed === null ? fail('invalid payload') : parsed;
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
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | null>(capability, reason);
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
): { shouldStripHostManagedFields: boolean; targetProtocol: string } {
  const capability = 'evaluateResponsesHostPolicyJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ shouldStripHostManagedFields: boolean; targetProtocol: string }>(capability, reason);
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
