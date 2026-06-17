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

function invokeBooleanCapability(capability: string, payload: unknown): boolean {
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
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
    if (typeof raw === 'boolean') {
      return raw;
    }
    if (typeof raw === 'string') {
      return JSON.parse(raw) === true;
    }
    return fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function hasRequestedToolsInSemanticsWithNative(requestSemantics?: Record<string, unknown>): boolean {
  return invokeBooleanCapability('hasRequestedToolsInSemanticsJson', requestSemantics ?? null);
}

export function isRequiredToolCallTurnWithNative(requestSemantics?: Record<string, unknown>): boolean {
  return invokeBooleanCapability('isRequiredToolCallTurnJson', requestSemantics ?? null);
}

export function isToolResultFollowupTurnWithNative(requestSemantics?: Record<string, unknown>): boolean {
  return invokeBooleanCapability('isToolResultFollowupTurnJson', requestSemantics ?? null);
}

export function isProviderNativeResumeContinuationWithNative(requestSemantics?: Record<string, unknown>): boolean {
  return invokeBooleanCapability('isProviderNativeResumeContinuationJson', requestSemantics ?? null);
}

export function detectRetryableEmptyAssistantResponseWithNative(
  body: unknown,
  requestSemantics?: Record<string, unknown>
): Record<string, unknown> | null {
  const capability = 'detectRetryableEmptyAssistantResponseJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const bodyJson = safeStringify(body ?? null);
  const requestSemanticsJson = safeStringify(requestSemantics ?? null);
  if (!bodyJson || requestSemanticsJson === undefined) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(bodyJson, requestSemanticsJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (parsed === null) {
      return null;
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

export function isToolCallContinuationResponseWithNative(body: unknown): boolean {
  return invokeBooleanCapability('isToolCallContinuationResponseJson', body ?? null);
}

export function isEmptyClientResponsePayloadWithNative(body: unknown): boolean {
  return invokeBooleanCapability('isEmptyClientResponsePayloadJson', body ?? null);
}
