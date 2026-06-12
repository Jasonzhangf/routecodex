export type AnyRecord = Record<string, unknown>;

export interface CaptureContextArgs {
  requestId?: string;
  payload: AnyRecord;
  context: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  providerKey?: string;
  matchedPort?: number;
  routingPolicyGroup?: string;
}


export interface RecordResponseArgs {
  requestId?: string;
  response: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  providerKey?: string;
  continuationOwner?: 'direct' | 'relay';
  matchedPort?: number;
  routingPolicyGroup?: string;
  allowScopeContinuation?: boolean;
}


export interface ResumeOptions {
  requestId?: string;
  matchedPort?: number;
  routingPolicyGroup?: string;
}

export interface ResumeResult {
  payload: AnyRecord;
  meta: AnyRecord;
}

export interface RestoreByScopeArgs {
  payload: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  requestId?: string;
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
  continuationOwner?: 'direct' | 'relay';
  createdAt: number;
  updatedAt: number;
  lastResponseId?: string;
  sessionId?: string;
  conversationId?: string;
  scopeKeys: string[];
  portScopeKey?: string;
}
