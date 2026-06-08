import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import {
  parseJson,
  parseRecord,
  readNativeFunction,
  safeStringify
} from './native-shared-conversion-semantics-core.js';

export function encodeMetadataPassthroughWithNative(
  parameters: unknown,
  prefix: string,
  keys: readonly string[]
): Record<string, string> | undefined {
  const capability = 'encodeMetadataPassthroughJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, string> | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const parametersJson = safeStringify(parameters ?? null);
  const keysJson = safeStringify(Array.isArray(keys) ? keys : []);
  if (!parametersJson || !keysJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(parametersJson, String(prefix || ''), keysJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (parsed === null) {
      return undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof key !== 'string' || typeof value !== 'string') {
        return fail('invalid payload');
      }
      out[key] = value;
    }
    return Object.keys(out).length ? out : undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function extractMetadataPassthroughWithNative(
  metadataField: unknown,
  prefix: string,
  keys: readonly string[]
): {
  metadata?: Record<string, unknown>;
  passthrough?: Record<string, unknown>;
} {
  const capability = 'extractMetadataPassthroughJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ metadata?: Record<string, unknown>; passthrough?: Record<string, unknown> }>(
      capability,
      reason
    );
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const metadataJson = safeStringify(metadataField ?? null);
  const keysJson = safeStringify(Array.isArray(keys) ? keys : []);
  if (!metadataJson || !keysJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(metadataJson, String(prefix || ''), keysJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    const metadata =
      parsed.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata)
        ? (parsed.metadata as Record<string, unknown>)
        : undefined;
    const passthrough =
      parsed.passthrough && typeof parsed.passthrough === 'object' && !Array.isArray(parsed.passthrough)
        ? (parsed.passthrough as Record<string, unknown>)
        : undefined;
    return {
      ...(metadata ? { metadata } : {}),
      ...(passthrough ? { passthrough } : {})
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function ensureProtocolStateWithNative(
  metadata: Record<string, unknown>,
  protocol: string
): { metadata: Record<string, unknown>; node: Record<string, unknown> } {
  const capability = 'ensureProtocolStateJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ metadata: Record<string, unknown>; node: Record<string, unknown> }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const metadataJson = safeStringify(metadata ?? {});
  if (!metadataJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(metadataJson, String(protocol ?? ''));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    const metadataOut =
      parsed.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata)
        ? (parsed.metadata as Record<string, unknown>)
        : undefined;
    const nodeOut =
      parsed.node && typeof parsed.node === 'object' && !Array.isArray(parsed.node)
        ? (parsed.node as Record<string, unknown>)
        : undefined;
    if (!metadataOut || !nodeOut) {
      return fail('invalid payload');
    }
    return { metadata: metadataOut, node: nodeOut };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function getProtocolStateWithNative(
  metadata: Record<string, unknown> | undefined,
  protocol: string
): Record<string, unknown> | undefined {
  const capability = 'getProtocolStateJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const metadataJson = safeStringify(metadata ?? null);
  if (!metadataJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(metadataJson, String(protocol ?? ''));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (parsed === null) {
      return undefined;
    }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function readRuntimeMetadataWithNative(
  carrier: Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
  const capability = 'readRuntimeMetadataJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const carrierJson = safeStringify(carrier ?? null);
  if (!carrierJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(carrierJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (parsed === null) {
      return undefined;
    }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function ensureRuntimeMetadataCarrierWithNative(
  carrier: Record<string, unknown>
): Record<string, unknown> {
  const capability = 'ensureRuntimeMetadataJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const carrierJson = safeStringify(carrier);
  if (!carrierJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(carrierJson);
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

export function cloneRuntimeMetadataWithNative(
  carrier: Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
  const capability = 'cloneRuntimeMetadataJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const carrierJson = safeStringify(carrier ?? null);
  if (!carrierJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(carrierJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (parsed === null) {
      return undefined;
    }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
