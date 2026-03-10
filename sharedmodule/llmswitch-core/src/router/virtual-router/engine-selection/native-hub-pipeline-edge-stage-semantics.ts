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

function parseFormatEnvelopePayload(
  raw: string,
  direction: "request" | "response",
  fallbackProtocol: string,
  fallbackPayload: Record<string, unknown>,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const envelope = row.envelope;
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      return null;
    }
    const env = envelope as Record<string, unknown>;
    const protocol =
      typeof env.format === "string" && env.format.trim().length
        ? env.format.trim()
        : fallbackProtocol;
    const payload =
      env.payload &&
      typeof env.payload === "object" &&
      !Array.isArray(env.payload)
        ? (env.payload as Record<string, unknown>)
        : fallbackPayload;
    const out: Record<string, unknown> = {
      protocol,
      direction,
      payload,
    };
    if (
      env.metadata &&
      typeof env.metadata === "object" &&
      !Array.isArray(env.metadata)
    ) {
      out.meta = env.metadata as Record<string, unknown>;
    }
    return out;
  } catch {
    return null;
  }
}

function parseOptionalString(raw: string): string | undefined | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) {
      return undefined;
    }
    if (typeof parsed !== "string") {
      return null;
    }
    const trimmed = parsed.trim();
    return trimmed ? trimmed : undefined;
  } catch {
    return null;
  }
}

function parseBoolean(raw: string): boolean | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "boolean" ? parsed : null;
  } catch {
    return null;
  }
}

export function sanitizeFormatEnvelopeWithNative<T>(candidate: T): T {
  const capability = "sanitizeFormatEnvelopeJson";
  const fail = (reason?: string) => failNativeRequired<T>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail("native disabled");
  }
  const fn = readNativeFunction("sanitizeFormatEnvelopeJson");
  if (!fn) {
    return fail();
  }
  const candidateJson = safeStringify(candidate);
  if (!candidateJson) {
    return fail("json stringify failed");
  }
  try {
    const raw = fn(candidateJson);
    if (typeof raw !== "string" || !raw) {
      return fail("empty result");
    }
    const parsed = parseRecord(raw);
    return (parsed as unknown as T) ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function sanitizeChatCompletionLikeWithNative<T>(candidate: T): T {
  const capability = "sanitizeChatCompletionLikeJson";
  const fail = (reason?: string) => failNativeRequired<T>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail("native disabled");
  }
  const fn = readNativeFunction("sanitizeChatCompletionLikeJson");
  if (!fn) {
    return fail();
  }
  const candidateJson = safeStringify(candidate);
  if (!candidateJson) {
    return fail("json stringify failed");
  }
  try {
    const raw = fn(candidateJson);
    if (typeof raw !== "string" || !raw) {
      return fail("empty result");
    }
    const parsed = parseRecord(raw);
    return (parsed as unknown as T) ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function stripPrivateFieldsWithNative<T extends Record<string, unknown>>(
  payload: T,
): T {
  const capability = "stripPrivateFieldsJson";
  const fail = (reason?: string) => failNativeRequired<T>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail("native disabled");
  }
  const fn = readNativeFunction("stripPrivateFieldsJson");
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload);
  if (!payloadJson) {
    return fail("json stringify failed");
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== "string" || !raw) {
      return fail("empty result");
    }
    const parsed = parseRecord(raw);
    return (parsed as unknown as T) ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function resolveCompatProfileWithNative(
  adapterContext: unknown,
  explicitProfile: string | undefined,
): string | undefined {
  const capability = "resolveCompatProfileJson";
  const fail = (reason?: string) =>
    failNativeRequired<string | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail("native disabled");
  }
  const fn = readNativeFunction("resolveCompatProfileJson");
  if (!fn) {
    return fail();
  }
  const adapterContextJson = safeStringify(adapterContext);
  const explicitJson = safeStringify(explicitProfile ?? null);
  if (!adapterContextJson || !explicitJson) {
    return fail("json stringify failed");
  }
  try {
    const raw = fn(adapterContextJson, explicitJson);
    if (typeof raw !== "string" || !raw) {
      return fail("empty result");
    }
    const parsed = parseOptionalString(raw);
    return parsed === null ? fail("invalid payload") : parsed;
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function resolveSseStreamModeWithNative(
  wantsStream: boolean,
  clientProtocol: string,
): boolean {
  const capability = "resolveSseStreamModeJson";
  const fail = (reason?: string) =>
    failNativeRequired<boolean>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail("native disabled");
  }
  const fn = readNativeFunction("resolveSseStreamModeJson");
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(Boolean(wantsStream), String(clientProtocol || ""));
    if (typeof raw !== "string" || !raw) {
      return fail("empty result");
    }
    const parsed = parseBoolean(raw);
    return parsed === null ? fail("invalid payload") : parsed;
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function parseReqInboundFormatEnvelopeWithNative(input: {
  rawRequest: Record<string, unknown>;
  protocol: string;
}): Record<string, unknown> {
  const capability = "parseFormatEnvelopeJson";
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail("native disabled");
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input);
  if (!inputJson) {
    return fail("json stringify failed");
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== "string" || !raw) {
      return fail("empty result");
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fail("invalid envelope structure");
    }
    const result = parsed as Record<string, unknown>;
    if (!result.envelope || typeof result.envelope !== "object") {
      return fail("missing envelope in result");
    }
    return result.envelope as Record<string, unknown>;
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function parseRespInboundFormatEnvelopeWithNative(input: {
  payload: Record<string, unknown>;
  protocol: string;
}): Record<string, unknown> {
  const capability = "parseRespFormatEnvelopeJson";
  const fail = (reason?: string) =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail("native disabled");
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input);
  if (!inputJson) {
    return fail("json stringify failed");
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== "string" || !raw) {
      return fail("empty result");
    }
    const parsed = parseFormatEnvelopePayload(
      raw,
      "response",
      input.protocol,
      input.payload,
    );
    return parsed ?? fail("invalid payload");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return fail(reason);
  }
}

export function validateChatEnvelopeWithNative(
  chatEnvelope: unknown,
  options: {
    stage: "req_inbound" | "req_outbound" | "resp_inbound" | "resp_outbound";
    direction: "request" | "response";
    source?: string;
  },
): void {
  const capability = "validateChatEnvelopeJson";
  const fail = (reason?: string) =>
    failNativeRequired<void>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail("native disabled");
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const envelopeJson = safeStringify(chatEnvelope);
  if (!envelopeJson) {
    return fail("json stringify failed");
  }
  const isChatEnvelopeValidationError = (message: string): boolean =>
    typeof message === "string" &&
    message.includes("ChatEnvelopeValidationError(");
  try {
    const raw = fn(
      envelopeJson,
      String(options.stage || ""),
      String(options.direction || ""),
      options.source,
    );
    const nativeErrorMessage =
      raw instanceof Error
        ? raw.message
        : raw &&
            typeof raw === "object" &&
            "message" in (raw as Record<string, unknown>)
          ? (() => {
              const candidate = (raw as Record<string, unknown>).message;
              return typeof candidate === "string" ? candidate : "";
            })()
          : "";
    if (nativeErrorMessage) {
      if (isChatEnvelopeValidationError(nativeErrorMessage)) {
        throw new Error(nativeErrorMessage);
      }
      return fail(nativeErrorMessage);
    }
    if (typeof raw !== "string" || !raw) {
      return fail("empty result");
    }
    const parsed = parseBoolean(raw);
    if (parsed !== true) {
      return fail("invalid payload");
    }
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown");
    if (isChatEnvelopeValidationError(reason)) {
      throw error instanceof Error ? error : new Error(reason);
    }
    return fail(reason);
  }
}
