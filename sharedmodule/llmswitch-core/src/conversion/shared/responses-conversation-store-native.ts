import {
  buildResponsesConversationScopePlanWithNative,
  collectResponsesPendingToolCallIdsWithNative,
  convertResponsesOutputToInputItemsWithNative,
  materializeResponsesContinuationPayloadWithNative,
  planResponsesCapturePendingCleanupWithNative,
  planResponsesConversationPersistenceEligibilityWithNative,
  planResponsesConversationPreflightWithNative,
  planResponsesCapturedEntryWithNative,
  planResponsesRecordContinuationFlagWithNative,
  planResponsesRecordScopeCleanupWithNative,
  planResponsesRecordScopeEntryMatchWithNative,
  planResponsesPersistedEntryWithNative,
  planResponsesStoreTokensWithNative,
  planResponsesStoreSweepWithNative,
  planResponsesAttachEntryScopesWithNative,
  planResponsesRebindRequestIdWithNative,
  planResponsesReleaseRequestPayloadWithNative,
  planResponsesConversationRetentionWithNative,
  planResponsesConversationResumeEntryMatchWithNative,
  planResponsesScopeContinuationMatchWithNative,
  planResponsesContinuationLookupByResponseIdWithNative,
  planResponsesContinuationMetaWithNative,
  restoreResponsesContinuationPayloadWithNative,
  resumeResponsesConversationPayloadWithNative,
  stripResponsesStoredContextInputMediaWithNative
} from '../../native/router-hotpath/native-shared-conversion-semantics.js';

export type AnyRecord = Record<string, unknown>;
export type ResponsesContinuationEntryKind = 'responses' | 'chat' | 'messages';

export interface CaptureContextArgs {
  requestId?: string;
  payload: AnyRecord;
  context: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  providerKey?: string;
  entryKind?: ResponsesContinuationEntryKind;
  matchedPort?: number;
  routingPolicyGroup?: string;
}

export interface RecordResponseArgs {
  requestId?: string;
  response: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  providerKey?: string;
  entryKind?: ResponsesContinuationEntryKind;
  continuationOwner?: 'direct' | 'relay';
  matchedPort?: number;
  routingPolicyGroup?: string;
  allowScopeContinuation?: boolean;
}

export interface ResumeOptions {
  requestId?: string;
  entryKind?: ResponsesContinuationEntryKind;
  continuationOwner?: 'direct' | 'relay';
  matchedPort?: number;
  routingPolicyGroup?: string;
}

export interface ResumeResult {
  payload: AnyRecord;
  meta: AnyRecord;
}

export interface ContinuationLookupOptions {
  entryKind?: ResponsesContinuationEntryKind;
  continuationOwner?: 'direct' | 'relay';
  matchedPort?: number;
  routingPolicyGroup?: string;
}

export interface ResponsesStoreLookupResult {
  responseId: string;
  providerKey?: string;
  continuationOwner?: 'direct' | 'relay';
  entryKind?: ResponsesContinuationEntryKind;
  requestId?: string;
}

export interface RestoreByScopeArgs {
  payload: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  requestId?: string;
  entryKind?: ResponsesContinuationEntryKind;
  continuationOwner?: 'direct' | 'relay';
  matchedPort?: number;
  routingPolicyGroup?: string;
}

export interface ConversationEntry {
  requestId: string;
  basePayload: AnyRecord;
  input: AnyRecord[];
  allowContinuation?: boolean;
  releasedInputPrefix?: AnyRecord[];
  releasedPendingToolCallIds?: string[];
  inputPrefixDigest?: string;
  inputItemCount?: number;
  tools?: AnyRecord[];
  providerKey?: string;
  entryKind?: ResponsesContinuationEntryKind;
  continuationOwner?: 'direct' | 'relay';
  createdAt: number;
  updatedAt: number;
  lastResponseId?: string;
  sessionId?: string;
  conversationId?: string;
  scopeKeys: string[];
  portScopeKey?: string;
}

export function assertResponsesConversationStoreNativeAvailable(): void {
  if (
    typeof buildResponsesConversationScopePlanWithNative !== 'function' ||
    typeof convertResponsesOutputToInputItemsWithNative !== 'function' ||
    typeof materializeResponsesContinuationPayloadWithNative !== 'function' ||
    typeof restoreResponsesContinuationPayloadWithNative !== 'function' ||
    typeof resumeResponsesConversationPayloadWithNative !== 'function' ||
    typeof collectResponsesPendingToolCallIdsWithNative !== 'function' ||
    typeof planResponsesCapturePendingCleanupWithNative !== 'function' ||
    typeof planResponsesConversationPreflightWithNative !== 'function' ||
    typeof planResponsesCapturedEntryWithNative !== 'function' ||
    typeof planResponsesConversationPersistenceEligibilityWithNative !== 'function' ||
    typeof planResponsesPersistedEntryWithNative !== 'function' ||
    typeof planResponsesStoreTokensWithNative !== 'function' ||
    typeof planResponsesRecordContinuationFlagWithNative !== 'function' ||
    typeof planResponsesRecordScopeCleanupWithNative !== 'function' ||
    typeof planResponsesRecordScopeEntryMatchWithNative !== 'function' ||
    typeof planResponsesStoreSweepWithNative !== 'function' ||
    typeof planResponsesAttachEntryScopesWithNative !== 'function' ||
    typeof planResponsesRebindRequestIdWithNative !== 'function' ||
    typeof planResponsesReleaseRequestPayloadWithNative !== 'function' ||
    typeof planResponsesConversationRetentionWithNative !== 'function' ||
    typeof planResponsesConversationResumeEntryMatchWithNative !== 'function' ||
    typeof planResponsesContinuationLookupByResponseIdWithNative !== 'function' ||
    typeof planResponsesContinuationMetaWithNative !== 'function' ||
    typeof planResponsesScopeContinuationMatchWithNative !== 'function' ||
    typeof stripResponsesStoredContextInputMediaWithNative !== 'function'
  ) {
    throw new Error('[responses-conversation-store] native bindings unavailable');
  }
}

export function buildConversationScopePlan(input: unknown): { keys: string[]; portScopeKey?: string } {
  return buildResponsesConversationScopePlanWithNative(input);
}

export function collectPendingToolCallIds(input: AnyRecord[]): string[] {
  return collectResponsesPendingToolCallIdsWithNative(input);
}

export function planConversationRetention(
  entry: ConversationEntry,
  options: { keepForSubmitToolOutputs?: boolean } | undefined
): { action: 'noop' | 'clear' | 'release'; reason: string; lastResponseId?: string } {
  return planResponsesConversationRetentionWithNative(entry, options);
}

export function planPersistenceEligibility(
  entry: ConversationEntry,
  options: { mode: 'load' | 'flush'; nowMs?: number; ttlMs?: number }
): { action: 'persist' | 'skip'; reason: string; lastResponseId?: string } {
  return planResponsesConversationPersistenceEligibilityWithNative(entry, options);
}

export function planPersistedEntry(input: {
  mode: 'serialize' | 'deserialize';
  entry: unknown;
  nowMs?: number;
}): { action: 'entry' | 'skip'; reason: string; entry?: ConversationEntry } {
  const plan = planResponsesPersistedEntryWithNative(input);
  return {
    action: plan.action,
    reason: plan.reason,
    ...(plan.entry ? { entry: plan.entry as unknown as ConversationEntry } : {})
  };
}

export function planStoreTokens(input: unknown): {
  providerKey?: string;
  sessionId?: string;
  conversationId?: string;
  entryKind: 'responses' | 'chat' | 'messages';
  continuationOwner?: 'direct' | 'relay';
} {
  return planResponsesStoreTokensWithNative(input);
}

export function planConversationPreflight(input: unknown): {
  action: 'continue' | 'skip' | 'throw';
  reason: string;
  code?: string;
  requestId?: string;
  responseId?: string;
  toolOutputCount?: number;
} {
  return planResponsesConversationPreflightWithNative(input);
}

export function planCapturedEntry(input: unknown): { action: 'entry' | 'skip'; reason: string; entry?: ConversationEntry } {
  const plan = planResponsesCapturedEntryWithNative(input);
  return {
    action: plan.action,
    reason: plan.reason,
    ...(plan.entry ? { entry: plan.entry as unknown as ConversationEntry } : {})
  };
}

export type CapturePendingCleanupCandidate = {
  requestId?: string;
  lastResponseId?: string;
  scopeKeys?: string[];
};

export function planCapturePendingCleanup(input: {
  requestId: string;
  scopeKeys: string[];
  candidates: CapturePendingCleanupCandidate[];
}): { action: 'noop' | 'detach'; reason: string; detachRequestIds: string[] } {
  return planResponsesCapturePendingCleanupWithNative(input);
}

export type RecordScopeCleanupCandidate = {
  requestId?: string;
  lastResponseId?: string;
  scopeKeys?: string[];
};

export function planRecordScopeCleanup(input: {
  requestId: string;
  scopeKeys: string[];
  candidates: RecordScopeCleanupCandidate[];
}): { action: 'noop' | 'detach'; reason: string; detachRequestIds: string[] } {
  return planResponsesRecordScopeCleanupWithNative(input);
}

export function planRecordContinuationFlag(input: {
  allowContinuation?: boolean;
  pendingToolCallIds?: string[];
}): { allowContinuation: boolean; reason: string; pendingToolCallCount: number } {
  return planResponsesRecordContinuationFlagWithNative(input);
}

export function planRecordScopeEntryMatch(input: {
  scopeKeys: string[];
  candidates: ScopeContinuationMatchCandidate[];
}): { action: 'none' | 'select'; reason: string; scopeKey?: string; requestId?: string } {
  return planResponsesRecordScopeEntryMatchWithNative(input);
}

export type StoreSweepCandidate = {
  requestId?: string;
  lastResponseId?: string;
  updatedAt?: number;
};

export function planStoreSweep(input: {
  mode: 'clear_unresolved' | 'prune_expired';
  nowMs?: number;
  ttlMs?: number;
  candidates: StoreSweepCandidate[];
}): { action: 'noop' | 'detach'; reason: string; detachRequestIds: string[] } {
  return planResponsesStoreSweepWithNative(input);
}

export type AttachEntryScopeCandidate = {
  scopeKey?: string;
  requestId?: string;
};

export function planAttachEntryScopes(input: {
  requestId: string;
  scopeKeys: string[];
  candidates: AttachEntryScopeCandidate[];
}): { action: 'noop' | 'attach' | 'detach_and_attach'; reason: string; scopeKeys: string[]; detachRequestIds: string[] } {
  return planResponsesAttachEntryScopesWithNative(input);
}

export function planRebindRequestId(input: {
  oldId?: string;
  newId?: string;
  oldEntryExists: boolean;
  newEntryExists: boolean;
}): { action: 'noop' | 'rebind'; reason: string; oldId?: string; newId?: string } {
  return planResponsesRebindRequestIdWithNative(input);
}

export function planContinuationMeta(input: {
  meta?: unknown;
  entry: ConversationEntry;
}): { action: 'meta'; reason: string; meta: AnyRecord } {
  const plan = planResponsesContinuationMetaWithNative(input);
  return {
    action: plan.action,
    reason: plan.reason,
    meta: plan.meta as AnyRecord
  };
}

export function planReleaseRequestPayload(entry: ConversationEntry): {
  basePayload: AnyRecord;
  releasedInputPrefix: AnyRecord[];
  releasedPendingToolCallIds: string[];
  input: AnyRecord[];
} {
  const plan = planResponsesReleaseRequestPayloadWithNative(entry);
  return {
    basePayload: plan.basePayload as AnyRecord,
    releasedInputPrefix: Array.isArray(plan.releasedInputPrefix)
      ? plan.releasedInputPrefix.filter(
          (item): item is AnyRecord => !!item && typeof item === 'object' && !Array.isArray(item)
        )
      : [],
    releasedPendingToolCallIds: Array.isArray(plan.releasedPendingToolCallIds)
      ? plan.releasedPendingToolCallIds
      : [],
    input: Array.isArray(plan.input)
      ? plan.input.filter((item): item is AnyRecord => !!item && typeof item === 'object' && !Array.isArray(item))
      : []
  };
}

export interface ScopeContinuationMatchCandidate {
  scopeKey: string;
  requestId?: string;
  lastResponseId?: string;
  allowContinuation?: boolean;
  continuationOwner?: 'direct' | 'relay';
}

type ScopeContinuationMatchPlan = {
  action: 'none' | 'restore' | 'materialize';
  reason: string;
  scopeKey?: string;
  dedupeKey?: string;
  requestId?: string;
  lastResponseId?: string;
  matchCount?: number;
};

export function planScopeContinuationMatch(input: {
  mode: 'resume' | 'materialize';
  candidates: ScopeContinuationMatchCandidate[];
  options?: { continuationOwner?: 'direct' | 'relay' };
}): ScopeContinuationMatchPlan {
  return planResponsesScopeContinuationMatchWithNative(input);
}

export type ResumeEntryMatchPlan = {
  action: 'none' | 'select' | 'ambiguous';
  reason: string;
  source?: 'response_index' | 'request_map' | 'scope';
  requestId?: string;
  lastResponseId?: string;
  scopeKey?: string;
  matchCount?: number;
};

export function planResumeEntryMatch(input: unknown): ResumeEntryMatchPlan {
  return planResponsesConversationResumeEntryMatchWithNative(input);
}

export type ContinuationLookupPlan = {
  action: 'none' | 'select';
  reason: string;
  responseId?: string;
  providerKey?: string;
  continuationOwner?: 'direct' | 'relay';
  entryKind?: 'responses' | 'chat' | 'messages';
  requestId?: string;
};

export function planContinuationLookupByResponseId(input: unknown): ContinuationLookupPlan {
  return planResponsesContinuationLookupByResponseIdWithNative(input);
}

export function convertOutputToInputItems(response: AnyRecord): AnyRecord[] {
  return convertResponsesOutputToInputItemsWithNative(response) as AnyRecord[];
}

export function resumeConversationPayload(
  entry: ConversationEntry,
  responseId: string,
  submitPayload: AnyRecord,
  requestId?: string
): { payload: AnyRecord; meta: AnyRecord } {
  const resumed = resumeResponsesConversationPayloadWithNative(
    {
      requestId: entry.requestId,
      basePayload: entry.basePayload,
      input: Array.isArray(entry.input) ? entry.input : [],
      releasedInputPrefix: entry.releasedInputPrefix,
      releasedPendingToolCallIds: entry.releasedPendingToolCallIds,
      tools: entry.tools,
      providerKey: entry.providerKey,
      continuationOwner: entry.continuationOwner
    },
    responseId,
    submitPayload,
    requestId
  );
  return {
    payload: resumed.payload as AnyRecord,
    meta: resumed.meta as AnyRecord
  };
}

export function restoreContinuationPayload(
  entry: ConversationEntry,
  payload: AnyRecord,
  requestId: string | undefined,
  scopeKey: string
): { payload: AnyRecord; meta: AnyRecord } | null {
  const restored = restoreResponsesContinuationPayloadWithNative(
    {
      requestId: entry.requestId,
      basePayload: entry.basePayload,
      input: entry.input,
      releasedInputPrefix: entry.releasedInputPrefix,
      releasedPendingToolCallIds: entry.releasedPendingToolCallIds,
      tools: entry.tools,
      providerKey: entry.providerKey,
      continuationOwner: entry.continuationOwner,
      lastResponseId: entry.lastResponseId
    },
    payload,
    requestId,
    scopeKey
  );
  if (!restored) {
    return null;
  }
  return {
    payload: restored.payload as AnyRecord,
    meta: restored.meta as AnyRecord
  };
}

export function materializeContinuationPayload(
  entry: ConversationEntry,
  payload: AnyRecord,
  requestId: string | undefined,
  scopeKey: string
): { payload: AnyRecord; meta: AnyRecord } | null {
  const materialized = materializeResponsesContinuationPayloadWithNative(
    {
      requestId: entry.requestId,
      basePayload: entry.basePayload,
      input: entry.input,
      releasedInputPrefix: entry.releasedInputPrefix,
      releasedPendingToolCallIds: entry.releasedPendingToolCallIds,
      tools: entry.tools,
      providerKey: entry.providerKey,
      continuationOwner: entry.continuationOwner,
      lastResponseId: entry.lastResponseId
    },
    payload,
    requestId,
    scopeKey
  );
  if (!materialized) {
    return null;
  }
  return {
    payload: materialized.payload as AnyRecord,
    meta: materialized.meta as AnyRecord
  };
}

export function stripStoredContextInputMedia(
  input: Array<Record<string, unknown>>,
  placeholderText = '[Image omitted]'
): { changed: boolean; messages: AnyRecord[] } {
  const stripped = stripResponsesStoredContextInputMediaWithNative(input, placeholderText);
  return {
    changed: stripped.changed === true,
    messages: Array.isArray(stripped.messages)
      ? stripped.messages.filter(
          (entry): entry is AnyRecord => !!entry && typeof entry === 'object' && !Array.isArray(entry)
        )
      : []
  };
}
