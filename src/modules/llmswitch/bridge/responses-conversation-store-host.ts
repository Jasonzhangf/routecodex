import { getRouterHotpathJsonBindingSync } from './native-exports.js';

type AnyRecord = Record<string, unknown>;
type ResponsesContinuationEntryKind = 'responses' | 'chat' | 'messages';
type ProviderProtocolErrorCategory = 'EXTERNAL_ERROR' | 'TOOL_ERROR' | 'INTERNAL_ERROR';

class ProviderProtocolError extends Error {
  readonly code: string;
  readonly protocol?: string;
  readonly providerType?: string;
  readonly category: ProviderProtocolErrorCategory;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    options: {
      code: string;
      protocol?: string;
      providerType?: string;
      category?: string;
      details?: Record<string, unknown>;
    }
  ) {
    super(message);
    this.name = 'ProviderProtocolError';
    this.code = options.code;
    this.protocol = options.protocol;
    this.providerType = options.providerType;
    this.category =
      options.category === 'TOOL_ERROR' || options.category === 'INTERNAL_ERROR' || options.category === 'EXTERNAL_ERROR'
        ? options.category
        : 'EXTERNAL_ERROR';
    this.details = options.details;
  }
}

interface CaptureContextArgs {
  requestId?: string;
  payload: AnyRecord;
  context: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  providerKey?: string;
  entryKind?: ResponsesContinuationEntryKind;
  matchedPort?: number;
  routingPolicyGroup?: string;
  routeHint?: string;
}

interface RecordResponseArgs {
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
  routeHint?: string;
}

interface ResumeOptions {
  requestId?: string;
  entryKind?: ResponsesContinuationEntryKind;
  continuationOwner?: 'direct' | 'relay';
  matchedPort?: number;
  routingPolicyGroup?: string;
}

interface RestoreByScopeArgs {
  payload: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  requestId?: string;
  entryKind?: ResponsesContinuationEntryKind;
  continuationOwner?: 'direct' | 'relay';
  matchedPort?: number;
  routingPolicyGroup?: string;
}

interface ResumeResult {
  payload: AnyRecord;
  meta: AnyRecord;
}

interface ContinuationLookupOptions {
  entryKind?: ResponsesContinuationEntryKind;
  continuationOwner?: 'direct' | 'relay';
  matchedPort?: number;
  routingPolicyGroup?: string;
}

interface ResponsesStoreLookupResult {
  responseId: string;
  providerKey?: string;
  continuationOwner?: 'direct' | 'relay';
  entryKind?: ResponsesContinuationEntryKind;
  requestId?: string;
}

interface StoreMetrics {
  requestMapSize: number;
  responseIndexSize: number;
  scopeIndexSize: number;
  requestEntriesWithoutLastResponseId: number;
  retainedInputItems: number;
}

type NativeStoreEnvelope<T> =
  | { ok: true; result: T }
  | {
      ok: false;
      error?: {
        code?: string;
        message?: string;
        protocol?: string;
        providerType?: string;
        category?: string;
        details?: Record<string, unknown>;
      };
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function executeStoreOperation<T>(operation: string, payload?: unknown): T {
  const binding = getRouterHotpathJsonBindingSync() as unknown as Record<string, unknown>;
  const fn = binding.executeResponsesConversationStoreOperationJson;
  if (typeof fn !== 'function') {
    throw new Error('[responses-conversation-store-host] executeResponsesConversationStoreOperationJson not available');
  }
  const raw = (fn as (inputJson: string) => string)(
    JSON.stringify({
      operation,
      payload: payload ?? {},
      persistenceFilePath: process.env.ROUTECODEX_RESPONSES_CONVERSATION_STORE
    })
  );
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('[responses-conversation-store-host] executeResponsesConversationStoreOperationJson returned empty result');
  }
  const parsed = JSON.parse(raw) as NativeStoreEnvelope<T>;
  if (parsed.ok === false) {
    const error = parsed.error ?? {};
    throw new ProviderProtocolError(error.message ?? 'Responses conversation store operation failed', {
      code: typeof error.code === 'string' ? error.code : 'RESPONSES_STORE_OPERATION_FAILED',
      protocol: typeof error.protocol === 'string' ? error.protocol : 'openai-responses',
      providerType: typeof error.providerType === 'string' ? error.providerType : 'responses',
      category: error.category,
      details: isRecord(error.details) ? error.details : undefined
    });
  }
  if (parsed.ok !== true) {
    throw new Error('[responses-conversation-store-host] executeResponsesConversationStoreOperationJson returned invalid envelope');
  }
  return parsed.result;
}

const RESPONSES_DEBUG = (process.env.ROUTECODEX_RESPONSES_DEBUG || '').trim() === '1';
const RESPONSES_WARN_THROTTLE_MS = 60_000;
const responsesWarnAt = new Map<string, number>();

function logResponsesStoreNonBlockingError(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  const now = Date.now();
  const lastAt = responsesWarnAt.get(stage) ?? 0;
  if (now - lastAt < RESPONSES_WARN_THROTTLE_MS) {
    return;
  }
  responsesWarnAt.set(stage, now);
  try {
    const code =
      error instanceof ProviderProtocolError
        ? error.code
        : typeof details?.code === 'string'
          ? details.code
          : 'RESPONSES_STORE_NON_BLOCKING_ERROR';
    const reason =
      typeof details?.reason === 'string'
        ? details.reason
        : error instanceof Error && error.message.trim()
          ? error.message.trim()
          : 'unknown';
    console.warn(`[responses-store] ${stage} failed code=${code} reason=${reason}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}

let pruneTimer: ReturnType<typeof setInterval> | null = null;

function startResponsesConversationStorePruneTimer(): void {
  if (pruneTimer) return;
  const PRUNE_INTERVAL_MS = 60_000;
  pruneTimer = setInterval(() => {
    try {
      executeStoreOperation<unknown>('prune_expired');
    } catch (error) {
      logResponsesStoreNonBlockingError('prune.timer', error);
    }
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref?.();
}

function stopResponsesConversationStorePruneTimer(): void {
  if (!pruneTimer) return;
  clearInterval(pruneTimer);
  pruneTimer = null;
}

function recordResponsesResponseNative(args: RecordResponseArgs): void {
  try {
    executeStoreOperation<unknown>('record_response', args);
  } catch (error) {
    if (error instanceof ProviderProtocolError && error.code === 'RESPONSES_STORE_MISSING_REQUEST_CONTEXT') {
      logResponsesStoreNonBlockingError('record.missing_request_context', error, {
        code: error.code,
        reason: 'missing_request_context'
      });
    }
    throw error;
  }
}

function clearResponsesConversationState(operation: 'clear_all' | 'clear_all_and_persist'): void {
  executeStoreOperation<null>(operation);
  stopResponsesConversationStorePruneTimer();
}

startResponsesConversationStorePruneTimer();

export function captureResponsesRequestContext(args: CaptureContextArgs): void {
  try {
    if (RESPONSES_DEBUG) {
      console.log('[responses-store] capture', args.requestId);
    }
    executeStoreOperation<unknown>('capture_request_context', args);
  } catch (error) {
    if (error instanceof ProviderProtocolError) {
      throw error;
    }
    logResponsesStoreNonBlockingError('capture', error, {
      requestId: args.requestId,
      sessionId: args.sessionId,
      conversationId: args.conversationId
    });
    throw error;
  }
}

export function recordResponsesResponse(args: RecordResponseArgs): void {
  if (RESPONSES_DEBUG) {
    console.log('[responses-store] record', args.requestId, (args.response as AnyRecord)?.id);
  }
  recordResponsesResponseNative(args);
}

export function resumeResponsesConversation(
  responseId: string,
  submitPayload: AnyRecord,
  options?: ResumeOptions
): ResumeResult {
  if (RESPONSES_DEBUG) {
    console.log('[responses-store] resume', responseId);
  }
  return executeStoreOperation<ResumeResult>('resume_conversation', { responseId, submitPayload, options });
}

export function lookupResponsesContinuationByResponseId(
  responseId: string,
  options?: ContinuationLookupOptions,
): ResponsesStoreLookupResult | null {
  return executeStoreOperation<ResponsesStoreLookupResult | null>('lookup_by_response_id', { responseId, options });
}

export function clearResponsesConversationByRequestId(requestId?: string): void {
  if (RESPONSES_DEBUG && requestId) {
    console.log('[responses-store] clear', requestId);
  }
  executeStoreOperation<null>('clear_request', { requestId });
}

export function finalizeResponsesConversationRequestRetention(
  requestId?: string,
  options?: { keepForSubmitToolOutputs?: boolean }
): void {
  executeStoreOperation<null>('finalize_retention', { requestId, options });
}

export function rebindResponsesConversationRequestId(oldId?: string, newId?: string): void {
  if (RESPONSES_DEBUG && oldId && newId) {
    console.log('[responses-store] rebind', oldId, '->', newId);
  }
  executeStoreOperation<null>('rebind_request_id', { oldId, newId });
}

export function resumeLatestResponsesContinuationByScope(args: RestoreByScopeArgs): ResumeResult | null {
  if (RESPONSES_DEBUG) {
    console.log('[responses-store] resume-by-scope', args.sessionId, args.conversationId);
  }
  return executeStoreOperation<ResumeResult | null>('resume_latest_by_scope', args);
}

export function materializeLatestResponsesContinuationByScope(args: RestoreByScopeArgs): ResumeResult | null {
  if (RESPONSES_DEBUG) {
    console.log('[responses-store] materialize-by-scope', args.sessionId, args.conversationId);
  }
  return executeStoreOperation<ResumeResult | null>('materialize_latest_by_scope', args);
}

export function clearAllResponsesConversationState(): void {
  clearResponsesConversationState('clear_all_and_persist');
}

export function resetResponsesConversationStateForRestartSimulation(): void {
  clearResponsesConversationState('clear_all');
}

export function clearUnresolvedResponsesConversationRequests(): number {
  const result = executeStoreOperation<{ cleared?: number }>('clear_unresolved');
  return typeof result?.cleared === 'number' ? result.cleared : 0;
}

export function getResponsesConversationStoreDebugStats(): StoreMetrics {
  return executeStoreOperation<StoreMetrics>('debug_stats');
}

export function releaseResponsesConversationRequestPayload(requestId?: string): void {
  executeStoreOperation<null>('release_request_payload', { requestId });
}
