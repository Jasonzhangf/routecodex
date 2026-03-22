import { failNativeRequired, isNativeDisabledByEnv } from './native-router-hotpath-policy.js';
import { parseJson, readNativeFunction, safeStringify } from './native-shared-conversion-semantics-core.js';

function parseToolDefinitionOutput(raw: string): Record<string, unknown> | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function parseToolDefinitionArray(raw: string): Array<Record<string, unknown>> | null {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) {
    return null;
  }
  return parsed.filter((entry): entry is Record<string, unknown> =>
    Boolean(entry && typeof entry === 'object' && !Array.isArray(entry))
  );
}

export function bridgeToolToChatDefinitionWithNative(
  tool: Record<string, unknown>,
  options?: { sanitizeMode?: string }
): Record<string, unknown> | null {
  const capability = 'bridgeToolToChatDefinitionJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ tool, options: options ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseToolDefinitionOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function chatToolToBridgeDefinitionWithNative(
  tool: Record<string, unknown>,
  options?: { sanitizeMode?: string }
): Record<string, unknown> | null {
  const capability = 'chatToolToBridgeDefinitionJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ tool, options: options ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseToolDefinitionOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function mapBridgeToolsToChatWithNative(
  rawTools: unknown,
  options?: { sanitizeMode?: string }
): Array<Record<string, unknown>> {
  const capability = 'mapBridgeToolsToChatWithOptionsJson';
  const fail = (reason?: string) => failNativeRequired<Array<Record<string, unknown>>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ tools: Array.isArray(rawTools) ? rawTools : [], options: options ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseToolDefinitionArray(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function mapChatToolsToBridgeWithNative(
  rawTools: unknown,
  options?: { sanitizeMode?: string }
): Array<Record<string, unknown>> {
  const capability = 'mapChatToolsToBridgeWithOptionsJson';
  const fail = (reason?: string) => failNativeRequired<Array<Record<string, unknown>>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ tools: Array.isArray(rawTools) ? rawTools : [], options: options ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseToolDefinitionArray(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function collectToolCallsFromResponsesWithNative(
  response: Record<string, unknown>
): Array<Record<string, unknown>> {
  const capability = 'collectToolCallsFromResponsesJson';
  const fail = (reason?: string) => failNativeRequired<Array<Record<string, unknown>>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(response ?? {});
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseToolDefinitionArray(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
