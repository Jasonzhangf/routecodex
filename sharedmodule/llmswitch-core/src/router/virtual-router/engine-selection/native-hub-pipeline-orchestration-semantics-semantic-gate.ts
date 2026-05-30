import { failNativeRequired, isNativeDisabledByEnv } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

function readNativeFunction(name: string): ((...args: string[]) => string) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null | undefined;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: string[]) => string) : null;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function parseStringArray(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.every((entry) => typeof entry === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

export function findMappableSemanticsKeysWithNative(metadata: unknown): string[] {
  const capability = 'findMappableSemanticsKeysJson';
  const fail = (reason?: string): string[] => failNativeRequired<string[]>(capability, reason);
  if (isNativeDisabledByEnv()) return fail('native disabled');
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const metadataJson = safeStringify(metadata ?? null);
  if (!metadataJson) return fail('json stringify failed');
  try {
    const raw = fn(metadataJson);
    if (typeof raw !== 'string' || !raw) return fail('empty result');
    return parseStringArray(raw) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
