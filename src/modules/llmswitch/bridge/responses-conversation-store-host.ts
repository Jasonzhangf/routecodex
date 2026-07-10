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

class ResponsesConversationStore {
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  getDebugStats(): StoreMetrics {
    return executeStoreOperation<StoreMetrics>('debug_stats');
  }

  deleteResponseIndexForDebug(responseId?: string): void {
    executeStoreOperation<null>('debug_delete_response_index', { responseId });
  }

  hasRequestForDebug(requestId?: string): boolean {
    return executeStoreOperation<boolean>('debug_has_request', { requestId });
  }

  hasResponseForDebug(responseId?: string): boolean {
    return executeStoreOperation<boolean>('debug_has_response', { responseId });
  }

  hasScopeForDebug(scopeKey?: string): boolean {
    return executeStoreOperation<boolean>('debug_has_scope', { scopeKey });
  }

  rebindRequestId(oldId: string | undefined, newId: string | undefined): void {
    executeStoreOperation<null>('rebind_request_id', { oldId, newId });
  }

  captureRequestContext(args: CaptureContextArgs): void {
    executeStoreOperation<unknown>('capture_request_context', args);
  }

  recordResponse(args: RecordResponseArgs): void {
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

  resumeConversation(responseId: string, submitPayload: AnyRecord, options?: ResumeOptions): ResumeResult {
    return executeStoreOperation<ResumeResult>('resume_conversation', { responseId, submitPayload, options });
  }

  lookupContinuationByResponseId(
    responseId: string,
    options?: ContinuationLookupOptions,
  ): ResponsesStoreLookupResult | null {
    return executeStoreOperation<ResponsesStoreLookupResult | null>('lookup_by_response_id', { responseId, options });
  }

  clearRequest(requestId?: string): void {
    executeStoreOperation<null>('clear_request', { requestId });
  }

  clearUnresolvedRequests(): number {
    const result = executeStoreOperation<{ cleared?: number }>('clear_unresolved');
    return typeof result?.cleared === 'number' ? result.cleared : 0;
  }

  releaseRequestPayload(requestId?: string): void {
    executeStoreOperation<null>('release_request_payload', { requestId });
  }

  finalizeResponsesConversationRequestRetention(
    requestId?: string,
    options?: { keepForSubmitToolOutputs?: boolean }
  ): void {
    executeStoreOperation<null>('finalize_retention', { requestId, options });
  }

  resumeLatestContinuationByScope(args: RestoreByScopeArgs): ResumeResult | null {
    return executeStoreOperation<ResumeResult | null>('resume_latest_by_scope', args);
  }

  materializeLatestContinuationByScope(args: RestoreByScopeArgs): ResumeResult | null {
    return executeStoreOperation<ResumeResult | null>('materialize_latest_by_scope', args);
  }

  startPruneTimer(): void {
    if (this.pruneTimer) return;
    const PRUNE_INTERVAL_MS = 60_000;
    this.pruneTimer = setInterval(() => {
      try {
        executeStoreOperation<unknown>('prune_expired');
      } catch (error) {
        logResponsesStoreNonBlockingError('prune.timer', error);
      }
    }, PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();
  }

  private stopPruneTimer(): void {
    if (!this.pruneTimer) return;
    clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }

  clearAll(): void {
    executeStoreOperation<null>('clear_all');
    this.stopPruneTimer();
  }

  clearAllAndPersist(): void {
    executeStoreOperation<null>('clear_all_and_persist');
    this.stopPruneTimer();
  }

  getLastPruneAt(): number {
    return executeStoreOperation<number>('get_last_prune_at');
  }
}

const RESPONSES_CONVERSATION_STORE_GLOBAL_KEY = "__rccResponsesConversationStore";

function isResponsesConversationStoreLike(value: unknown): value is ResponsesConversationStore {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { captureRequestContext?: unknown }).captureRequestContext === 'function'
    && typeof (value as { recordResponse?: unknown }).recordResponse === 'function'
    && typeof (value as { getDebugStats?: unknown }).getDebugStats === 'function'
  );
}

function resolveProcessResponsesConversationStore(): ResponsesConversationStore {
  const globals = globalThis as Record<string, unknown>;
  const existing = globals[RESPONSES_CONVERSATION_STORE_GLOBAL_KEY];
  if (isResponsesConversationStoreLike(existing)) {
    return existing;
  }
  const created = new ResponsesConversationStore();
  globals[RESPONSES_CONVERSATION_STORE_GLOBAL_KEY] = created;
  return created;
}

const store = resolveProcessResponsesConversationStore();
store.startPruneTimer();

export function captureResponsesRequestContext(args: CaptureContextArgs): void {
  try {
    if (RESPONSES_DEBUG) {
      console.log('[responses-store] capture', args.requestId);
    }
    store.captureRequestContext(args);
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
  store.recordResponse(args);
}

export function resumeResponsesConversation(
  responseId: string,
  submitPayload: AnyRecord,
  options?: ResumeOptions
): ResumeResult {
  if (RESPONSES_DEBUG) {
    console.log('[responses-store] resume', responseId);
  }
  return store.resumeConversation(responseId, submitPayload, options);
}

export function lookupResponsesContinuationByResponseId(
  responseId: string,
  options?: ContinuationLookupOptions,
): ResponsesStoreLookupResult | null {
  return store.lookupContinuationByResponseId(responseId, options);
}

export function clearResponsesConversationByRequestId(requestId?: string): void {
  if (RESPONSES_DEBUG && requestId) {
    console.log('[responses-store] clear', requestId);
  }
  store.clearRequest(requestId);
}

export function finalizeResponsesConversationRequestRetention(
  requestId?: string,
  options?: { keepForSubmitToolOutputs?: boolean }
): void {
  store.finalizeResponsesConversationRequestRetention(requestId, options);
}

export function rebindResponsesConversationRequestId(oldId?: string, newId?: string): void {
  if (RESPONSES_DEBUG && oldId && newId) {
    console.log('[responses-store] rebind', oldId, '->', newId);
  }
  store.rebindRequestId(oldId, newId);
}

export function resumeLatestResponsesContinuationByScope(args: RestoreByScopeArgs): ResumeResult | null {
  if (RESPONSES_DEBUG) {
    console.log('[responses-store] resume-by-scope', args.sessionId, args.conversationId);
  }
  return store.resumeLatestContinuationByScope(args);
}

export function materializeLatestResponsesContinuationByScope(args: RestoreByScopeArgs): ResumeResult | null {
  if (RESPONSES_DEBUG) {
    console.log('[responses-store] materialize-by-scope', args.sessionId, args.conversationId);
  }
  return store.materializeLatestContinuationByScope(args);
}

export function clearAllResponsesConversationState(): void {
  store.clearAllAndPersist();
}

export function resetResponsesConversationStateForRestartSimulation(): void {
  store.clearAll();
}

export function clearUnresolvedResponsesConversationRequests(): number {
  return store.clearUnresolvedRequests();
}

export function getResponsesConversationStoreDebugStats(): ReturnType<ResponsesConversationStore['getDebugStats']> {
  return store.getDebugStats();
}

export function releaseResponsesConversationRequestPayload(requestId?: string): void {
  store.releaseRequestPayload(requestId);
}

export function deleteResponsesConversationResponseIndexForDebug(responseId?: string): void {
  store.deleteResponseIndexForDebug(responseId);
}

export function hasResponsesConversationRequestForDebug(requestId?: string): boolean {
  return store.hasRequestForDebug(requestId);
}

export function hasResponsesConversationResponseForDebug(responseId?: string): boolean {
  return store.hasResponseForDebug(responseId);
}

export function hasResponsesConversationScopeForDebug(scopeKey?: string): boolean {
  return store.hasScopeForDebug(scopeKey);
}

(globalThis as Record<string, unknown>)[RESPONSES_CONVERSATION_STORE_GLOBAL_KEY] = store;
