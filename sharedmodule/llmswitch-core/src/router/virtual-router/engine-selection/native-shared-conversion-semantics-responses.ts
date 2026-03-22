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

function parseResponsesConversationResumeResult(
  raw: string
): { payload: Record<string, unknown>; meta: Record<string, unknown> } | null {
  const parsed = parseRecord(raw);
  if (!parsed) {
    return null;
  }
  const payload = parsed.payload;
  const meta = parsed.meta;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return null;
  }
  return {
    payload: payload as Record<string, unknown>,
    meta: meta as Record<string, unknown>
  };
}

export function pickResponsesPersistedFieldsWithNative(payload: unknown): Record<string, unknown> {
  const capability = 'pickResponsesPersistedFieldsJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
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

export function convertResponsesOutputToInputItemsWithNative(response: unknown): Array<Record<string, unknown>> {
  const capability = 'convertResponsesOutputToInputItemsJson';
  const fail = (reason?: string) => failNativeRequired<Array<Record<string, unknown>>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const responseJson = safeStringify(response ?? null);
  if (!responseJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(responseJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
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

export function prepareResponsesConversationEntryWithNative(
  payload: unknown,
  context: unknown
): {
  basePayload: Record<string, unknown>;
  input: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
} {
  const capability = 'prepareResponsesConversationEntryJson';
  const fail = (reason?: string) =>
    failNativeRequired<{
      basePayload: Record<string, unknown>;
      input: Array<Record<string, unknown>>;
      tools?: Array<Record<string, unknown>>;
    }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload ?? null);
  const contextJson = safeStringify(context ?? null);
  if (!payloadJson || !contextJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson, contextJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    const basePayload = parsed.basePayload;
    const input = parsed.input;
    const tools = parsed.tools;
    if (!basePayload || typeof basePayload !== 'object' || Array.isArray(basePayload) || !Array.isArray(input)) {
      return fail('invalid payload');
    }
    return {
      basePayload: basePayload as Record<string, unknown>,
      input: input.filter(
        (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry)
      ),
      tools: Array.isArray(tools)
        ? tools.filter(
            (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry)
          )
        : undefined
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resumeResponsesConversationPayloadWithNative(
  entry: unknown,
  responseId: string,
  submitPayload: unknown,
  requestId?: string
): { payload: Record<string, unknown>; meta: Record<string, unknown> } {
  const capability = 'resumeResponsesConversationPayloadJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ payload: Record<string, unknown>; meta: Record<string, unknown> }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const entryJson = safeStringify(entry ?? null);
  const submitPayloadJson = safeStringify(submitPayload ?? null);
  if (!entryJson || !submitPayloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(entryJson, String(responseId ?? ''), submitPayloadJson, requestId);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseResponsesConversationResumeResult(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function enforceChatBudgetWithNative(
  chat: unknown,
  allowedBytes: number,
  systemTextLimit: number
): unknown {
  const capability = 'enforceChatBudgetJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const chatJson = safeStringify(chat ?? null);
  if (!chatJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(chatJson, Number(allowedBytes), Number(systemTextLimit));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveBudgetForModelWithNative(
  modelId: string,
  fallback: { maxBytes: number; safetyRatio: number; allowedBytes: number; source: string } | null | undefined
): { maxBytes: number; safetyRatio: number; allowedBytes: number; source: string } {
  const capability = 'resolveBudgetForModelJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ maxBytes: number; safetyRatio: number; allowedBytes: number; source: string }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const fallbackJson = safeStringify(fallback ?? null);
  if (!fallbackJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(String(modelId ?? ''), fallbackJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    const maxBytes = Number(parsed.maxBytes);
    const safetyRatio = Number(parsed.safetyRatio);
    const allowedBytes = Number(parsed.allowedBytes);
    const source = typeof parsed.source === 'string' ? parsed.source : 'unknown';
    if (!Number.isFinite(maxBytes) || !Number.isFinite(safetyRatio) || !Number.isFinite(allowedBytes)) {
      return fail('invalid payload');
    }
    return { maxBytes, safetyRatio, allowedBytes, source };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
