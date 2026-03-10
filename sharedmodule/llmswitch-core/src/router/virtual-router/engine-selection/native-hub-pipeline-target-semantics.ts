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

function parseStringOrNull(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) {
      return null;
    }
    if (typeof parsed !== 'string') {
      return null;
    }
    const normalized = parsed.trim();
    return normalized.length ? normalized : null;
  } catch {
    return null;
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

export function extractTargetModelIdWithNative(target: unknown): string | null {
  const capability = 'extractTargetModelIdJson';
  const fail = (reason?: string) => failNativeRequired<string | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('extractTargetModelIdJson');
  if (!fn) {
    return fail();
  }
  const targetJson = safeStringify(target ?? null);
  if (!targetJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(targetJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseStringOrNull(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyTargetMetadataWithNative(
  metadata: Record<string, unknown>,
  target: unknown,
  routeName?: string,
  originalModel?: string
): Record<string, unknown> {
  const capability = 'applyTargetMetadataJson';
  const fail = (reason?: string): Record<string, unknown> =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const metadataJson = safeStringify(metadata ?? {});
  const targetJson = safeStringify(target ?? null);
  const routeNameJson = safeStringify(routeName ?? null);
  const originalModelJson = safeStringify(originalModel ?? null);
  if (!metadataJson || !targetJson || !routeNameJson || !originalModelJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(metadataJson, targetJson, routeNameJson, originalModelJson);
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

export function applyTargetToSubjectWithNative(
  subject: Record<string, unknown>,
  target: unknown,
  originalModel?: string
): Record<string, unknown> {
  const capability = 'applyTargetToSubjectJson';
  const fail = (reason?: string): Record<string, unknown> =>
    failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const subjectJson = safeStringify(subject ?? {});
  const targetJson = safeStringify(target ?? null);
  const originalModelJson = safeStringify(originalModel ?? null);
  if (!subjectJson || !targetJson || !originalModelJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(subjectJson, targetJson, originalModelJson);
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
