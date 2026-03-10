import {
  failNativeRequired,
  isNativeDisabledByEnv,
} from "./native-router-hotpath-policy.js";
import { loadNativeRouterHotpathBindingForInternalUse } from "./native-router-hotpath.js";

function readNativeFunction(
  name: string,
): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<
    string,
    unknown
  > | null;
  const fn = binding?.[name];
  return typeof fn === "function"
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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function normalizeResponsePayloadWithNative(
  payload: Record<string, unknown>,
  config?: Record<string, unknown>,
): Record<string, unknown> {
  const capability = "normalizeResponsePayloadJson";
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail("native disabled");
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload);
  const configJson = config ? safeStringify(config) : "{}";
  if (!payloadJson || !configJson) {
    return fail("json stringify failed");
  }
  try {
    const raw = fn(payloadJson, configJson);
    if (typeof raw !== "string" || !raw) {
      return fail("empty result");
    }
    const parsed = parseRecord(raw);
    return parsed ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function validateResponsePayloadWithNative(
  payload: Record<string, unknown>,
): void {
  const capability = "validateResponsePayloadJson";
  const fail = (reason?: string) =>
    failNativeRequired<void>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail("native disabled");
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload);
  if (!payloadJson) {
    return fail("json stringify failed");
  }
  try {
    fn(payloadJson);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    throw new Error(reason);
  }
}

export function applyRequestRulesWithNative(
  payload: Record<string, unknown>,
  config?: Record<string, unknown>,
): Record<string, unknown> {
  const capability = "applyRequestRulesJson";
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) return fail("native disabled");
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const payloadJson = safeStringify(payload);
  const configJson = config ? safeStringify(config) : "{}";
  if (!payloadJson || !configJson) return fail("json stringify failed");
  try {
    const raw = fn(payloadJson, configJson);
    if (typeof raw !== "string" || !raw) return fail("empty result");
    const parsed = parseRecord(raw);
    return parsed ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function applyResponseBlacklistWithNative(
  payload: Record<string, unknown>,
  config?: Record<string, unknown>,
): Record<string, unknown> {
  const capability = "applyResponseBlacklistJson";
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) return fail("native disabled");
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const payloadJson = safeStringify(payload);
  const configJson = config ? safeStringify(config) : "{}";
  if (!payloadJson || !configJson) return fail("json stringify failed");
  try {
    const raw = fn(payloadJson, configJson);
    if (typeof raw !== "string" || !raw) return fail("empty result");
    const parsed = parseRecord(raw);
    return parsed ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function normalizeToolCallIdsWithNative(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const capability = "normalizeToolCallIdsJson";
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) return fail("native disabled");
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const payloadJson = safeStringify(payload);
  if (!payloadJson) return fail("json stringify failed");
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== "string" || !raw) return fail("empty result");
    const parsed = parseRecord(raw);
    return parsed ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function enforceLmstudioResponsesFcToolCallIdsWithNative(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const capability = "enforceLmstudioResponsesFcToolCallIdsJson";
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) return fail("native disabled");
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const payloadJson = safeStringify(payload);
  if (!payloadJson) return fail("json stringify failed");
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== "string" || !raw) return fail("empty result");
    const parsed = parseRecord(raw);
    return parsed ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function applyAnthropicClaudeCodeUserIdWithNative(
  payload: Record<string, unknown>,
  adapterContext?: Record<string, unknown>,
): Record<string, unknown> {
  const capability = "applyAnthropicClaudeCodeUserIdJson";
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) return fail("native disabled");
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const payloadJson = safeStringify(payload);
  const contextJson = adapterContext ? safeStringify(adapterContext) : "{}";
  if (!payloadJson || !contextJson) return fail("json stringify failed");
  try {
    const raw = fn(payloadJson, contextJson);
    if (typeof raw !== "string" || !raw) return fail("empty result");
    const parsed = parseRecord(raw);
    return parsed ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function applyGeminiWebSearchRequestCompatWithNative(
  payload: Record<string, unknown>,
  adapterContext?: Record<string, unknown>,
): Record<string, unknown> {
  const capability = "applyGeminiWebSearchRequestCompatJson";
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) return fail("native disabled");
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const payloadJson = safeStringify(payload);
  const contextJson = adapterContext ? safeStringify(adapterContext) : "{}";
  if (!payloadJson || !contextJson) return fail("json stringify failed");
  try {
    const raw = fn(payloadJson, contextJson);
    if (typeof raw !== "string" || !raw) return fail("empty result");
    const parsed = parseRecord(raw);
    return parsed ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function prepareAntigravityThoughtSignatureForGeminiRequestWithNative(
  payload: Record<string, unknown>,
  adapterContext?: Record<string, unknown>,
): Record<string, unknown> {
  const capability = "prepareAntigravityThoughtSignatureForGeminiRequestJson";
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) return fail("native disabled");
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const payloadJson = safeStringify(payload);
  const contextJson = adapterContext ? safeStringify(adapterContext) : "{}";
  if (!payloadJson || !contextJson) return fail("json stringify failed");
  try {
    const raw = fn(payloadJson, contextJson);
    if (typeof raw !== "string" || !raw) return fail("empty result");
    const parsed = parseRecord(raw);
    return parsed ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function applyIflowToolTextFallbackWithNative(
  payload: Record<string, unknown>,
  adapterContext?: Record<string, unknown>,
  models?: string[],
): Record<string, unknown> {
  const capability = "applyIflowToolTextFallbackJson";
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) return fail("native disabled");
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const payloadJson = safeStringify(payload);
  const contextJson = adapterContext ? safeStringify(adapterContext) : "{}";
  const modelsJson = safeStringify(Array.isArray(models) ? models : []);
  if (!payloadJson || !contextJson || !modelsJson)
    return fail("json stringify failed");
  try {
    const raw = fn(payloadJson, contextJson, modelsJson);
    if (typeof raw !== "string" || !raw) return fail("empty result");
    const parsed = parseRecord(raw);
    return parsed ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function applyToolTextRequestGuidanceWithNative(
  payload: Record<string, unknown>,
  config?: Record<string, unknown>,
): Record<string, unknown> {
  const capability = "applyToolTextRequestGuidanceJson";
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) return fail("native disabled");
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const payloadJson = safeStringify(payload);
  const configJson = config ? safeStringify(config) : "{}";
  if (!payloadJson || !configJson) return fail("json stringify failed");
  try {
    const raw = fn(payloadJson, configJson);
    if (typeof raw !== "string" || !raw) return fail("empty result");
    const parsed = parseRecord(raw);
    return parsed ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function applyUniversalShapeRequestFilterWithNative(
  payload: Record<string, unknown>,
  config?: Record<string, unknown>,
): Record<string, unknown> {
  const capability = "applyUniversalShapeRequestFilterJson";
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) return fail("native disabled");
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const payloadJson = safeStringify(payload);
  const configJson = config ? safeStringify(config) : "{}";
  if (!payloadJson || !configJson) return fail("json stringify failed");
  try {
    const raw = fn(payloadJson, configJson);
    if (typeof raw !== "string" || !raw) return fail("empty result");
    const parsed = parseRecord(raw);
    return parsed ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function applyUniversalShapeResponseFilterWithNative(
  payload: Record<string, unknown>,
  config?: Record<string, unknown>,
  adapterContext?: Record<string, unknown>,
): Record<string, unknown> {
  const capability = "applyUniversalShapeResponseFilterJson";
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) return fail("native disabled");
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const payloadJson = safeStringify(payload);
  const configJson = config ? safeStringify(config) : "{}";
  const contextJson = adapterContext ? safeStringify(adapterContext) : "{}";
  if (!payloadJson || !configJson || !contextJson)
    return fail("json stringify failed");
  try {
    const raw = fn(payloadJson, configJson, contextJson);
    if (typeof raw !== "string" || !raw) return fail("empty result");
    const parsed = parseRecord(raw);
    return parsed ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function buildOpenAIChatFromAnthropicWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  const capability = "buildOpenaiChatFromAnthropicJson";
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) return fail("native disabled");
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const payloadJson = safeStringify(payload);
  const optionsJson = options ? safeStringify(options) : "{}";
  if (!payloadJson || !optionsJson) return fail("json stringify failed");
  try {
    const raw = fn(payloadJson, optionsJson);
    if (typeof raw !== "string" || !raw) return fail("empty result");
    const parsed = parseRecord(raw);
    return parsed ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function buildAnthropicFromOpenAIChatWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  const capability = "buildAnthropicFromOpenaiChatJson";
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) return fail("native disabled");
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const payloadJson = safeStringify(payload);
  const optionsJson = options ? safeStringify(options) : "{}";
  if (!payloadJson || !optionsJson) return fail("json stringify failed");
  try {
    const raw = fn(payloadJson, optionsJson);
    if (typeof raw !== "string" || !raw) return fail("empty result");
    const parsed = parseRecord(raw);
    return parsed ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function runOpenAIRequestCodecWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  const capability = "runOpenaiOpenaiRequestCodecJson";
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) return fail("native disabled");
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const payloadJson = safeStringify(payload);
  const optionsJson = options ? safeStringify(options) : "{}";
  if (!payloadJson || !optionsJson) return fail("json stringify failed");
  try {
    const raw = fn(payloadJson, optionsJson);
    if (typeof raw !== "string" || !raw) return fail("empty result");
    const parsed = parseRecord(raw);
    return parsed ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function runOpenAIResponseCodecWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  const capability = "runOpenaiOpenaiResponseCodecJson";
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) return fail("native disabled");
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const payloadJson = safeStringify(payload);
  const optionsJson = options ? safeStringify(options) : "{}";
  if (!payloadJson || !optionsJson) return fail("json stringify failed");
  try {
    const raw = fn(payloadJson, optionsJson);
    if (typeof raw !== "string" || !raw) return fail("empty result");
    const parsed = parseRecord(raw);
    return parsed ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function runResponsesOpenAIRequestCodecWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  const capability = "runResponsesOpenaiRequestCodecJson";
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) return fail("native disabled");
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const payloadJson = safeStringify(payload);
  const optionsJson = options ? safeStringify(options) : "{}";
  if (!payloadJson || !optionsJson) return fail("json stringify failed");
  try {
    const raw = fn(payloadJson, optionsJson);
    if (typeof raw !== "string" || !raw) return fail("empty result");
    const parsed = parseRecord(raw);
    return parsed ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function runResponsesOpenAIResponseCodecWithNative(
  payload: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const capability = "runResponsesOpenaiResponseCodecJson";
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) return fail("native disabled");
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const payloadJson = safeStringify(payload);
  const contextJson = safeStringify(context);
  if (!payloadJson || !contextJson) return fail("json stringify failed");
  try {
    const raw = fn(payloadJson, contextJson);
    if (typeof raw !== "string" || !raw) return fail("empty result");
    const parsed = parseRecord(raw);
    return parsed ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function runGeminiOpenAIRequestCodecWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  const capability = "runGeminiOpenaiRequestCodecJson";
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) return fail("native disabled");
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const payloadJson = safeStringify(payload);
  const optionsJson = options ? safeStringify(options) : "{}";
  if (!payloadJson || !optionsJson) return fail("json stringify failed");
  try {
    const raw = fn(payloadJson, optionsJson);
    if (typeof raw !== "string" || !raw) return fail("empty result");
    const parsed = parseRecord(raw);
    return parsed ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function runGeminiOpenAIResponseCodecWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  const capability = "runGeminiOpenaiResponseCodecJson";
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) return fail("native disabled");
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const payloadJson = safeStringify(payload);
  const optionsJson = options ? safeStringify(options) : "{}";
  if (!payloadJson || !optionsJson) return fail("json stringify failed");
  try {
    const raw = fn(payloadJson, optionsJson);
    if (typeof raw !== "string" || !raw) return fail("empty result");
    const parsed = parseRecord(raw);
    return parsed ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function runGeminiFromOpenAIChatCodecWithNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  const capability = "runGeminiFromOpenaiChatCodecJson";
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) return fail("native disabled");
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const payloadJson = safeStringify(payload);
  const optionsJson = options ? safeStringify(options) : "{}";
  if (!payloadJson || !optionsJson) return fail("json stringify failed");
  try {
    const raw = fn(payloadJson, optionsJson);
    if (typeof raw !== "string" || !raw) return fail("empty result");
    const parsed = parseRecord(raw);
    return parsed ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}
