import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

export interface NativeSessionIdentifiersOutput {
  sessionId?: string;
  conversationId?: string;
}

type NativeHeaderMap = Record<string, string>;

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

function parseSessionIdentifiers(raw: string): NativeSessionIdentifiersOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const out: NativeSessionIdentifiersOutput = {};

    const sessionId = typeof row.sessionId === 'string' ? row.sessionId.trim() : '';
    const conversationId = typeof row.conversationId === 'string' ? row.conversationId.trim() : '';

    if (sessionId) {
      out.sessionId = sessionId;
    }
    if (conversationId) {
      out.conversationId = conversationId;
    }
    return out;
  } catch {
    return null;
  }
}

function parseOptionalString(raw: string): string | undefined | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) {
      return undefined;
    }
    if (typeof parsed !== 'string') {
      return null;
    }
    const normalized = parsed.trim();
    return normalized ? normalized : undefined;
  } catch {
    return null;
  }
}

function parseHeaderMap(raw: string): NativeHeaderMap | undefined | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) {
      return undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const out: NativeHeaderMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof key !== 'string' || !key || typeof value !== 'string') {
        return null;
      }
      out[key] = value;
    }
    return Object.keys(out).length ? out : undefined;
  } catch {
    return null;
  }
}

export function extractSessionIdentifiersFromMetadataWithNative(
  metadata: Record<string, unknown> | undefined
): NativeSessionIdentifiersOutput {
  const capability = 'extractSessionIdentifiersJson';
  const fail = (reason?: string) => failNativeRequired<NativeSessionIdentifiersOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('extractSessionIdentifiersJson');
  if (!fn) {
    return fail();
  }
  const metadataJson = safeStringify(metadata ?? null);
  if (!metadataJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(metadataJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseSessionIdentifiers(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function coerceClientHeadersWithNative(raw: unknown): NativeHeaderMap | undefined {
  const capability = 'coerceClientHeadersJson';
  const fail = (reason?: string): NativeHeaderMap | undefined =>
    failNativeRequired<NativeHeaderMap | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const rawJson = safeStringify(raw ?? null);
  if (!rawJson) {
    return fail('json stringify failed');
  }
  try {
    const result = fn(rawJson);
    if (typeof result !== 'string' || !result) {
      return fail('empty result');
    }
    const parsed = parseHeaderMap(result);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function findHeaderValueWithNative(
  headers: Record<string, string>,
  target: string
): string | undefined {
  const capability = 'findHeaderValueJson';
  const fail = (reason?: string): string | undefined =>
    failNativeRequired<string | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const headersJson = safeStringify(headers ?? {});
  if (!headersJson) {
    return fail('json stringify failed');
  }
  try {
    const result = fn(headersJson, String(target ?? ''));
    if (typeof result !== 'string' || !result) {
      return fail('empty result');
    }
    const parsed = parseOptionalString(result);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function pickHeaderWithNative(
  headers: Record<string, string>,
  candidates: string[]
): string | undefined {
  const capability = 'pickHeaderJson';
  const fail = (reason?: string): string | undefined =>
    failNativeRequired<string | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const headersJson = safeStringify(headers ?? {});
  const candidatesJson = safeStringify(Array.isArray(candidates) ? candidates : []);
  if (!headersJson || !candidatesJson) {
    return fail('json stringify failed');
  }
  try {
    const result = fn(headersJson, candidatesJson);
    if (typeof result !== 'string' || !result) {
      return fail('empty result');
    }
    const parsed = parseOptionalString(result);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeHeaderKeyWithNative(value: string): string {
  const capability = 'normalizeHeaderKeyJson';
  const fail = (reason?: string): string => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const result = fn(String(value ?? ''));
    if (typeof result !== 'string' || !result) {
      return fail('empty result');
    }
    const parsed = parseOptionalString(result);
    return parsed === null ? fail('invalid payload') : (parsed ?? '');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
