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

export function injectMcpToolsForChatWithNative(
  tools: unknown[] | undefined,
  discoveredServers: string[]
): unknown[] {
  const capability = 'injectMcpToolsForChatJson';
  const fail = (reason?: string) => failNativeRequired<unknown[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const toolsJson = safeStringify(Array.isArray(tools) ? tools : []);
  const serversJson = safeStringify(Array.isArray(discoveredServers) ? discoveredServers : []);
  if (!toolsJson || !serversJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(toolsJson, serversJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return Array.isArray(parsed) ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeArgsBySchemaWithNative(
  input: unknown,
  schema: unknown
): { ok: boolean; value?: Record<string, unknown>; errors?: string[] } {
  const capability = 'normalizeArgsBySchemaJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ ok: boolean; value?: Record<string, unknown>; errors?: string[] }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? null);
  const schemaJson = safeStringify(schema ?? null);
  if (!inputJson || !schemaJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson, schemaJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed || typeof parsed.ok !== 'boolean') {
      return fail('invalid payload');
    }
    const out: { ok: boolean; value?: Record<string, unknown>; errors?: string[] } = {
      ok: parsed.ok as boolean
    };
    if (parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) {
      out.value = parsed.value as Record<string, unknown>;
    }
    if (Array.isArray(parsed.errors)) {
      out.errors = parsed.errors.filter((entry): entry is string => typeof entry === 'string');
    }
    return out;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeOpenaiChatMessagesWithNative(messages: unknown): unknown[] {
  const capability = 'normalizeOpenaiChatMessagesJson';
  const fail = (reason?: string) => failNativeRequired<unknown[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(messages ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return Array.isArray(parsed) ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeOpenaiToolCallWithNative(
  toolCall: unknown,
  disableShellCoerce: boolean
): unknown {
  const capability = 'normalizeOpenaiToolCallJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(toolCall ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson, Boolean(disableShellCoerce));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return fail('invalid payload');
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function prepareGeminiToolsForBridgeWithNative(
  rawTools: unknown,
  missing: unknown[]
): { defs?: Array<Record<string, unknown>>; missing: Array<Record<string, unknown>> } {
  const capability = 'prepareGeminiToolsForBridgeJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ defs?: Array<Record<string, unknown>>; missing: Array<Record<string, unknown>> }>(
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
  const rawToolsJson = safeStringify(rawTools ?? null);
  const missingJson = safeStringify(Array.isArray(missing) ? missing : []);
  if (!rawToolsJson || !missingJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(rawToolsJson, missingJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    const defs = Array.isArray(parsed.defs)
      ? parsed.defs.filter(
          (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry)
        )
      : undefined;
    const nextMissing = Array.isArray(parsed.missing)
      ? parsed.missing.filter(
          (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry)
        )
      : [];
    return {
      ...(defs && defs.length ? { defs } : {}),
      missing: nextMissing
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildGeminiToolsFromBridgeWithNative(
  defs: unknown,
  mode: 'antigravity' | 'default' = 'default'
): Array<Record<string, unknown>> | undefined {
  const capability = 'buildGeminiToolsFromBridgeJson';
  const fail = (reason?: string) => failNativeRequired<Array<Record<string, unknown>> | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const defsJson = safeStringify(defs ?? null);
  if (!defsJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(defsJson, mode);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (parsed == null) {
      return undefined;
    }
    if (!Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    return parsed.filter(
      (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry)
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function injectMcpToolsForResponsesWithNative(
  tools: unknown[] | undefined,
  discoveredServers: string[]
): unknown[] {
  const capability = 'injectMcpToolsForResponsesJson';
  const fail = (reason?: string) => failNativeRequired<unknown[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const toolsJson = safeStringify(Array.isArray(tools) ? tools : []);
  const serversJson = safeStringify(Array.isArray(discoveredServers) ? discoveredServers : []);
  if (!toolsJson || !serversJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(toolsJson, serversJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return Array.isArray(parsed) ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
