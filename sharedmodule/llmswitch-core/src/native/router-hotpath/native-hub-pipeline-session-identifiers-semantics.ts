import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-loader.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

export interface NativeSessionIdentifiersOutput {
  sessionId?: string;
  conversationId?: string;
}

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
