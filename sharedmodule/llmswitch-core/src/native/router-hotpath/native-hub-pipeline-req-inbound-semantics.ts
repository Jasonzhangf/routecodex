import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';
import { sanitizeFormatEnvelopeWithNative } from './native-hub-pipeline-edge-stage-semantics.js';


import type {
  NativeReqInboundChatToStandardizedInput
} from './native-hub-pipeline-req-inbound-semantics-types.js';
import {
  parseOptionalString,
  parseRecord
} from './native-hub-pipeline-req-inbound-semantics-parsers.js';

export type {
  NativeReqInboundChatToStandardizedInput
} from './native-hub-pipeline-req-inbound-semantics-types.js';

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
