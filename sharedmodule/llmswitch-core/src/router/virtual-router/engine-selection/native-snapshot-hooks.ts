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

function parseBoolean(raw: string): boolean | null {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'boolean' ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonValue(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function shouldRecordSnapshotsWithNative(): boolean {
  const capability = 'shouldRecordSnapshotsJson';
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
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
    const parsed = parseBoolean(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function writeSnapshotViaHooksWithNative(options: Record<string, unknown>): void {
  const capability = 'writeSnapshotViaHooksJson';
  const fail = (reason?: string) => failNativeRequired<void>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(options ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    fn(payloadJson);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeSnapshotStagePayloadWithNative(stage: string, payload: unknown): unknown {
  if (payload === undefined || payload === null) {
    return null;
  }
  const capability = 'normalizeSnapshotStagePayloadJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload);
  if (!payloadJson) {
    // Preserve non-JSON payloads (e.g. circular structures).
    return payload;
  }
  const stageToken = typeof stage === 'string' ? stage : '';
  try {
    const raw = fn(stageToken, payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJsonValue(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
