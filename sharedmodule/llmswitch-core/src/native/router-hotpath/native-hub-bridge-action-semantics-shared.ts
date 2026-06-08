import { failNativeRequired } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

export function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}

export function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}


export function stringifyNativePayloadForError(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length ? trimmed : undefined;
  }
  if (raw instanceof Error) {
    const message = typeof raw.message === 'string' ? raw.message.trim() : '';
    if (message.length) {
      return message;
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const row = raw as Record<string, unknown>;
    const message = typeof row.message === 'string' ? row.message.trim() : '';
    if (message.length) {
      return message;
    }
    const code = typeof row.code === 'string' ? row.code.trim() : '';
    if (code.length) {
      return code;
    }
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

export function readNativeJsonResult(capability: string, raw: unknown): string {
  if (typeof raw === 'string') {
    if (!raw) {
      return failNativeRequired<string>(capability, 'empty result');
    }
    return raw;
  }
  const reason = stringifyNativePayloadForError(raw);
  if (reason) {
    throw new Error(reason);
  }
  return failNativeRequired<string>(capability, 'empty result');
}

export function shouldRethrowNativeRawError(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }
  return !error.message.startsWith('[virtual-router-native-hotpath] native ');
}

export function parseNativeResultOrFail<T>(capability: string, raw: string, parse: (value: string) => T | null): T {
  const parsed = parse(raw);
  if (parsed) {
    return parsed;
  }
  const trimmed = raw.trim();
  if (trimmed && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    throw new Error(trimmed);
  }
  return failNativeRequired<T>(capability, 'invalid payload');
}
