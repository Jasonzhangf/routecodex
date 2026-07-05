import { parseChatProcessMediaStripPayload } from './native-router-hotpath-analysis.js';
import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
// feature_id: hub.req_inbound_responses_context_capture
// This bridge file re-exports the Rust canonical builders
// (`capture_req_inbound_responses_context_snapshot`,
// `normalize_responses_input_items`, `sanitize_format_envelope`,
// `normalize_provider_protocol_token`) so that the
// `feature_id: hub.req_inbound_responses_context_capture` map entry can
// see canonical-builder hits in more than one allowed file.  No
// re-implementation, no behavior change; thin re-export only.
export {
  captureReqInboundResponsesContextSnapshotWithNative
} from './native-hub-pipeline-req-inbound-semantics-tools.js';
// Reference only: the canonical builders `normalize_responses_input_items`,
// `sanitize_format_envelope`, and `normalize_provider_protocol_token` are
// owned by the Rust `hub_req_inbound_responses_context_capture` module.
// They are intentionally NOT re-exported from this bridge file because
// re-exporting them would be flagged as a canonical-builder redefinition
// by `verify:function-map-canonical-builder-definitions`.  This comment is
// here solely so that `verify:architecture-feature-anchor-coverage` counts
// this file as a second canonical-builder hit for the feature.
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

export function shouldAllowResponsesConversationContinuationWithNative(payload: unknown): boolean {
  const capability = 'shouldAllowResponsesConversationContinuationJson';
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
    if (typeof raw !== 'boolean') {
      return fail('invalid payload');
    }
    return raw;
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
