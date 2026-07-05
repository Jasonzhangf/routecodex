import {
  buildResponsesConversationScopePlanWithNative,
  collectResponsesPendingToolCallIdsWithNative,
  convertResponsesOutputToInputItemsWithNative,
  materializeResponsesContinuationPayloadWithNative,
  pickResponsesPersistedFieldsWithNative,
  planResponsesCapturePendingCleanupWithNative,
  planResponsesConversationPersistenceEligibilityWithNative,
  planResponsesRecordScopeCleanupWithNative,
  planResponsesRecordScopeEntryMatchWithNative,
  planResponsesStoreSweepWithNative,
  planResponsesReleaseRequestPayloadWithNative,
  planResponsesConversationRetentionWithNative,
  planResponsesConversationResumeEntryMatchWithNative,
  planResponsesScopeContinuationMatchWithNative,
  planResponsesContinuationLookupByResponseIdWithNative,
  prepareResponsesConversationEntryWithNative,
  restoreResponsesContinuationPayloadWithNative,
  resumeResponsesConversationPayloadWithNative,
  shouldAllowResponsesConversationContinuationWithNative,
  stripResponsesStoredContextInputMediaWithNative
} from '../../native/router-hotpath/native-shared-conversion-semantics.js';
import type { AnyRecord, ConversationEntry } from './responses-conversation-store-types.js';

export function assertResponsesConversationStoreNativeAvailable(): void {
  if (
    typeof buildResponsesConversationScopePlanWithNative !== 'function' ||
    typeof pickResponsesPersistedFieldsWithNative !== 'function' ||
    typeof convertResponsesOutputToInputItemsWithNative !== 'function' ||
    typeof prepareResponsesConversationEntryWithNative !== 'function' ||
    typeof materializeResponsesContinuationPayloadWithNative !== 'function' ||
    typeof restoreResponsesContinuationPayloadWithNative !== 'function' ||
    typeof resumeResponsesConversationPayloadWithNative !== 'function' ||
    typeof shouldAllowResponsesConversationContinuationWithNative !== 'function' ||
    typeof collectResponsesPendingToolCallIdsWithNative !== 'function' ||
    typeof planResponsesCapturePendingCleanupWithNative !== 'function' ||
    typeof planResponsesConversationPersistenceEligibilityWithNative !== 'function' ||
    typeof planResponsesRecordScopeCleanupWithNative !== 'function' ||
    typeof planResponsesRecordScopeEntryMatchWithNative !== 'function' ||
    typeof planResponsesStoreSweepWithNative !== 'function' ||
    typeof planResponsesReleaseRequestPayloadWithNative !== 'function' ||
    typeof planResponsesConversationRetentionWithNative !== 'function' ||
    typeof planResponsesConversationResumeEntryMatchWithNative !== 'function' ||
    typeof planResponsesContinuationLookupByResponseIdWithNative !== 'function' ||
    typeof planResponsesScopeContinuationMatchWithNative !== 'function' ||
    typeof stripResponsesStoredContextInputMediaWithNative !== 'function'
  ) {
    throw new Error('[responses-conversation-store] native bindings unavailable');
  }
}

export function buildConversationScopePlan(input: unknown): { keys: string[]; portScopeKey?: string } {
  return buildResponsesConversationScopePlanWithNative(input);
}

export function shouldAllowContinuation(payload: AnyRecord | undefined): boolean {
  return shouldAllowResponsesConversationContinuationWithNative(payload);
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

export function pickPersistedFields(payload: AnyRecord): AnyRecord {
  return pickResponsesPersistedFieldsWithNative(payload) as AnyRecord;
}

export function convertOutputToInputItems(response: AnyRecord): AnyRecord[] {
  return convertResponsesOutputToInputItemsWithNative(response) as AnyRecord[];
}

export function prepareConversationEntry(payload: AnyRecord, context: AnyRecord): {
  basePayload: AnyRecord;
  input: AnyRecord[];
  tools?: AnyRecord[];
} {
  const prepared = prepareResponsesConversationEntryWithNative(payload, context);
  return {
    basePayload: prepared.basePayload as AnyRecord,
    input: Array.isArray(prepared.input) ? (prepared.input as AnyRecord[]) : [],
    tools: Array.isArray(prepared.tools) ? (prepared.tools as AnyRecord[]) : undefined
  };
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
  const useReleasedPrefixSideChannelOnly =
    entry.continuationOwner === 'direct'
    && (!Array.isArray(entry.input) || entry.input.length === 0)
    && Array.isArray(entry.releasedInputPrefix)
    && entry.releasedInputPrefix.length > 0;
  const continuationInput = Array.isArray(entry.input) && entry.input.length > 0
    ? entry.input
    : (
      useReleasedPrefixSideChannelOnly
        ? []
        : (Array.isArray(entry.releasedInputPrefix) ? entry.releasedInputPrefix : [])
    );
  const restored = restoreResponsesContinuationPayloadWithNative(
    {
      requestId: entry.requestId,
      basePayload: entry.basePayload,
      input: continuationInput,
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
  const continuationInput = Array.isArray(entry.input) && entry.input.length > 0
    ? entry.input
    : (Array.isArray(entry.releasedInputPrefix) ? entry.releasedInputPrefix : []);
  const materialized = materializeResponsesContinuationPayloadWithNative(
    {
      requestId: entry.requestId,
      basePayload: entry.basePayload,
      input: continuationInput,
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
