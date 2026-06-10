import {
  failNativeRequired,
  isNativeDisabledByEnv,
} from "./native-router-hotpath-policy.js";
import { loadNativeRouterHotpathBindingForInternalUse } from "./native-router-hotpath.js";
import { formatUnknownError } from '../../shared/common-utils.js';

const NON_BLOCKING_EDGE_STAGE_LOG_THROTTLE_MS = 60_000;
const nonBlockingEdgeStageLogState = new Map<string, number>();
const JSON_PARSE_FAILED = Symbol('native-hub-pipeline-edge-stage-semantics.parse-failed');


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
