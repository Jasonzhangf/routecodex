import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-loader.js';
import {
  parseArray,
  parseJson,
  parseRecord,
  readNativeFunction,
  safeStringify
} from './native-router-hotpath-loader.js';

function parseChatProcessMediaStripPayload(raw: string): { changed: boolean; messages: unknown[] } | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  if (typeof row.changed !== 'boolean' || !Array.isArray(row.messages)) {
    return null;
  }
  return {
    changed: row.changed,
    messages: row.messages
  };
}

export function buildChatResponseFromResponsesWithNative(payload: unknown): Record<string, unknown> | null {
  const capability = 'buildChatResponseFromResponsesJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | null>(capability, reason);
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
    return parseRecord(raw) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildChatResponseFromResponsesFullWithNative(input: { payload: string }): string {
  const capability = 'buildChatResponseFromResponsesFullJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return raw;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

// Inlined from retired native-shared-conversion-semantics-call-id.ts
export function normalizeFunctionCallIdWithNative(input: {
  callId?: string;
  fallback?: string;
}): string {
  const capability = 'normalizeFunctionCallIdJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? {});
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    return typeof raw === 'string' && raw ? raw : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeFunctionCallOutputIdWithNative(input: {
  callId?: string;
  fallback?: string;
}): string {
  const capability = 'normalizeFunctionCallOutputIdJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? {});
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    return typeof raw === 'string' && raw ? raw : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeResponsesCallIdWithNative(input: {
  callId?: string;
  fallback?: string;
}): string {
  const capability = 'normalizeResponsesCallIdJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? {});
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    return typeof raw === 'string' && raw ? raw : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function clampResponsesInputItemIdWithNative(rawValue: unknown): string | undefined {
  const capability = 'clampResponsesInputItemIdJson';
  const fail = (reason?: string) => failNativeRequired<string | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const rawJson = safeStringify(rawValue ?? null);
  if (!rawJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(rawJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (parsed === null) {
      return undefined;
    }
    return typeof parsed === 'string' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}


// Inlined from retired native-shared-conversion-semantics-metadata.ts
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


export {
  captureReqInboundResponsesContextSnapshotWithNative
} from './req-inbound-direct-native.js';

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

type ScopeContinuationMatchPlan = {
  action: 'none' | 'restore' | 'materialize';
  reason: string;
  scopeKey?: string;
  dedupeKey?: string;
  requestId?: string;
  lastResponseId?: string;
  matchCount?: number;
};

type ResumeEntryMatchPlan = {
  action: 'none' | 'select' | 'ambiguous';
  reason: string;
  source?: 'response_index' | 'request_map' | 'scope';
  requestId?: string;
  lastResponseId?: string;
  scopeKey?: string;
  matchCount?: number;
};

type ContinuationLookupPlan = {
  action: 'none' | 'select';
  reason: string;
  responseId?: string;
  providerKey?: string;
  continuationOwner?: 'direct' | 'relay';
  entryKind?: 'responses' | 'chat' | 'messages';
  requestId?: string;
};

type PersistenceEligibilityPlan = {
  action: 'persist' | 'skip';
  reason: string;
  lastResponseId?: string;
};

type PersistedEntryPlan = {
  action: 'entry' | 'skip';
  reason: string;
  entry?: Record<string, unknown>;
};

type StoreTokensPlan = {
  providerKey?: string;
  sessionId?: string;
  conversationId?: string;
  entryKind: 'responses' | 'chat' | 'messages';
  continuationOwner?: 'direct' | 'relay';
};

type CapturedEntryPlan = {
  action: 'entry' | 'skip';
  reason: string;
  entry?: Record<string, unknown>;
};

type ConversationPreflightPlan = {
  action: 'continue' | 'skip' | 'throw';
  reason: string;
  code?: string;
  requestId?: string;
  responseId?: string;
  toolOutputCount?: number;
};

type ContinuationMetaPlan = {
  action: 'meta';
  reason: string;
  meta: Record<string, unknown>;
};

type CapturePendingCleanupPlan = {
  action: 'noop' | 'detach';
  reason: string;
  detachRequestIds: string[];
};

type RecordScopeCleanupPlan = {
  action: 'noop' | 'detach';
  reason: string;
  detachRequestIds: string[];
};

type RecordContinuationFlagPlan = {
  allowContinuation: boolean;
  reason: string;
  pendingToolCallCount: number;
};

type RecordScopeEntryMatchPlan = {
  action: 'none' | 'select';
  reason: string;
  scopeKey?: string;
  requestId?: string;
};

type StoreSweepPlan = {
  action: 'noop' | 'detach';
  reason: string;
  detachRequestIds: string[];
};

type AttachEntryScopesPlan = {
  action: 'noop' | 'attach' | 'detach_and_attach';
  reason: string;
  scopeKeys: string[];
  detachRequestIds: string[];
};

type RebindRequestIdPlan = {
  action: 'noop' | 'rebind';
  reason: string;
  oldId?: string;
  newId?: string;
};

type ReleaseRequestPayloadPlan = {
  basePayload: Record<string, unknown>;
  releasedInputPrefix: unknown[];
  releasedPendingToolCallIds: string[];
  input: unknown[];
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

export function buildResponsesConversationScopePlanWithNative(input: unknown): {
  keys: string[];
  portScopeKey?: string;
} {
  const capability = 'buildResponsesConversationScopePlanJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ keys: string[]; portScopeKey?: string }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? null);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed || !Array.isArray(parsed.keys)) {
      return fail('invalid payload');
    }
    const keys = parsed.keys.filter((key): key is string => typeof key === 'string' && key.trim().length > 0);
    return {
      keys,
      ...(typeof parsed.portScopeKey === 'string' && parsed.portScopeKey.trim()
        ? { portScopeKey: parsed.portScopeKey.trim() }
        : {})
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function collectResponsesPendingToolCallIdsWithNative(input: unknown): string[] {
  const capability = 'collectResponsesPendingToolCallIdsJson';
  const fail = (reason?: string) => failNativeRequired<string[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? []);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (!Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planResponsesConversationRetentionWithNative(
  entry: unknown,
  options: unknown
): { action: 'noop' | 'clear' | 'release'; reason: string; lastResponseId?: string } {
  const capability = 'planResponsesConversationRetentionJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ action: 'noop' | 'clear' | 'release'; reason: string; lastResponseId?: string }>(
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
  const entryJson = safeStringify(entry ?? null);
  const optionsJson = safeStringify(options ?? null);
  if (!entryJson || !optionsJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(entryJson, optionsJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    const action = parsed?.action;
    const reason = parsed?.reason;
    if (
      (action !== 'noop' && action !== 'clear' && action !== 'release') ||
      typeof reason !== 'string' ||
      !reason.trim()
    ) {
      return fail('invalid payload');
    }
    return {
      action,
      reason: reason.trim(),
      ...(typeof parsed?.lastResponseId === 'string' && parsed.lastResponseId.trim()
        ? { lastResponseId: parsed.lastResponseId.trim() }
        : {})
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planResponsesConversationPersistenceEligibilityWithNative(
  entry: unknown,
  options: unknown
): PersistenceEligibilityPlan {
  const capability = 'planResponsesConversationPersistenceEligibilityJson';
  const fail = (reason?: string) => failNativeRequired<PersistenceEligibilityPlan>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const entryJson = safeStringify(entry ?? null);
  const optionsJson = safeStringify(options ?? null);
  if (!entryJson || !optionsJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(entryJson, optionsJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    const action = parsed?.action;
    const reason = parsed?.reason;
    if ((action !== 'persist' && action !== 'skip') || typeof reason !== 'string' || !reason.trim()) {
      return fail('invalid payload');
    }
    return {
      action,
      reason: reason.trim(),
      ...(typeof parsed?.lastResponseId === 'string' && parsed.lastResponseId.trim()
        ? { lastResponseId: parsed.lastResponseId.trim() }
        : {})
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planResponsesPersistedEntryWithNative(input: unknown): PersistedEntryPlan {
  const capability = 'planResponsesPersistedEntryJson';
  const fail = (reason?: string) => failNativeRequired<PersistedEntryPlan>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? null);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    const action = parsed?.action;
    const reason = parsed?.reason;
    if ((action !== 'entry' && action !== 'skip') || typeof reason !== 'string' || !reason.trim()) {
      return fail('invalid payload');
    }
    if (action === 'entry') {
      const entry = parsed?.entry;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return fail('invalid entry');
      }
      return {
        action,
        reason: reason.trim(),
        entry: entry as Record<string, unknown>
      };
    }
    return {
      action,
      reason: reason.trim()
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planResponsesStoreTokensWithNative(input: unknown): StoreTokensPlan {
  const capability = 'planResponsesStoreTokensJson';
  const fail = (reason?: string) => failNativeRequired<StoreTokensPlan>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? null);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    const entryKind = parsed?.entryKind;
    const continuationOwner = parsed?.continuationOwner;
    if (entryKind !== 'responses' && entryKind !== 'chat' && entryKind !== 'messages') {
      return fail('invalid entry kind');
    }
    return {
      ...(typeof parsed?.providerKey === 'string' && parsed.providerKey.trim()
        ? { providerKey: parsed.providerKey.trim() }
        : {}),
      ...(typeof parsed?.sessionId === 'string' && parsed.sessionId.trim()
        ? { sessionId: parsed.sessionId.trim() }
        : {}),
      ...(typeof parsed?.conversationId === 'string' && parsed.conversationId.trim()
        ? { conversationId: parsed.conversationId.trim() }
        : {}),
      entryKind,
      ...(continuationOwner === 'direct' || continuationOwner === 'relay' ? { continuationOwner } : {})
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planResponsesConversationPreflightWithNative(input: unknown): ConversationPreflightPlan {
  const capability = 'planResponsesConversationPreflightJson';
  const fail = (reason?: string) => failNativeRequired<ConversationPreflightPlan>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? null);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    const action = parsed?.action;
    const reason = parsed?.reason;
    if (
      (action !== 'continue' && action !== 'skip' && action !== 'throw') ||
      typeof reason !== 'string' ||
      !reason.trim()
    ) {
      return fail('invalid payload');
    }
    return {
      action,
      reason: reason.trim(),
      ...(typeof parsed?.code === 'string' && parsed.code.trim() ? { code: parsed.code.trim() } : {}),
      ...(typeof parsed?.requestId === 'string' && parsed.requestId.trim()
        ? { requestId: parsed.requestId.trim() }
        : {}),
      ...(typeof parsed?.responseId === 'string' && parsed.responseId.trim()
        ? { responseId: parsed.responseId.trim() }
        : {}),
      ...(typeof parsed?.toolOutputCount === 'number' && Number.isFinite(parsed.toolOutputCount)
        ? { toolOutputCount: parsed.toolOutputCount }
        : {})
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planResponsesCapturedEntryWithNative(input: unknown): CapturedEntryPlan {
  const capability = 'planResponsesCapturedEntryJson';
  const fail = (reason?: string) => failNativeRequired<CapturedEntryPlan>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? null);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed || (parsed.action !== 'entry' && parsed.action !== 'skip') || typeof parsed.reason !== 'string') {
      return fail('invalid payload');
    }
    const entry = parsed.entry;
    return {
      action: parsed.action,
      reason: parsed.reason,
      ...(entry && typeof entry === 'object' && !Array.isArray(entry)
        ? { entry: entry as Record<string, unknown> }
        : {})
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planResponsesCapturePendingCleanupWithNative(input: unknown): CapturePendingCleanupPlan {
  const capability = 'planResponsesCapturePendingCleanupJson';
  const fail = (reason?: string) => failNativeRequired<CapturePendingCleanupPlan>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? null);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    const action = parsed?.action;
    const reason = parsed?.reason;
    if ((action !== 'noop' && action !== 'detach') || typeof reason !== 'string' || !reason.trim()) {
      return fail('invalid payload');
    }
    return {
      action,
      reason: reason.trim(),
      detachRequestIds: Array.isArray(parsed?.detachRequestIds)
        ? parsed.detachRequestIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : []
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planResponsesRecordScopeCleanupWithNative(input: unknown): RecordScopeCleanupPlan {
  const capability = 'planResponsesRecordScopeCleanupJson';
  const fail = (reason?: string) => failNativeRequired<RecordScopeCleanupPlan>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? null);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    const action = parsed?.action;
    const reason = parsed?.reason;
    if ((action !== 'noop' && action !== 'detach') || typeof reason !== 'string' || !reason.trim()) {
      return fail('invalid payload');
    }
    return {
      action,
      reason: reason.trim(),
      detachRequestIds: Array.isArray(parsed?.detachRequestIds)
        ? parsed.detachRequestIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : []
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planResponsesRecordContinuationFlagWithNative(input: unknown): RecordContinuationFlagPlan {
  const capability = 'planResponsesRecordContinuationFlagJson';
  const fail = (reason?: string) => failNativeRequired<RecordContinuationFlagPlan>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? null);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    const reason = parsed?.reason;
    const pendingToolCallCount = parsed?.pendingToolCallCount;
    if (
      typeof parsed?.allowContinuation !== 'boolean' ||
      typeof reason !== 'string' ||
      !reason.trim() ||
      typeof pendingToolCallCount !== 'number' ||
      !Number.isFinite(pendingToolCallCount)
    ) {
      return fail('invalid payload');
    }
    return {
      allowContinuation: parsed.allowContinuation,
      reason: reason.trim(),
      pendingToolCallCount
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planResponsesRecordScopeEntryMatchWithNative(input: unknown): RecordScopeEntryMatchPlan {
  const capability = 'planResponsesRecordScopeEntryMatchJson';
  const fail = (reason?: string) => failNativeRequired<RecordScopeEntryMatchPlan>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? null);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    const action = parsed?.action;
    const reason = parsed?.reason;
    if ((action !== 'none' && action !== 'select') || typeof reason !== 'string' || !reason.trim()) {
      return fail('invalid payload');
    }
    return {
      action,
      reason: reason.trim(),
      ...(typeof parsed?.scopeKey === 'string' && parsed.scopeKey.trim()
        ? { scopeKey: parsed.scopeKey.trim() }
        : {}),
      ...(typeof parsed?.requestId === 'string' && parsed.requestId.trim()
        ? { requestId: parsed.requestId.trim() }
        : {})
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planResponsesStoreSweepWithNative(input: unknown): StoreSweepPlan {
  const capability = 'planResponsesStoreSweepJson';
  const fail = (reason?: string) => failNativeRequired<StoreSweepPlan>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? null);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    const action = parsed?.action;
    const reason = parsed?.reason;
    if ((action !== 'noop' && action !== 'detach') || typeof reason !== 'string' || !reason.trim()) {
      return fail('invalid payload');
    }
    return {
      action,
      reason: reason.trim(),
      detachRequestIds: Array.isArray(parsed?.detachRequestIds)
        ? parsed.detachRequestIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : []
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planResponsesAttachEntryScopesWithNative(input: unknown): AttachEntryScopesPlan {
  const capability = 'planResponsesAttachEntryScopesJson';
  const fail = (reason?: string) => failNativeRequired<AttachEntryScopesPlan>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? null);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    const action = parsed?.action;
    const reason = parsed?.reason;
    if (
      (action !== 'noop' && action !== 'attach' && action !== 'detach_and_attach')
      || typeof reason !== 'string'
      || !reason.trim()
      || !Array.isArray(parsed?.scopeKeys)
      || !Array.isArray(parsed?.detachRequestIds)
    ) {
      return fail('invalid payload');
    }
    return {
      action,
      reason: reason.trim(),
      scopeKeys: parsed.scopeKeys.filter((item): item is string => typeof item === 'string' && item.trim().length > 0),
      detachRequestIds: parsed.detachRequestIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planResponsesRebindRequestIdWithNative(input: unknown): RebindRequestIdPlan {
  const capability = 'planResponsesRebindRequestIdJson';
  const fail = (reason?: string) => failNativeRequired<RebindRequestIdPlan>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? null);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    const action = parsed?.action;
    const reason = parsed?.reason;
    if ((action !== 'noop' && action !== 'rebind') || typeof reason !== 'string' || !reason.trim()) {
      return fail('invalid payload');
    }
    return {
      action,
      reason: reason.trim(),
      ...(typeof parsed?.oldId === 'string' && parsed.oldId.trim() ? { oldId: parsed.oldId.trim() } : {}),
      ...(typeof parsed?.newId === 'string' && parsed.newId.trim() ? { newId: parsed.newId.trim() } : {})
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planResponsesReleaseRequestPayloadWithNative(entry: unknown): ReleaseRequestPayloadPlan {
  const capability = 'planResponsesReleaseRequestPayloadJson';
  const fail = (reason?: string) => failNativeRequired<ReleaseRequestPayloadPlan>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const entryJson = safeStringify(entry ?? null);
  if (!entryJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(entryJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed || !parsed.basePayload || typeof parsed.basePayload !== 'object' || Array.isArray(parsed.basePayload)) {
      return fail('invalid payload');
    }
    return {
      basePayload: parsed.basePayload as Record<string, unknown>,
      releasedInputPrefix: Array.isArray(parsed.releasedInputPrefix) ? parsed.releasedInputPrefix : [],
      releasedPendingToolCallIds: Array.isArray(parsed.releasedPendingToolCallIds)
        ? parsed.releasedPendingToolCallIds.filter(
            (item): item is string => typeof item === 'string' && item.trim().length > 0
          )
        : [],
      input: Array.isArray(parsed.input) ? parsed.input : []
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planResponsesScopeContinuationMatchWithNative(input: unknown): ScopeContinuationMatchPlan {
  const capability = 'planResponsesScopeContinuationMatchJson';
  const fail = (reason?: string) => failNativeRequired<ScopeContinuationMatchPlan>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? null);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    const action = parsed?.action;
    const reason = parsed?.reason;
    if (
      (action !== 'none' && action !== 'restore' && action !== 'materialize') ||
      typeof reason !== 'string' ||
      !reason.trim()
    ) {
      return fail('invalid payload');
    }
    return {
      action,
      reason: reason.trim(),
      ...(typeof parsed?.scopeKey === 'string' && parsed.scopeKey.trim()
        ? { scopeKey: parsed.scopeKey.trim() }
        : {}),
      ...(typeof parsed?.dedupeKey === 'string' && parsed.dedupeKey.trim()
        ? { dedupeKey: parsed.dedupeKey.trim() }
        : {}),
      ...(typeof parsed?.requestId === 'string' && parsed.requestId.trim()
        ? { requestId: parsed.requestId.trim() }
        : {}),
      ...(typeof parsed?.lastResponseId === 'string' && parsed.lastResponseId.trim()
        ? { lastResponseId: parsed.lastResponseId.trim() }
        : {}),
      ...(typeof parsed?.matchCount === 'number' && Number.isFinite(parsed.matchCount)
        ? { matchCount: parsed.matchCount }
        : {})
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planResponsesConversationResumeEntryMatchWithNative(input: unknown): ResumeEntryMatchPlan {
  const capability = 'planResponsesConversationResumeEntryMatchJson';
  const fail = (reason?: string) => failNativeRequired<ResumeEntryMatchPlan>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? null);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    const action = parsed?.action;
    const reason = parsed?.reason;
    if (
      (action !== 'none' && action !== 'select' && action !== 'ambiguous') ||
      typeof reason !== 'string' ||
      !reason.trim()
    ) {
      return fail('invalid payload');
    }
    const source = parsed?.source;
    return {
      action,
      reason: reason.trim(),
      ...(source === 'response_index' || source === 'request_map' || source === 'scope' ? { source } : {}),
      ...(typeof parsed?.requestId === 'string' && parsed.requestId.trim()
        ? { requestId: parsed.requestId.trim() }
        : {}),
      ...(typeof parsed?.lastResponseId === 'string' && parsed.lastResponseId.trim()
        ? { lastResponseId: parsed.lastResponseId.trim() }
        : {}),
      ...(typeof parsed?.scopeKey === 'string' && parsed.scopeKey.trim()
        ? { scopeKey: parsed.scopeKey.trim() }
        : {}),
      ...(typeof parsed?.matchCount === 'number' && Number.isFinite(parsed.matchCount)
        ? { matchCount: parsed.matchCount }
        : {})
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planResponsesContinuationLookupByResponseIdWithNative(input: unknown): ContinuationLookupPlan {
  const capability = 'planResponsesContinuationLookupByResponseIdJson';
  const fail = (reason?: string) => failNativeRequired<ContinuationLookupPlan>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? null);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    const action = parsed?.action;
    const reason = parsed?.reason;
    if ((action !== 'none' && action !== 'select') || typeof reason !== 'string' || !reason.trim()) {
      return fail('invalid payload');
    }
    const continuationOwner = parsed?.continuationOwner;
    const entryKind = parsed?.entryKind;
    return {
      action,
      reason: reason.trim(),
      ...(typeof parsed?.responseId === 'string' && parsed.responseId.trim()
        ? { responseId: parsed.responseId.trim() }
        : {}),
      ...(typeof parsed?.providerKey === 'string' && parsed.providerKey.trim()
        ? { providerKey: parsed.providerKey.trim() }
        : {}),
      ...(continuationOwner === 'direct' || continuationOwner === 'relay' ? { continuationOwner } : {}),
      ...(entryKind === 'responses' || entryKind === 'chat' || entryKind === 'messages' ? { entryKind } : {}),
      ...(typeof parsed?.requestId === 'string' && parsed.requestId.trim()
        ? { requestId: parsed.requestId.trim() }
        : {})
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planResponsesContinuationMetaWithNative(input: unknown): ContinuationMetaPlan {
  const capability = 'planResponsesContinuationMetaJson';
  const fail = (reason?: string) => failNativeRequired<ContinuationMetaPlan>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? null);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (parsed?.action !== 'meta' || typeof parsed.reason !== 'string' || !parsed.reason.trim()) {
      return fail('invalid payload');
    }
    const meta = parsed.meta;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      return fail('invalid meta');
    }
    return {
      action: 'meta',
      reason: parsed.reason.trim(),
      meta: meta as Record<string, unknown>
    };
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

export function materializeProviderOwnedSubmitContextWithNative(
  payload: unknown
): { payload: Record<string, unknown>; context: { input: unknown[] } } | null {
  const capability = 'materializeProviderOwnedSubmitContextJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ payload: Record<string, unknown>; context: { input: unknown[] } } | null>(capability, reason);
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
    const parsed = parseJson(raw);
    if (parsed === null) {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    const record = parsed as Record<string, unknown>;
    const plannedPayload = record.payload;
    const context = record.context;
    if (!plannedPayload || typeof plannedPayload !== 'object' || Array.isArray(plannedPayload)) {
      return fail('invalid payload');
    }
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
      return fail('invalid context');
    }
    const input = (context as Record<string, unknown>).input;
    if (!Array.isArray(input)) {
      return fail('invalid context input');
    }
    return {
      payload: plannedPayload as Record<string, unknown>,
      context: { input },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planResponsesRequestContextWithNative(input: unknown): Record<string, unknown> {
  const capability = 'planResponsesRequestContextJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? null);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed || typeof parsed.kind !== 'string') {
      return fail('invalid payload');
    }
    if (parsed.kind === 'capture_request') {
      const payload = parsed.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return fail('invalid capture payload');
      }
    } else if (parsed.kind === 'context') {
      const payload = parsed.payload;
      const context = parsed.context;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return fail('invalid context payload');
      }
      if (!context || typeof context !== 'object' || Array.isArray(context)) {
        return fail('invalid context');
      }
      if (!Array.isArray((context as Record<string, unknown>).input)) {
        return fail('invalid context input');
      }
    } else if (parsed.kind === 'error') {
      if (typeof parsed.message !== 'string' || !parsed.message.trim()) {
        return fail('invalid error payload');
      }
    } else {
      return fail('invalid kind');
    }
    return parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function planResponsesContinuationRequestActionWithNative(input: unknown): Record<string, unknown> {
  const capability = 'planResponsesContinuationRequestActionJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? null);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed || typeof parsed.action !== 'string') {
      return fail('invalid payload');
    }
    return parsed;
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

export type PublishResponsesRecordPlan = {
  shouldRecord: boolean;
  hasScope: boolean;
  recordArgs: {
    requestId: string;
    response: Record<string, unknown>;
    sessionId: string;
    conversationId: string;
    providerKey: string;
    entryKind: 'responses' | 'chat' | 'messages';
    continuationOwner: 'direct' | 'relay';
    matchedPort: number;
    routingPolicyGroup: string;
    allowScopeContinuation: boolean;
    routeHint: string;
  } | null;
  finalizeArgs: {
    requestId: string;
    keepForSubmitToolOutputs: boolean;
  } | null;
  usageArgs: {
    capturedChatRequest: unknown;
    usage: unknown;
  } | null;
};

export function publishResponsesRecordPlanWithNative(args: {
  requestId: string;
  response: unknown;
  context: unknown;
  runtimeStateWrite: unknown;
  entryEndpoint: string;
}): PublishResponsesRecordPlan {
  const capability = 'publishResponsesRecordPlanJson';
  const fail = (reason?: string) =>
    failNativeRequired<PublishResponsesRecordPlan>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const responseJson = safeStringify(args.response ?? null);
  const contextJson = safeStringify(args.context ?? null);
  const runtimeStateWriteJson = safeStringify(args.runtimeStateWrite ?? null);
  if (!responseJson || !contextJson || !runtimeStateWriteJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(
      String(args.requestId ?? ''),
      responseJson,
      contextJson,
      runtimeStateWriteJson,
      String(args.entryEndpoint ?? '')
    );
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    return parsed as unknown as PublishResponsesRecordPlan;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}


// Inlined from retired native-shared-conversion-semantics-tools.ts
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
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const row = parsed as Record<string, unknown>;
      if (row.__rccNativeError === true && typeof row.message === 'string' && row.message.trim()) {
        return fail(row.message.trim());
      }
    }
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
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const row = parsed as Record<string, unknown>;
      if (row.__rccNativeError === true && typeof row.message === 'string' && row.message.trim()) {
        return fail(row.message.trim());
      }
    }
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
  mode: 'default' = 'default'
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


// Inlined from retired native-shared-conversion-semantics-toolcalls.ts
function parseToolCallLiteArray(
  raw: string
): Array<{ id?: string; name: string; args: string }> | null {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) {
    return null;
  }
  const out: Array<{ id?: string; name: string; args: string }> = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.name !== 'string' || typeof row.args !== 'string') {
      return null;
    }
    const id = typeof row.id === 'string' && row.id.trim().length ? row.id : undefined;
    out.push({ id, name: row.name, args: row.args });
  }
  return out;
}

function parseReasoningItems(raw: string): Array<{ type: 'reasoning'; content: string }> | null {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) {
    return null;
  }
  const out: Array<{ type: 'reasoning'; content: string }> = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }
    const row = entry as Record<string, unknown>;
    if (row.type !== 'reasoning' || typeof row.content !== 'string') {
      return null;
    }
    out.push({ type: 'reasoning', content: row.content });
  }
  return out;
}

function parseToolCallResult(raw: string): Array<{ id?: string; name: string; args: string }> | null {
  if (!raw || raw === 'null' || raw === 'undefined') {
    return [];
  }
  const parsed = parseToolCallLiteArray(raw);
  return parsed ?? [];
}

function callTextMarkupExtractor(
  capability: string,
  payload: unknown
): Array<{ id?: string; name: string; args: string }> | null {
  const fail = (reason?: string) =>
    failNativeRequired<Array<{ id?: string; name: string; args: string }> | null>(capability, reason);
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
    if (typeof raw !== 'string') {
      return fail('invalid payload');
    }
    const parsed = parseToolCallResult(raw);
    return parsed ?? null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function extractJsonToolCallsFromTextWithNative(
  text: string,
  options?: Record<string, unknown>
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractJsonToolCallsFromTextJson', {
    text: String(text ?? ''),
    options: options ?? null
  });
}

export function extractXMLToolCallsFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractXmlToolCallsFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractSimpleXmlToolsFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractSimpleXmlToolsFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractParameterXmlToolsFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractParameterXmlToolsFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractInvokeToolsFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractInvokeToolsFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractToolNamespaceXmlBlocksFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractToolNamespaceXmlBlocksFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractApplyPatchCallsFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractApplyPatchCallsFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractBareExecCommandFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractBareExecCommandFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractExecuteBlocksFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractExecuteBlocksFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractExploredListDirectoryCallsFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractExploredListDirectoryCallsFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractQwenToolCallTokensFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractQwenToolCallTokensFromTextJson', {
    text: String(text ?? '')
  });
}

export function mergeToolCallsWithNative(
  existing: Array<Record<string, unknown>> | undefined,
  additions: Array<Record<string, unknown>> | undefined
): Array<Record<string, unknown>> {
  const capability = 'mergeToolCallsJson';
  const fail = (reason?: string) => failNativeRequired<Array<Record<string, unknown>>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const existingJson = safeStringify(existing ?? []);
  const additionsJson = safeStringify(additions ?? []);
  if (!existingJson || !additionsJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(existingJson, additionsJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (!Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    return parsed.filter((entry) => entry && typeof entry === 'object') as Array<Record<string, unknown>>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function mapReasoningContentToResponsesOutputWithNative(
  reasoningContent: unknown
): Array<{ type: 'reasoning'; content: string }> {
  const capability = 'mapReasoningContentToResponsesOutputJson';
  const fail = (reason?: string) =>
    failNativeRequired<Array<{ type: 'reasoning'; content: string }>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const contentJson = safeStringify(reasoningContent ?? null);
  if (!contentJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(contentJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseReasoningItems(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function validateToolArgumentsWithNative(
  toolName: string | undefined,
  args: unknown
): { repaired: string; success: boolean; error?: string } {
  const capability = 'validateToolArgumentsJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ repaired: string; success: boolean; error?: string }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ toolName, args: args ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed || typeof parsed.repaired !== 'string' || typeof parsed.success !== 'boolean') {
      return fail('invalid payload');
    }
    const error = typeof parsed.error === 'string' ? parsed.error : undefined;
    return { repaired: parsed.repaired, success: parsed.success, ...(error ? { error } : {}) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function validateExecCommandGuardWithNative(
  cmd: string,
  policyJson?: string
): { ok: boolean; reason?: string; message?: string; normalizedCmd?: string } {
  const capability = 'validateExecCommandGuardJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ ok: boolean; reason?: string; message?: string; normalizedCmd?: string }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    cmd: String(cmd ?? ''),
    ...(typeof policyJson === 'string' && policyJson.trim() ? { policyJson } : {})
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed || typeof parsed.ok !== 'boolean') {
      return fail('invalid payload');
    }
    const reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
    const message = typeof parsed.message === 'string' ? parsed.message : undefined;
    const normalizedCmd = typeof parsed.normalizedCmd === 'string' ? parsed.normalizedCmd : undefined;
    return {
      ok: parsed.ok,
      ...(reason ? { reason } : {}),
      ...(message ? { message } : {}),
      ...(normalizedCmd ? { normalizedCmd } : {})
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeExecCommandArgsWithNative(
  args: unknown,
  options?: { schemaMode?: 'compat' | 'canonical' }
): { ok: true; normalized: Record<string, unknown> } | { ok: false; reason: 'missing_cmd'; normalized: Record<string, unknown> } {
  const capability = 'normalizeExecCommandArgsJson';
  const fail = (reason?: string) =>
    failNativeRequired<
      { ok: true; normalized: Record<string, unknown> } | { ok: false; reason: 'missing_cmd'; normalized: Record<string, unknown> }
    >(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    args: args ?? null,
    schemaMode: options?.schemaMode === 'canonical' ? 'canonical' : 'compat'
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed || typeof parsed.ok !== 'boolean') {
      return fail('invalid payload');
    }
    const normalizedRaw = parsed.normalized;
    if (!normalizedRaw || typeof normalizedRaw !== 'object' || Array.isArray(normalizedRaw)) {
      return fail('invalid normalized payload');
    }
    const normalized = normalizedRaw as Record<string, unknown>;
    if (parsed.ok === true) {
      return { ok: true, normalized };
    }
    if (parsed.reason === 'missing_cmd') {
      return { ok: false, reason: 'missing_cmd', normalized };
    }
    return fail('invalid failure reason');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function parseToolArgsJsonWithArtifactRepairWithNative(input: unknown): unknown {
  const capability = 'parseToolArgsJsonWithArtifactRepairJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(typeof input === 'string' ? input : '');
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseJson(raw) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function repairToolCallsWithNative(
  toolCalls: Array<{ name?: string; arguments?: unknown }>
): Array<{ name?: string; arguments: string }> {
  const capability = 'repairToolCallsJson';
  const fail = (reason?: string) =>
    failNativeRequired<Array<{ name?: string; arguments: string }>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(Array.isArray(toolCalls) ? toolCalls : []);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseArray(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    return parsed.filter((entry): entry is { name?: string; arguments: string } => {
      return !!(entry && typeof entry === 'object' && !Array.isArray(entry) && typeof (entry as any).arguments === 'string');
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}


// Inlined from retired native-shared-conversion-semantics-openai.ts
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

export function normalizeOpenaiChatRequestWithNative(
  request: unknown,
  disableShellCoerce: boolean
): unknown {
  const capability = 'normalizeOpenaiChatRequestJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(request ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson, Boolean(disableShellCoerce));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const row = parsed as Record<string, unknown>;
      if (row.__rccNativeError === true && typeof row.message === 'string' && row.message.trim()) {
        return fail(row.message.trim());
      }
    }
    return parsed;
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


// Inlined from retired native-shared-conversion-semantics-shell-utils.ts
export function repairFindMetaWithNative(script: string): string {
  const capability = 'repairFindMetaJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(script ?? '');
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return typeof parsed === 'string' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function deriveToolCallKeyWithNative(
  call: Record<string, unknown> | null | undefined
): string | null {
  const capability = 'deriveToolCallKeyJson';
  const fail = (reason?: string) => failNativeRequired<string | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const callJson = safeStringify(call ?? null);
  if (!callJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(callJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (parsed === null) {
      return null;
    }
    return typeof parsed === 'string' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}


// Inlined from retired native-shared-conversion-semantics-id-stream.ts
export function normalizeIdValueWithNative(value: unknown, forceGenerate = false): string {
  const capability = 'normalizeIdValueJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ value, forceGenerate });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return typeof parsed === 'string' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function extractToolCallIdWithNative(obj: unknown): string | undefined {
  const capability = 'extractToolCallIdJson';
  const fail = (reason?: string) => failNativeRequired<string | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ obj: obj ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return typeof parsed === 'string' ? parsed : undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function createToolCallIdTransformerWithNative(style: string): Record<string, unknown> {
  const capability = 'createToolCallIdTransformerJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ style });
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

export function transformToolCallIdWithNative(state: Record<string, unknown>, id: string): { id: string; state: Record<string, unknown> } {
  const capability = 'transformToolCallIdJson';
  const fail = (reason?: string) => failNativeRequired<{ id: string; state: Record<string, unknown> }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ state, id });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed || typeof parsed.id !== 'string' || !parsed.state || typeof parsed.state !== 'object') {
      return fail('invalid payload');
    }
    return parsed as { id: string; state: Record<string, unknown> };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function enforceToolCallIdStyleWithNative(messages: unknown[], state: Record<string, unknown>): { messages: unknown[]; state: Record<string, unknown> } {
  const capability = 'enforceToolCallIdStyleJson';
  const fail = (reason?: string) => failNativeRequired<{ messages: unknown[]; state: Record<string, unknown> }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ messages: Array.isArray(messages) ? messages : [], state });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed || !Array.isArray(parsed.messages) || !parsed.state || typeof parsed.state !== 'object') {
      return fail('invalid payload');
    }
    return parsed as { messages: unknown[]; state: Record<string, unknown> };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function stripInternalToolingMetadataWithNative(metadata: unknown): Record<string, unknown> | null {
  const capability = 'stripInternalToolingMetadataJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | null>(capability, reason);
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
    const raw = fn(metadataJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseRecord(raw) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildProviderProtocolErrorWithNative(input: {
  message: string;
  code: string;
  protocol?: string;
  providerType?: string;
  category?: string;
  details?: Record<string, unknown>;
}): Record<string, unknown> {
  const capability = 'buildProviderProtocolErrorJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    message: input.message,
    code: input.code,
    protocol: input.protocol,
    providerType: input.providerType,
    category: input.category,
    details: input.details
  });
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

export function isImagePathWithNative(pathValue: unknown): boolean {
  const capability = 'isImagePathJson';
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const pathJson = safeStringify(pathValue ?? null);
  if (!pathJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(pathJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return typeof parsed === 'boolean' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function extractStreamingToolCallsWithNative(input: {
  buffer: string;
  text: string;
  idPrefix: string;
  idCounter: number;
  nowMs: number;
}): { buffer: string; idCounter: number; toolCalls: Array<Record<string, unknown>> } {
  const capability = 'extractStreamingToolCallsJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ buffer: string; idCounter: number; toolCalls: Array<Record<string, unknown>> }>(
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
  const payloadJson = safeStringify(input ?? {});
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
    const buffer = typeof parsed.buffer === 'string' ? parsed.buffer : '';
    const idCounter = typeof parsed.idCounter === 'number' ? parsed.idCounter : input.idCounter;
    const toolCalls = Array.isArray(parsed.toolCalls)
      ? (parsed.toolCalls as Array<unknown>).filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
          .map((entry) => entry as Record<string, unknown>)
      : [];
    return { buffer, idCounter, toolCalls };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function createStreamingToolExtractorStateWithNative(idPrefix?: string): Record<string, unknown> {
  const capability = 'createStreamingToolExtractorStateJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(idPrefix ? { idPrefix } : {});
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseRecord(raw) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resetStreamingToolExtractorStateWithNative(state: Record<string, unknown>): Record<string, unknown> {
  const capability = 'resetStreamingToolExtractorStateJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(state ?? {});
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseRecord(raw) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function feedStreamingToolExtractorWithNative(input: {
  state: Record<string, unknown>;
  text: string;
  nowMs?: number;
}): { state: Record<string, unknown>; toolCalls: Array<Record<string, unknown>> } {
  const capability = 'feedStreamingToolExtractorJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ state: Record<string, unknown>; toolCalls: Array<Record<string, unknown>> }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(input ?? {});
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed || !parsed.state || typeof parsed.state !== 'object' || Array.isArray(parsed.state)) {
      return fail('invalid payload');
    }
    const toolCalls = Array.isArray(parsed.toolCalls)
      ? (parsed.toolCalls as Array<unknown>).filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
          .map((entry) => entry as Record<string, unknown>)
      : [];
    return { state: parsed.state as Record<string, unknown>, toolCalls };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function isCompactionRequestWithNative(payload: unknown): boolean {
  const capability = 'isCompactionRequestJson';
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
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
    const parsed = parseJson(raw);
    return typeof parsed === 'boolean' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}


// Inlined from retired native-shared-conversion-semantics-reasoning.ts
function parseExtractToolCallsOutput(
  raw: string
): { cleanedText: string; toolCalls: Array<Record<string, unknown>> } | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  if (typeof row.cleanedText !== 'string' || !Array.isArray(row.toolCalls)) {
    return null;
  }
  const toolCalls = row.toolCalls.filter((entry) => entry && typeof entry === 'object') as Array<Record<string, unknown>>;
  return {
    cleanedText: row.cleanedText,
    toolCalls
  };
}

function parseExtractReasoningSegmentsOutput(
  raw: string
): { text: string; segments: string[] } | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  if (typeof row.text !== 'string' || !Array.isArray(row.segments)) {
    return null;
  }
  const segments = row.segments.filter((entry): entry is string => typeof entry === 'string');
  if (segments.length !== row.segments.length) {
    return null;
  }
  return { text: row.text, segments };
}

function parseNormalizeReasoningOutput(raw: string): { payload: unknown } | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  return { payload: row.payload };
}

type NormalizedToolCall = {
  id?: string;
  type: 'function';
  function: { name: string; arguments: string };
};

function normalizeToolCallEntries(raw: unknown[]): NormalizedToolCall[] {
  return raw
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => {
      const row = entry as Record<string, unknown>;
      const functionRow =
        row.function && typeof row.function === 'object' && !Array.isArray(row.function)
          ? (row.function as Record<string, unknown>)
          : null;
      const name = (
        typeof functionRow?.name === 'string'
          ? functionRow.name
          : typeof row.name === 'string'
            ? row.name
            : ''
      ).trim();
      const rawArgsCandidate =
        functionRow?.arguments ??
        row.args ??
        row.arguments ??
        functionRow?.input ??
        row.input ??
        null;
      const argsCandidate =
        typeof rawArgsCandidate === 'string'
          ? rawArgsCandidate
          : rawArgsCandidate && typeof rawArgsCandidate === 'object'
            ? JSON.stringify(rawArgsCandidate)
            : '';
      if (!name) {
        return null;
      }
      return {
        ...(typeof row.id === 'string' && row.id ? { id: row.id } : {}),
        type: 'function' as const,
        function: {
          name,
          arguments: argsCandidate
        }
      };
    })
    .filter((entry): entry is NormalizedToolCall => Boolean(entry));
}

export function extractToolCallsFromReasoningTextWithNative(
  text: string,
  idPrefix?: string
): { cleanedText: string; toolCalls: Array<Record<string, unknown>> } {
  const capability = 'extractToolCallsFromReasoningTextJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ cleanedText: string; toolCalls: Array<Record<string, unknown>> }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(String(text ?? ''), idPrefix);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseExtractToolCallsOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function extractReasoningSegmentsWithNative(
  text: string
): { text: string; segments: string[] } {
  const capability = 'extractReasoningSegmentsJson';
  const fail = (reason?: string) => failNativeRequired<{ text: string; segments: string[] }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(String(text ?? ''));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseExtractReasoningSegmentsOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeAssistantTextToToolCallsWithNative(
  message: Record<string, unknown>,
  options?: Record<string, unknown>
): Record<string, unknown> {
  const capability = 'normalizeAssistantTextToToolCallsJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const baseMessage = message && typeof message === 'object' ? { ...message } : {};
  const payloadJson = safeStringify(baseMessage);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    let normalizedMessage = { ...baseMessage };
    let toolCallsSource: unknown[] = [];
    if (Array.isArray(parsed)) {
      toolCallsSource = parsed;
    } else if (parsed && typeof parsed === 'object') {
      const row = parsed as Record<string, unknown>;
      const messageNode =
        row.message && typeof row.message === 'object' && !Array.isArray(row.message)
          ? (row.message as Record<string, unknown>)
          : row;
      normalizedMessage = {
        ...normalizedMessage,
        ...messageNode
      };
      toolCallsSource = Array.isArray(messageNode.tool_calls)
        ? messageNode.tool_calls
        : [];
    } else {
      return fail('invalid payload');
    }
    const normalizedCalls = normalizeToolCallEntries(toolCallsSource);
    if (normalizedCalls.length > 0) {
      return {
        ...normalizedMessage,
        tool_calls: normalizedCalls
      };
    }
    return normalizedMessage;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeReasoningInChatPayloadWithNative(payload: unknown): unknown {
  const capability = 'normalizeReasoningInChatPayloadJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
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
    const parsed = parseNormalizeReasoningOutput(raw);
    return parsed ? parsed.payload : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeReasoningInResponsesPayloadWithNative(payload: unknown, options?: Record<string, unknown>): unknown {
  const capability = 'normalizeReasoningInResponsesPayloadJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ payload: payload ?? null, options: options ?? {} });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseNormalizeReasoningOutput(raw);
    return parsed ? parsed.payload : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeReasoningInGeminiPayloadWithNative(payload: unknown): unknown {
  const capability = 'normalizeReasoningInGeminiPayloadJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
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
    const parsed = parseNormalizeReasoningOutput(raw);
    return parsed ? parsed.payload : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeReasoningInAnthropicPayloadWithNative(payload: unknown): unknown {
  const capability = 'normalizeReasoningInAnthropicPayloadJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
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
    const parsed = parseNormalizeReasoningOutput(raw);
    return parsed ? parsed.payload : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeReasoningInOpenAIPayloadWithNative(payload: unknown): unknown {
  const capability = 'normalizeReasoningInOpenaiPayloadJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
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
    const parsed = parseNormalizeReasoningOutput(raw);
    return parsed ? parsed.payload : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function sanitizeReasoningTaggedTextWithNative(text: string): string {
  const capability = 'sanitizeReasoningTaggedTextJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(String(text ?? ''));
    if (typeof raw !== 'string') {
      return fail('invalid payload');
    }
    return raw;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}


// Inlined from retired native-shared-conversion-semantics-misc.ts
export function parseLenientJsonishWithNative(value: unknown): unknown {
  const capability = 'parseLenientJsonishJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const valueJson = safeStringify(value ?? null);
  if (!valueJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(valueJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function repairArgumentsToStringWithNative(value: unknown): string {
  const capability = 'repairArgumentsToStringJsonishJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const valueJson = safeStringify(value ?? null);
  if (!valueJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(valueJson);
    if (typeof raw !== 'string') {
      return fail('invalid payload');
    }
    return raw;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function ensureBridgeInstructionsWithNative(payload: Record<string, unknown>): Record<string, unknown> {
  const capability = 'ensureBridgeInstructionsJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload ?? {});
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


// Inlined from retired native-shared-conversion-semantics-tool-definitions.ts
function parseToolDefinitionArray(raw: string): Array<Record<string, unknown>> | null {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) {
    return null;
  }
  return parsed.filter((entry): entry is Record<string, unknown> =>
    Boolean(entry && typeof entry === 'object' && !Array.isArray(entry))
  );
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

export function flattenChatToolsForFunctionCallingWithNative(
  rawTools: unknown,
  options?: { sanitizeMode?: string }
): Array<Record<string, unknown>> {
  const capability = 'flattenChatToolsForFunctionCallingWithOptionsJson';
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

export function mapChatToolsToAnthropicToolsWithNative(
  rawTools: unknown
): Array<Record<string, unknown>> {
  const capability = 'mapChatToolsToAnthropicToolsJson';
  const fail = (reason?: string) => failNativeRequired<Array<Record<string, unknown>>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(Array.isArray(rawTools) ? rawTools : []);
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
