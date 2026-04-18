import {
  failNativeRequired,
  isNativeDisabledByEnv,
} from "./native-router-hotpath-policy.js";
import { loadNativeRouterHotpathBindingForInternalUse } from "./native-router-hotpath.js";

const NON_BLOCKING_EDGE_STAGE_LOG_THROTTLE_MS = 60_000;
const nonBlockingEdgeStageLogState = new Map<string, number>();
const JSON_PARSE_FAILED = Symbol('native-hub-pipeline-edge-stage-semantics.parse-failed');

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error ?? "unknown");
  }
}

function logNativeEdgeStageNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingEdgeStageLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_EDGE_STAGE_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingEdgeStageLogState.set(stage, now);
  console.warn(
    `[native-hub-pipeline-edge-stage-semantics] ${stage} failed (non-blocking): ${formatUnknownError(error)}`,
  );
}

function parseJson(stage: string, raw: string): unknown | typeof JSON_PARSE_FAILED {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logNativeEdgeStageNonBlocking(stage, error);
    return JSON_PARSE_FAILED;
  }
}

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
  } catch (error) {
    logNativeEdgeStageNonBlocking("safeStringify", error);
    return undefined;
  }
}

function parseRecord(raw: string): Record<string, unknown> | null {
  const parsed = parseJson("parseRecord", raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function parseFormatEnvelopePayload(
  raw: string,
  direction: "request" | "response",
  fallbackProtocol: string,
  fallbackPayload: Record<string, unknown>,
): Record<string, unknown> | null {
  const parsed = parseJson("parseFormatEnvelopePayload", raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
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
}

function parseOptionalString(raw: string): string | undefined | null {
  const parsed = parseJson("parseOptionalString", raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null) {
    return undefined;
  }
  if (typeof parsed !== "string") {
    return null;
  }
  const trimmed = parsed.trim();
  return trimmed ? trimmed : undefined;
}

function parseBoolean(raw: string): boolean | null {
  const parsed = parseJson("parseBoolean", raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  return typeof parsed === "boolean" ? parsed : null;
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

export function normalizeOpenaiChatReasoningOutboundWithNative<T>(
  candidate: T,
): T {
  const capability = "normalizeOpenaiChatReasoningOutboundJson";
  const fail = (reason?: string) => failNativeRequired<T>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail("native disabled");
  }
  const fn = readNativeFunction("normalizeOpenaiChatReasoningOutboundJson");
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

export function processSseStreamWithNative(input: {
  clientPayload: Record<string, unknown>;
  clientProtocol: string;
  requestId: string;
  wantsStream: boolean;
}): { shouldStream: boolean; payload: Record<string, unknown> } {
  const capability = "processSseStreamJson";
  const fail = (reason?: string) =>
    failNativeRequired<{ shouldStream: boolean; payload: Record<string, unknown> }>(
      capability,
      reason,
    );
  if (isNativeDisabledByEnv()) {
    return fail("native disabled");
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(input);
  if (!payloadJson) {
    return fail("json stringify failed");
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== "string" || !raw) {
      return fail("empty result");
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      return fail("invalid payload");
    }
    const shouldStream = parsed.shouldStream;
    const payload = parsed.payload;
    if (typeof shouldStream !== "boolean") {
      return fail("invalid shouldStream");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return fail("invalid payload object");
    }
    return {
      shouldStream,
      payload: payload as Record<string, unknown>,
    };
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
    const parsed = parseJson("parseReqInboundFormatEnvelopeWithNative", raw);
    if (parsed === JSON_PARSE_FAILED) {
      return fail("invalid envelope structure");
    }
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
