import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';
import { sanitizeFormatEnvelopeWithNative } from './native-hub-pipeline-edge-stage-semantics.js';
import { formatUnknownError } from '../../shared/common-utils.js';


import type {
  NativeReqInboundChatToStandardizedInput
} from './native-hub-pipeline-req-inbound-semantics-types.js';

export type {
  NativeReqInboundChatToStandardizedInput
} from './native-hub-pipeline-req-inbound-semantics-types.js';

const NON_BLOCKING_REQ_INBOUND_PARSE_LOG_THROTTLE_MS = 60_000;
const nonBlockingReqInboundParseLogState = new Map<string, number>();
const JSON_PARSE_FAILED = Symbol('native-hub-pipeline-req-inbound-semantics.parse-failed');

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

function logNativeReqInboundParserNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingReqInboundParseLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_REQ_INBOUND_PARSE_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingReqInboundParseLogState.set(stage, now);
  console.warn(
    `[native-hub-pipeline-req-inbound-semantics] ${stage} parse failed (non-blocking): ${formatUnknownError(error)}`
  );
}

function parseJson(stage: string, raw: string): unknown | typeof JSON_PARSE_FAILED {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logNativeReqInboundParserNonBlocking(stage, error);
    return JSON_PARSE_FAILED;
  }
}

function parseOptionalString(raw: string): string | undefined | null {
  const parsed = parseJson('parseOptionalString', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null) {
    return undefined;
  }
  if (typeof parsed !== 'string') {
    return null;
  }
  const normalized = parsed.trim();
  return normalized ? normalized : undefined;
}

function parseRecord(raw: string): Record<string, unknown> | null {
  const parsed = parseJson('parseRecord', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

export function buildSlimResponsesContextWithNative(
  context: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!context) return null;
  const capability = 'buildSlimResponsesContextJson';
  const fail = () => { throw new Error(`[buildSlimResponsesContext] ${capability} unavailable`); };
  if (isNativeDisabledByEnv()) return fail();
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const inputJson = safeStringify(context);
  if (!inputJson) return fail();
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) return fail();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch (error: unknown) {
    return fail();
  }
}

export function pruneChatRequestPayloadWithNative(
  payload: Record<string, unknown>,
  preserveStreamField = false
): Record<string, unknown> {
  const capability = 'pruneChatRequestPayloadJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ payload, preserveStreamField });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
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

export function sanitizeReqInboundFormatEnvelopeWithNative<T>(
  candidate: unknown
): T {
  return sanitizeFormatEnvelopeWithNative(candidate) as T;
}

export function normalizeProviderProtocolTokenWithNative(
  value: string | undefined
): string | undefined {
  const capability = 'normalizeProviderProtocolTokenJson';
  const fail = (reason?: string) => failNativeRequired<string | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('normalizeProviderProtocolTokenJson');
  if (!fn) {
    return fail();
  }
  const valueJson = safeStringify(value ?? null);
  if (!valueJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(valueJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseOptionalString(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function chatEnvelopeToStandardizedWithNative(
  input: NativeReqInboundChatToStandardizedInput
): Record<string, unknown> {
  const capability = 'chatEnvelopeToStandardizedJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const chatJson = safeStringify(input.chatEnvelope);
  const adapterContextJson = safeStringify(input.adapterContext);
  if (!chatJson || !adapterContextJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(chatJson, adapterContextJson, String(input.endpoint || ''), input.requestId);
    if (raw instanceof Error) {
      return fail(raw.message || 'native error');
    }
    if (raw && typeof raw === 'object' && 'message' in (raw as Record<string, unknown>)) {
      const message = (raw as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim().length) {
        return fail(message.trim());
      }
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

export {
  mapReqInboundBridgeToolsToChatWithNative,
  mapChatToolsToBridgeWithNative,
  captureReqInboundResponsesContextSnapshotWithNative,
  collectReqInboundToolOutputsWithNative,
  buildReqInboundToolOutputSnapshotWithNative,
  appendReqInboundToolParseDiagnosticTextWithNative,
  injectReqInboundToolParseDiagnosticsWithNative,
  normalizeReqInboundShellLikeToolCallsWithNative
} from './native-hub-pipeline-req-inbound-semantics-tools.js';
