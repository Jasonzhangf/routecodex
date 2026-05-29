import type { RouterMetadataInput } from '../../types.js';
import { failNativeRequired } from '../../engine-selection/native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from '../../engine-selection/native-router-hotpath.js';

function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
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

export function resolveRoutingStateKey(metadata: RouterMetadataInput): string {
  const capability = 'resolveVirtualRouterRoutingStateKeyJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify((metadata ?? null) as unknown);
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseStringValue(raw) ?? fail('invalid payload');
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error ?? 'unknown'));
  }
}
