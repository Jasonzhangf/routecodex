import { failNativeRequired, isNativeDisabledByEnv } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

type ApplyPatchToolMode = 'schema' | 'freeform';

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

function parseApplyPatchToolMode(raw: string): ApplyPatchToolMode | undefined | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) {
      return undefined;
    }
    if (typeof parsed !== 'string') {
      return null;
    }
    const mode = parsed.trim().toLowerCase();
    if (mode === 'schema' || mode === 'freeform') {
      return mode;
    }
    return null;
  } catch {
    return null;
  }
}

export function resolveApplyPatchToolModeFromToolsWithNative(
  toolsRaw: unknown
): ApplyPatchToolMode | undefined {
  const capability = 'resolveApplyPatchToolModeFromToolsJson';
  const fail = (reason?: string): ApplyPatchToolMode | undefined =>
    failNativeRequired<ApplyPatchToolMode | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const toolsJson = safeStringify(toolsRaw ?? null);
  if (!toolsJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(toolsJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseApplyPatchToolMode(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveApplyPatchToolModeFromEnvWithNative(): ApplyPatchToolMode | undefined {
  const capability = 'resolveApplyPatchToolModeFromEnvJson';
  const fail = (reason?: string): ApplyPatchToolMode | undefined =>
    failNativeRequired<ApplyPatchToolMode | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn();
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseApplyPatchToolMode(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
