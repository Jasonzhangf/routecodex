import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

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
  args: unknown[]
): Record<string, unknown> {
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const encodedArgs: string[] = [];
  for (const arg of args) {
    const encoded = safeStringify(arg);
    if (!encoded) {
      return fail('json stringify failed');
    }
    encodedArgs.push(encoded);
  }
  try {
    const raw = fn(...encodedArgs);
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

function invokeStringCapability(
  capability: string,
  args: unknown[],
  fallbackArgReason = 'invalid payload'
): string {
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(...args);
    if (typeof raw !== 'string') {
      return fail(fallbackArgReason);
    }
    return raw;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function mapOpenaiChatToChatWithNative(
  payload: Record<string, unknown> | null | undefined,
  adapterContext: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  return invokeRecordCapability('mapOpenaiChatToChatJson', [payload ?? {}, adapterContext ?? {}]);
}

export function mapOpenaiChatFromChatWithNative(
  chatEnvelope: Record<string, unknown> | null | undefined,
  adapterContext: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  return invokeRecordCapability('mapOpenaiChatFromChatJson', [chatEnvelope ?? {}, adapterContext ?? {}]);
}

export function augmentApplyPatchErrorContentWithNative(
  content: string,
  toolName?: string
): string {
  return invokeStringCapability('augmentApplyPatchErrorContentJson', [
    content ?? '',
    typeof toolName === 'string' ? toolName : ''
  ]);
}

export function buildSubmitToolOutputsPayloadWithNative(input: {
  chatEnvelope: Record<string, unknown>;
  adapterContext: Record<string, unknown>;
  responsesContext: Record<string, unknown>;
}): Record<string, unknown> {
  return invokeRecordCapability('buildSubmitToolOutputsPayloadJson', [input]);
}

export function resolveHeartbeatDirectiveWithNative(input: {
  messages: unknown;
  metadata: Record<string, unknown>;
}): Record<string, unknown> {
  return invokeRecordCapability('resolveHeartbeatDirectiveJson', [input]);
}

export function extractToolSignaturesFromPayloadWithNative(payload: unknown): string[] {
  const raw = invokeStringCapability('extractToolSignaturesFromPayloadJson', [safeStringify(payload) ?? '{}']);
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function hasNewGovernedServerToolCallsWithNative(beforePayload: unknown, afterPayload: unknown): boolean {
  const raw = invokeStringCapability('hasNewGovernedServerToolCallsJson', [
    safeStringify(beforePayload) ?? '{}',
    safeStringify(afterPayload) ?? '{}'
  ]);
  try {
    return JSON.parse(raw) === true;
  } catch {
    return false;
  }
}

export function responsesPayloadRequiresSubmitToolOutputsWithNative(payload: unknown): boolean {
  const raw = invokeStringCapability('responsesPayloadRequiresSubmitToolOutputsJson', [safeStringify(payload) ?? '{}']);
  try {
    return JSON.parse(raw) === true;
  } catch {
    return false;
  }
}
