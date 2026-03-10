import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

function parseJson(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

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

export function buildChatProcessContextMetadataWithNative(
  metadata: unknown
): Record<string, unknown> | undefined {
  const capability = 'buildChatProcessContextMetadataJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('buildChatProcessContextMetadataJson');
  if (!fn) {
    return fail();
  }
  const metadataJson = safeStringify(metadata ?? null);
  if (!metadataJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(metadataJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (parsed === null) {
      return undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyChatProcessedRequestWithNative(
  request: Record<string, unknown>,
  timestampMs: number
): Record<string, unknown> {
  const capability = 'applyChatProcessedRequestJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('applyChatProcessedRequestJson');
  if (!fn) {
    return fail();
  }
  const requestJson = safeStringify(request);
  if (!requestJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(requestJson, Number.isFinite(timestampMs) ? timestampMs : Date.now());
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildChatProcessedDescriptorWithNative(
  timestampMs: number,
  streamingEnabled: boolean
): Record<string, unknown> {
  const capability = 'buildChatProcessedDescriptorJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('buildChatProcessedDescriptorJson');
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(Number.isFinite(timestampMs) ? timestampMs : Date.now(), streamingEnabled === true);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildChatNodeResultMetadataWithNative(
  startTimeMs: number,
  endTimeMs: number,
  messagesCount: number,
  toolsCount: number,
  includeDataProcessed: boolean
): Record<string, unknown> {
  const capability = 'buildChatNodeResultMetadataJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('buildChatNodeResultMetadataJson');
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(
      Number.isFinite(startTimeMs) ? startTimeMs : 0,
      Number.isFinite(endTimeMs) ? endTimeMs : Date.now(),
      Math.floor(Number.isFinite(messagesCount) ? messagesCount : 0),
      Math.floor(Number.isFinite(toolsCount) ? toolsCount : 0),
      includeDataProcessed === true
    );
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildProcessedRequestFromChatResponseWithNative(
  chatResponse: Record<string, unknown>,
  streamEnabled: boolean
): Record<string, unknown> {
  const capability = 'buildProcessedRequestFromChatResponseJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(chatResponse);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson, streamEnabled === true);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
