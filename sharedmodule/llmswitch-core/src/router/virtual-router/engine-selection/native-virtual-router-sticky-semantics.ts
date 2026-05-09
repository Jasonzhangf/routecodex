import { failNativeRequired } from './native-router-hotpath-policy.js';
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

function parseStringValue(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'string') {
      return null;
    }
    const trimmed = parsed.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

export function resolveVirtualRouterStickyKeyWithNative(
  metadata: Record<string, unknown>
): string {
  const capability = 'resolveVirtualRouterStickyKeyJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(metadata ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseStringValue(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
