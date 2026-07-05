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
