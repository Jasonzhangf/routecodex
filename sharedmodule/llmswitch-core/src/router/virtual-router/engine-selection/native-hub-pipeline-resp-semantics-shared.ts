import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

export { isNativeDisabledByEnv };

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

export function failNative<T>(capability: string, reason?: string): T {
  return failNativeRequired<T>(capability, reason);
}

export function extractNativeErrorMessage(raw: unknown): string {
  if (raw instanceof Error) {
    return raw.message;
  }
  if (raw && typeof raw === 'object' && 'message' in (raw as Record<string, unknown>)) {
    const candidate = (raw as Record<string, unknown>).message;
    return typeof candidate === 'string' ? candidate : '';
  }
  return '';
}
