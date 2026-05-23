export type AnyRecord = Record<string, unknown>;

export interface CaptureContextArgs {
  requestId?: string;
  payload: AnyRecord;
  context: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  routeHint?: string;
}

export interface RecordResponseArgs {
  requestId?: string;
  response: AnyRecord;
  routeHint?: string;
  sessionId?: string;
  conversationId?: string;
}

export interface ResumeOptions {
  requestId?: string;
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
}

export interface ConversationEntry {
  requestId: string;
  basePayload: AnyRecord;
  input: AnyRecord[];
  releasedPendingToolCallIds?: string[];
  tools?: AnyRecord[];
  routeHint?: string;
  createdAt: number;
  updatedAt: number;
  lastResponseId?: string;
  sessionId?: string;
  conversationId?: string;
  scopeKeys: string[];
}
