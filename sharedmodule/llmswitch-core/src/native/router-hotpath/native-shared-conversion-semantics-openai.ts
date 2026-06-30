import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import {
  parseRecord,
  readNativeFunction,
  safeStringify
} from './native-shared-conversion-semantics-core.js';

export function normalizeMessageContentPartsWithNative(
  parts: unknown,
  reasoningCollector: string[]
): { normalizedParts: Array<Record<string, unknown>>; reasoningChunks: string[] } {
  const capability = 'normalizeMessageContentPartsJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ normalizedParts: Array<Record<string, unknown>>; reasoningChunks: string[] }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const partsJson = safeStringify(parts ?? null);
  const collectorJson = safeStringify(Array.isArray(reasoningCollector) ? reasoningCollector : []);
  if (!partsJson || !collectorJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(partsJson, collectorJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    const normalizedParts = Array.isArray(parsed.normalizedParts)
      ? parsed.normalizedParts.filter(
          (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry)
        )
      : [];
    const reasoningChunks = Array.isArray(parsed.reasoningChunks)
      ? parsed.reasoningChunks.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return { normalizedParts, reasoningChunks };
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error ?? 'unknown'));
  }
}

function parseRecordArray(raw: string): Array<Record<string, unknown>> | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    const rows: Array<Record<string, unknown>> = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }
      rows.push(entry as Record<string, unknown>);
    }
    return rows;
  } catch {
    return null;
  }
}

function throwNativeReturnedError(raw: unknown): void {
  if (raw instanceof Error) {
    throw raw;
  }
  if (raw && typeof raw === 'object' && 'message' in raw) {
    const message = (raw as { message?: unknown }).message;
    if (typeof message === 'string' && message) {
      throw new Error(message);
    }
  }
}

export function normalizeResponsesMessageItemWithNative(
  item: unknown,
  options: unknown
): { message: Record<string, unknown>; reasoning?: Record<string, unknown> } {
  const capability = 'normalizeResponsesMessageItemJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ message: Record<string, unknown>; reasoning?: Record<string, unknown> }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const itemJson = safeStringify(item ?? null);
  const optionsJson = safeStringify(options ?? {});
  if (!itemJson || !optionsJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(itemJson, optionsJson);
    throwNativeReturnedError(raw);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed || !parsed.message || typeof parsed.message !== 'object' || Array.isArray(parsed.message)) {
      return fail('invalid payload');
    }
    const output: { message: Record<string, unknown>; reasoning?: Record<string, unknown> } = {
      message: parsed.message as Record<string, unknown>
    };
    if (parsed.reasoning && typeof parsed.reasoning === 'object' && !Array.isArray(parsed.reasoning)) {
      output.reasoning = parsed.reasoning as Record<string, unknown>;
    }
    return output;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error ?? 'unknown'));
  }
}

export function expandResponsesMessageItemWithNative(
  item: unknown,
  options: unknown
): Array<Record<string, unknown>> {
  const capability = 'expandResponsesMessageItemJson';
  const fail = (reason?: string) =>
    failNativeRequired<Array<Record<string, unknown>>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const itemJson = safeStringify(item ?? null);
  const optionsJson = safeStringify(options ?? {});
  if (!itemJson || !optionsJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(itemJson, optionsJson);
    throwNativeReturnedError(raw);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecordArray(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    return parsed;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error ?? 'unknown'));
  }
}

export function normalizeResponsesOutputItemsWithNative(
  output: unknown
): Array<Record<string, unknown>> {
  const capability = 'normalizeResponsesOutputItemsJson';
  const fail = (reason?: string) =>
    failNativeRequired<Array<Record<string, unknown>>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const outputJson = safeStringify(output ?? null);
  if (!outputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(outputJson);
    throwNativeReturnedError(raw);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecordArray(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    return parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeChatMessageContentWithNative(
  content: unknown
): { contentText?: string; reasoningText?: string } {
  const capability = 'normalizeChatMessageContentJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ contentText?: string; reasoningText?: string }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(content ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    const contentText = typeof parsed.contentText === 'string' ? parsed.contentText : undefined;
    const reasoningText = typeof parsed.reasoningText === 'string' ? parsed.reasoningText : undefined;
    return {
      ...(contentText ? { contentText } : {}),
      ...(reasoningText ? { reasoningText } : {})
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeOpenaiMessageWithNative(
  message: unknown,
  disableShellCoerce: boolean
): unknown {
  const capability = 'normalizeOpenaiMessageJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(message ?? null);
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

export function normalizeOpenaiToolWithNative(tool: unknown): unknown {
  const capability = 'normalizeOpenaiToolJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(tool ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
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
