import { parseChatProcessMediaStripPayload } from './native-router-hotpath-analysis.js';
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

function parseNullableResponsesConversationResumeResult(
  raw: string
): { payload: Record<string, unknown>; meta: Record<string, unknown> } | null {
  const parsed = parseJson(raw);
  if (parsed === null) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  const payload = row.payload;
  const meta = row.meta;
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

type ResponsesConversationClientError = Error & {
  status: number;
  code: string;
  origin: 'client';
};

function makeResponsesConversationClientError(message: string): ResponsesConversationClientError {
  const normalized = message.trim() || 'Responses conversation tool result is invalid';
  const error = new Error(`orphan_tool_result: ${normalized}`) as ResponsesConversationClientError;
  error.status = 400;
  error.code = 'hub_pipeline_context_capture_failed';
  error.origin = 'client';
  return error;
}

function readResponsesConversationClientError(parsed: Record<string, unknown>): ResponsesConversationClientError | null {
  const error = parsed.error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) {
    return null;
  }
  const row = error as Record<string, unknown>;
  const type = typeof row.type === 'string' ? row.type : '';
  const origin = typeof row.origin === 'string' ? row.origin : '';
  if (type !== 'orphan_tool_result' && origin !== 'client') {
    return null;
  }
  const message = typeof row.message === 'string' ? row.message : 'Responses conversation tool result is invalid';
  const clientError = makeResponsesConversationClientError(message);
  if (typeof row.status === 'number' && Number.isFinite(row.status)) {
    clientError.status = row.status;
  }
  if (typeof row.code === 'string' && row.code.trim()) {
    clientError.code = row.code.trim();
  }
  return clientError;
}

function isResponsesConversationToolResultError(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return normalized.includes('does not match any pending function_call')
    || normalized.includes('missing tool_call_id/call_id')
    || normalized.includes('orphan_tool_result');
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
    if (isResponsesConversationToolResultError(reason)) {
      throw makeResponsesConversationClientError(reason);
    }
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
    if (!parsed) {
      const row = parseRecord(raw);
      const clientError = row ? readResponsesConversationClientError(row) : null;
      if (clientError) {
        throw clientError;
      }
    }
    return parsed ?? fail('invalid payload');
  } catch (error) {
    if (error && typeof error === 'object' && (error as { origin?: unknown }).origin === 'client') {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    if (isResponsesConversationToolResultError(reason)) {
      throw makeResponsesConversationClientError(reason);
    }
    return fail(reason);
  }
}

export function restoreResponsesContinuationPayloadWithNative(
  entry: unknown,
  incomingPayload: unknown,
  requestId?: string,
  scopeKey?: string
): { payload: Record<string, unknown>; meta: Record<string, unknown> } | null {
  const capability = 'restoreResponsesContinuationPayloadJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ payload: Record<string, unknown>; meta: Record<string, unknown> } | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const entryJson = safeStringify(entry ?? null);
  const incomingPayloadJson = safeStringify(incomingPayload ?? null);
  if (!entryJson || !incomingPayloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(entryJson, incomingPayloadJson, requestId, scopeKey);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseNullableResponsesConversationResumeResult(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function materializeResponsesContinuationPayloadWithNative(
  entry: unknown,
  incomingPayload: unknown,
  requestId?: string,
  scopeKey?: string
): { payload: Record<string, unknown>; meta: Record<string, unknown> } | null {
  const capability = 'materializeResponsesContinuationPayloadJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ payload: Record<string, unknown>; meta: Record<string, unknown> } | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const entryJson = safeStringify(entry ?? null);
  const incomingPayloadJson = safeStringify(incomingPayload ?? null);
  if (!entryJson || !incomingPayloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(entryJson, incomingPayloadJson, requestId, scopeKey);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseNullableResponsesConversationResumeResult(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function stripResponsesStoredContextInputMediaWithNative(
  inputEntries: unknown,
  placeholderText = '[Image omitted]'
): { changed: boolean; messages: unknown[] } {
  const capability = 'stripResponsesStoredContextInputMediaJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ changed: boolean; messages: unknown[] }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputEntriesJson = safeStringify(inputEntries ?? []);
  if (!inputEntriesJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputEntriesJson, String(placeholderText || '[Image omitted]'));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseChatProcessMediaStripPayload(raw) ?? fail('invalid payload');
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

export function planResponsesHandlerEntryWithNative(
  payload: unknown,
  entryEndpoint?: string,
  responseIdFromPath?: string
): { mode: 'none' | 'submit_tool_outputs' | 'scope_materialize'; responseId?: string; payload: Record<string, unknown> } {
  const capability = 'planResponsesHandlerEntryJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ mode: 'none' | 'submit_tool_outputs' | 'scope_materialize'; responseId?: string; payload: Record<string, unknown> }>(capability, reason);
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
    const raw = fn(payloadJson, entryEndpoint, responseIdFromPath);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed || typeof parsed.mode !== 'string') {
      return fail('invalid payload');
    }
    const plannedPayload = parsed.payload;
    if (!plannedPayload || typeof plannedPayload !== 'object' || Array.isArray(plannedPayload)) {
      return fail('invalid payload');
    }
    if (parsed.mode !== 'none' && parsed.mode !== 'submit_tool_outputs' && parsed.mode !== 'scope_materialize') {
      return fail('invalid mode');
    }
    return {
      mode: parsed.mode,
      ...(typeof parsed.responseId === 'string' && parsed.responseId.trim() ? { responseId: parsed.responseId } : {}),
      payload: plannedPayload as Record<string, unknown>
    };
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
