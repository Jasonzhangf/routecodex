import {
  convertResponsesOutputToInputItemsWithNative,
  materializeResponsesContinuationPayloadWithNative,
  pickResponsesPersistedFieldsWithNative,
  prepareResponsesConversationEntryWithNative,
  restoreResponsesContinuationPayloadWithNative,
  resumeResponsesConversationPayloadWithNative
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';
import type { AnyRecord, ConversationEntry } from './responses-conversation-store-types.js';

export function assertResponsesConversationStoreNativeAvailable(): void {
  if (
    typeof pickResponsesPersistedFieldsWithNative !== 'function' ||
    typeof convertResponsesOutputToInputItemsWithNative !== 'function' ||
    typeof prepareResponsesConversationEntryWithNative !== 'function' ||
    typeof materializeResponsesContinuationPayloadWithNative !== 'function' ||
    typeof restoreResponsesContinuationPayloadWithNative !== 'function' ||
    typeof resumeResponsesConversationPayloadWithNative !== 'function'
  ) {
    throw new Error('[responses-conversation-store] native bindings unavailable');
  }
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
  const resumeInput = Array.isArray(entry.input) && entry.input.length > 0
    ? entry.input
    : (Array.isArray(entry.releasedInputPrefix) ? entry.releasedInputPrefix : []);
  const usesReleasedPrefixAsInput =
    (!Array.isArray(entry.input) || entry.input.length === 0)
    && Array.isArray(entry.releasedInputPrefix)
    && entry.releasedInputPrefix.length > 0;
  const resumed = resumeResponsesConversationPayloadWithNative(
    {
      requestId: entry.requestId,
      basePayload: entry.basePayload,
      input: resumeInput,
      releasedInputPrefix: entry.releasedInputPrefix,
      releasedPendingToolCallIds: entry.releasedPendingToolCallIds,
      tools: entry.tools,
      routeHint: entry.routeHint,
      providerKey: entry.providerKey
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
      releasedPendingToolCallIds: entry.releasedPendingToolCallIds,
      tools: entry.tools,
      routeHint: entry.routeHint,
      providerKey: entry.providerKey,
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
      releasedPendingToolCallIds: entry.releasedPendingToolCallIds,
      tools: entry.tools,
      routeHint: entry.routeHint,
      providerKey: entry.providerKey,
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
