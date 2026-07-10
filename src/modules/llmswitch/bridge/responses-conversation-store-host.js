import { getRouterHotpathJsonBindingSync } from './native-exports.js';
class ProviderProtocolError extends Error {
    code;
    protocol;
    providerType;
    category;
    details;
    constructor(message, options) {
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
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function executeStoreOperation(operation, payload) {
    const binding = getRouterHotpathJsonBindingSync();
    const fn = binding.executeResponsesConversationStoreOperationJson;
    if (typeof fn !== 'function') {
        throw new Error('[responses-conversation-store-host] executeResponsesConversationStoreOperationJson not available');
    }
    const raw = fn(JSON.stringify({
        operation,
        payload: payload ?? {},
        persistenceFilePath: process.env.ROUTECODEX_RESPONSES_CONVERSATION_STORE
    }));
    if (typeof raw !== 'string' || raw.length === 0) {
        throw new Error('[responses-conversation-store-host] executeResponsesConversationStoreOperationJson returned empty result');
    }
    const parsed = JSON.parse(raw);
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
const responsesWarnAt = new Map();
function logResponsesStoreNonBlockingError(stage, error, details) {
    const now = Date.now();
    const lastAt = responsesWarnAt.get(stage) ?? 0;
    if (now - lastAt < RESPONSES_WARN_THROTTLE_MS) {
        return;
    }
    responsesWarnAt.set(stage, now);
    try {
        const code = error instanceof ProviderProtocolError
            ? error.code
            : typeof details?.code === 'string'
                ? details.code
                : 'RESPONSES_STORE_NON_BLOCKING_ERROR';
        const reason = typeof details?.reason === 'string'
            ? details.reason
            : error instanceof Error && error.message.trim()
                ? error.message.trim()
                : 'unknown';
        console.warn(`[responses-store] ${stage} failed code=${code} reason=${reason}`);
    }
    catch {
        // Never throw from non-blocking logging.
    }
}
class ResponsesConversationStore {
    pruneTimer = null;
    rebindRequestId(oldId, newId) {
        executeStoreOperation('rebind_request_id', { oldId, newId });
    }
    captureRequestContext(args) {
        executeStoreOperation('capture_request_context', args);
    }
    recordResponse(args) {
        try {
            executeStoreOperation('record_response', args);
        }
        catch (error) {
            if (error instanceof ProviderProtocolError && error.code === 'RESPONSES_STORE_MISSING_REQUEST_CONTEXT') {
                logResponsesStoreNonBlockingError('record.missing_request_context', error, {
                    code: error.code,
                    reason: 'missing_request_context'
                });
            }
            throw error;
        }
    }
    resumeConversation(responseId, submitPayload, options) {
        return executeStoreOperation('resume_conversation', { responseId, submitPayload, options });
    }
    lookupContinuationByResponseId(responseId, options) {
        return executeStoreOperation('lookup_by_response_id', { responseId, options });
    }
    clearRequest(requestId) {
        executeStoreOperation('clear_request', { requestId });
    }
    clearUnresolvedRequests() {
        const result = executeStoreOperation('clear_unresolved');
        return typeof result?.cleared === 'number' ? result.cleared : 0;
    }
    releaseRequestPayload(requestId) {
        executeStoreOperation('release_request_payload', { requestId });
    }
    finalizeResponsesConversationRequestRetention(requestId, options) {
        executeStoreOperation('finalize_retention', { requestId, options });
    }
    resumeLatestContinuationByScope(args) {
        return executeStoreOperation('resume_latest_by_scope', args);
    }
    materializeLatestContinuationByScope(args) {
        return executeStoreOperation('materialize_latest_by_scope', args);
    }
    startPruneTimer() {
        if (this.pruneTimer)
            return;
        const PRUNE_INTERVAL_MS = 60_000;
        this.pruneTimer = setInterval(() => {
            try {
                executeStoreOperation('prune_expired');
            }
            catch (error) {
                logResponsesStoreNonBlockingError('prune.timer', error);
            }
        }, PRUNE_INTERVAL_MS);
        this.pruneTimer.unref?.();
    }
    stopPruneTimer() {
        if (!this.pruneTimer)
            return;
        clearInterval(this.pruneTimer);
        this.pruneTimer = null;
    }
    clearAll() {
        executeStoreOperation('clear_all');
        this.stopPruneTimer();
    }
    clearAllAndPersist() {
        executeStoreOperation('clear_all_and_persist');
        this.stopPruneTimer();
    }
    getLastPruneAt() {
        return executeStoreOperation('get_last_prune_at');
    }
}
const RESPONSES_CONVERSATION_STORE_GLOBAL_KEY = "__rccResponsesConversationStore";
function isResponsesConversationStoreLike(value) {
    return Boolean(value
            && typeof value === 'object'
            && !Array.isArray(value)
            && typeof value.captureRequestContext === 'function'
            && typeof value.recordResponse === 'function');
}
function resolveProcessResponsesConversationStore() {
    const globals = globalThis;
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
export function captureResponsesRequestContext(args) {
    try {
        if (RESPONSES_DEBUG) {
            console.log('[responses-store] capture', args.requestId);
        }
        store.captureRequestContext(args);
    }
    catch (error) {
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
export function recordResponsesResponse(args) {
    if (RESPONSES_DEBUG) {
        console.log('[responses-store] record', args.requestId, args.response?.id);
    }
    store.recordResponse(args);
}
export function resumeResponsesConversation(responseId, submitPayload, options) {
    if (RESPONSES_DEBUG) {
        console.log('[responses-store] resume', responseId);
    }
    return store.resumeConversation(responseId, submitPayload, options);
}
export function lookupResponsesContinuationByResponseId(responseId, options) {
    return store.lookupContinuationByResponseId(responseId, options);
}
export function clearResponsesConversationByRequestId(requestId) {
    if (RESPONSES_DEBUG && requestId) {
        console.log('[responses-store] clear', requestId);
    }
    store.clearRequest(requestId);
}
export function finalizeResponsesConversationRequestRetention(requestId, options) {
    store.finalizeResponsesConversationRequestRetention(requestId, options);
}
export function rebindResponsesConversationRequestId(oldId, newId) {
    if (RESPONSES_DEBUG && oldId && newId) {
        console.log('[responses-store] rebind', oldId, '->', newId);
    }
    store.rebindRequestId(oldId, newId);
}
export function resumeLatestResponsesContinuationByScope(args) {
    if (RESPONSES_DEBUG) {
        console.log('[responses-store] resume-by-scope', args.sessionId, args.conversationId);
    }
    return store.resumeLatestContinuationByScope(args);
}
export function materializeLatestResponsesContinuationByScope(args) {
    if (RESPONSES_DEBUG) {
        console.log('[responses-store] materialize-by-scope', args.sessionId, args.conversationId);
    }
    return store.materializeLatestContinuationByScope(args);
}
export function clearAllResponsesConversationState() {
    store.clearAllAndPersist();
}
export function resetResponsesConversationStateForRestartSimulation() {
    store.clearAll();
}
export function clearUnresolvedResponsesConversationRequests() {
    return store.clearUnresolvedRequests();
}
export function releaseResponsesConversationRequestPayload(requestId) {
    store.releaseRequestPayload(requestId);
}
globalThis[RESPONSES_CONVERSATION_STORE_GLOBAL_KEY] = store;
//# sourceMappingURL=responses-conversation-store-host.js.map
