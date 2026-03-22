import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';
import { sanitizeFormatEnvelopeWithNative } from './native-hub-pipeline-edge-stage-semantics.js';
import {
  augmentContextSnapshotWithNative,
  mapResumeToolOutputsDetailedWithNative,
  normalizeToolCallIdStyleCandidateWithNative,
  resolveServerToolFollowupSnapshotWithNative
} from './native-hub-pipeline-inbound-outbound-semantics.js';


import type {
  NativeReqInboundSemanticLiftApplyInput,
  NativeProviderProtocolToken,
  NativeReqInboundChatToStandardizedInput,
  NativeReqInboundReasoningNormalizeInput
} from './native-hub-pipeline-req-inbound-semantics-types.js';
import {
  parseOptionalString,
  parseBoolean,
  parseUnknown,
  parseRecord
} from './native-hub-pipeline-req-inbound-semantics-parsers.js';

export type {
  NativeContextToolOutput,
  NativeResumeToolOutput,
  NativeReqInboundSemanticLiftApplyInput,
  NativeProviderProtocolToken,
  NativeReqInboundChatToStandardizedInput,
  NativeReqInboundReasoningNormalizeInput
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

export function normalizeReqInboundReasoningPayloadWithNative(
  input: NativeReqInboundReasoningNormalizeInput
): Record<string, unknown> {
  const capability = 'normalizeReqInboundReasoningPayloadJson';
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

export function mapReqInboundResumeToolOutputsDetailedWithNative(
  responsesResume: unknown
): Array<{ tool_call_id: string; content: string }> {
  return mapResumeToolOutputsDetailedWithNative(responsesResume);
}

export function resolveClientInjectReadyWithNative(
  metadata: Record<string, unknown>
): boolean {
  const capability = 'resolveClientInjectReadyJson';
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('resolveClientInjectReadyJson');
  if (!fn) {
    return fail();
  }
  const metadataJson = safeStringify(metadata);
  if (!metadataJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(metadataJson);
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

export function normalizeContextCaptureLabelWithNative(
  label: string | undefined
): string {
  const capability = 'normalizeContextCaptureLabelJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('normalizeContextCaptureLabelJson');
  if (!fn) {
    return fail();
  }
  const labelJson = safeStringify(label ?? null);
  if (!labelJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(labelJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseOptionalString(raw);
    if (parsed === null) {
      return fail('invalid payload');
    }
    return parsed ?? 'context_capture';
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function shouldRunHubChatProcessWithNative(
  requestId: string,
  entryEndpoint: string
): boolean {
  const capability = 'shouldRunHubChatProcessJson';
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('shouldRunHubChatProcessJson');
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(requestId, entryEndpoint);
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

export function isShellLikeToolNameTokenWithNative(
  name: string | undefined
): boolean {
  const capability = 'isShellLikeToolNameTokenJson';
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('isShellLikeToolNameTokenJson');
  if (!fn) {
    return fail();
  }
  const nameJson = safeStringify(name ?? null);
  if (!nameJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(nameJson);
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

export function applyReqInboundSemanticLiftWithNative(
  input: NativeReqInboundSemanticLiftApplyInput
): Record<string, unknown> {
  const capability = 'applyReqInboundSemanticLiftJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('applyReqInboundSemanticLiftJson');
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
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

export function resolveReqInboundServerToolFollowupSnapshotWithNative(
  adapterContext: unknown
): Record<string, unknown> | undefined {
  return resolveServerToolFollowupSnapshotWithNative(adapterContext);
}

export function augmentReqInboundContextSnapshotWithNative(
  context: Record<string, unknown>,
  fallbackSnapshot: Record<string, unknown>
): Record<string, unknown> {
  return augmentContextSnapshotWithNative(context, fallbackSnapshot);
}

export function normalizeReqInboundToolCallIdStyleWithNative(
  value: unknown
): 'fc' | 'preserve' | undefined {
  return normalizeToolCallIdStyleCandidateWithNative(value);
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
