import {
  failNativeRequired,
  isNativeDisabledByEnv,
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

function readNativeFunction(
  name: string,
): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<
    string,
    unknown
  > | null;
  const fn = binding?.[name];
  return typeof fn === 'function'
    ? (fn as (...args: unknown[]) => unknown)
    : null;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
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

function invokeRecordCapability(
  capability: string,
  args: unknown[],
): Record<string, unknown> {
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) return fail('native disabled');
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const encodedArgs: string[] = [];
  for (const arg of args) {
    const encoded = safeStringify(arg);
    if (!encoded) return fail('json stringify failed');
    encodedArgs.push(encoded);
  }
  try {
    const raw = fn(...encodedArgs);
    if (typeof raw !== 'string' || !raw) return fail('empty result');
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

function invokeVoidCapability(capability: string, args: unknown[]): void {
  const fail = (reason?: string) => failNativeRequired<void>(capability, reason);
  if (isNativeDisabledByEnv()) return fail('native disabled');
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const encodedArgs: string[] = [];
  for (const arg of args) {
    const encoded = safeStringify(arg);
    if (!encoded) return fail('json stringify failed');
    encodedArgs.push(encoded);
  }
  try {
    fn(...encodedArgs);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(reason);
  }
}

export function normalizeResponsePayloadWithNative(
  payload: Record<string, unknown>,
  config?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('normalizeResponsePayloadJson', [
    payload,
    config ?? {},
  ]);
}

export function validateResponsePayloadWithNative(
  payload: Record<string, unknown>,
): void {
  invokeVoidCapability('validateResponsePayloadJson', [payload]);
}

export function applyRequestRulesWithNative(
  payload: Record<string, unknown>,
  config?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('applyRequestRulesJson', [payload, config ?? {}]);
}

export function applyFieldMappingsWithNative(
  payload: Record<string, unknown>,
  mappings: unknown[],
): Record<string, unknown> {
  return invokeRecordCapability('applyFieldMappingsJson', [
    payload,
    Array.isArray(mappings) ? mappings : [],
  ]);
}

export function sanitizeToolSchemaGlmShellWithNative(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('sanitizeToolSchemaGlmShellJson', [payload]);
}

export function fixApplyPatchToolCallsWithNative(
  payload: {
    messages?: Array<Record<string, unknown>>;
    input?: Array<Record<string, unknown>>;
  },
): {
  messages: Array<Record<string, unknown>>;
  input?: Array<Record<string, unknown>>;
} {
  const parsed = invokeRecordCapability('fixApplyPatchToolCallsJson', [
    {
      messages: Array.isArray(payload?.messages) ? payload.messages : [],
      ...(Array.isArray(payload?.input) ? { input: payload.input } : {})
    },
  ]);
  const messages = Array.isArray(parsed.messages)
    ? parsed.messages.filter(
        (entry): entry is Record<string, unknown> =>
          !!entry && typeof entry === 'object' && !Array.isArray(entry),
      )
    : [];
  const input = Array.isArray(parsed.input)
    ? parsed.input.filter(
        (entry): entry is Record<string, unknown> =>
          !!entry && typeof entry === 'object' && !Array.isArray(entry),
      )
    : undefined;
  return {
    messages,
    ...(input ? { input } : {})
  };
}

export function applyResponseBlacklistWithNative(
  payload: Record<string, unknown>,
  config?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('applyResponseBlacklistJson', [
    payload,
    config ?? {},
  ]);
}

export function normalizeToolCallIdsWithNative(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('normalizeToolCallIdsJson', [payload]);
}

export function enforceLmstudioResponsesFcToolCallIdsWithNative(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('enforceLmstudioResponsesFcToolCallIdsJson', [
    payload,
  ]);
}

export function applyAnthropicClaudeCodeUserIdWithNative(
  payload: Record<string, unknown>,
  adapterContext?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('applyAnthropicClaudeCodeUserIdJson', [
    payload,
    adapterContext ?? {},
  ]);
}

export function applyGeminiWebSearchRequestCompatWithNative(
  payload: Record<string, unknown>,
  adapterContext?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('applyGeminiWebSearchRequestCompatJson', [
    payload,
    adapterContext ?? {},
  ]);
}

export function prepareAntigravityThoughtSignatureForGeminiRequestWithNative(
  payload: Record<string, unknown>,
  adapterContext?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability(
    'prepareAntigravityThoughtSignatureForGeminiRequestJson',
    [payload, adapterContext ?? {}],
  );
}

export function applyLmstudioResponsesInputStringifyWithNative(
  payload: Record<string, unknown>,
  adapterContext?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('applyLmstudioResponsesInputStringifyJson', [
    payload,
    adapterContext ?? {},
  ]);
}

export function applyToolTextRequestGuidanceWithNative(
  payload: Record<string, unknown>,
  config?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('applyToolTextRequestGuidanceJson', [
    payload,
    config ?? {},
  ]);
}

export function harvestToolCallsFromTextWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('harvestToolCallsFromTextJson', [
    payload,
    options ?? {},
  ]);
}

export function applyUniversalShapeRequestFilterWithNative(
  payload: Record<string, unknown>,
  config?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('applyUniversalShapeRequestFilterJson', [
    payload,
    config ?? {},
  ]);
}

export function applyUniversalShapeResponseFilterWithNative(
  payload: Record<string, unknown>,
  config?: Record<string, unknown>,
  adapterContext?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('applyUniversalShapeResponseFilterJson', [
    payload,
    config ?? {},
    adapterContext ?? {},
  ]);
}

export function buildOpenAIChatFromAnthropicWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('buildOpenaiChatFromAnthropicJson', [
    payload,
    options ?? {},
  ]);
}

export function buildAnthropicFromOpenAIChatWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('buildAnthropicFromOpenaiChatJson', [
    payload,
    options ?? {},
  ]);
}

export function runOpenAIRequestCodecWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('runOpenaiOpenaiRequestCodecJson', [
    payload,
    options ?? {},
  ]);
}

export function runOpenAIResponseCodecWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('runOpenaiOpenaiResponseCodecJson', [
    payload,
    options ?? {},
  ]);
}

export function runResponsesOpenAIRequestCodecWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('runResponsesOpenaiRequestCodecJson', [
    payload,
    options ?? {},
  ]);
}

export function runResponsesOpenAIResponseCodecWithNative(
  payload: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('runResponsesOpenaiResponseCodecJson', [
    payload,
    context,
  ]);
}

export function runGeminiOpenAIRequestCodecWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('runGeminiOpenaiRequestCodecJson', [
    payload,
    options ?? {},
  ]);
}

export function runGeminiOpenAIResponseCodecWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('runGeminiOpenaiResponseCodecJson', [
    payload,
    options ?? {},
  ]);
}

export function runGeminiFromOpenAIChatCodecWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  return invokeRecordCapability('runGeminiFromOpenaiChatCodecJson', [
    payload,
    options ?? {},
  ]);
}
