import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireCoreDist } from './module-loader.js';
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
function getResponsesConversationStoreNative() {
    return requireCoreDist('conversion/shared/responses-conversation-store-native');
}
function requireResponsesStoreNativeFn(name) {
    const responsesConversationStoreNative = getResponsesConversationStoreNative();
    const fn = responsesConversationStoreNative[name];
    if (typeof fn !== 'function') {
        throw new Error(`[responses-conversation-store-host] ${String(name)} not available`);
    }
    return fn;
}
function lazyResponsesStoreNativeFn(name) {
    return (...args) => requireResponsesStoreNativeFn(name)(...args);
}
const assertResponsesConversationStoreNativeAvailable = lazyResponsesStoreNativeFn('assertResponsesConversationStoreNativeAvailable');
const buildConversationScopePlan = lazyResponsesStoreNativeFn('buildConversationScopePlan');
const collectPendingToolCallIds = lazyResponsesStoreNativeFn('collectPendingToolCallIds');
const convertOutputToInputItems = lazyResponsesStoreNativeFn('convertOutputToInputItems');
const materializeContinuationPayload = lazyResponsesStoreNativeFn('materializeContinuationPayload');
const planAttachEntryScopes = lazyResponsesStoreNativeFn('planAttachEntryScopes');
const planCapturePendingCleanup = lazyResponsesStoreNativeFn('planCapturePendingCleanup');
const planCapturedEntry = lazyResponsesStoreNativeFn('planCapturedEntry');
const planConversationPreflight = lazyResponsesStoreNativeFn('planConversationPreflight');
const planContinuationLookupByResponseId = lazyResponsesStoreNativeFn('planContinuationLookupByResponseId');
const planContinuationMeta = lazyResponsesStoreNativeFn('planContinuationMeta');
const planConversationRetention = lazyResponsesStoreNativeFn('planConversationRetention');
const planPersistedEntry = lazyResponsesStoreNativeFn('planPersistedEntry');
const planPersistenceEligibility = lazyResponsesStoreNativeFn('planPersistenceEligibility');
const planRebindRequestId = lazyResponsesStoreNativeFn('planRebindRequestId');
const planReleaseRequestPayload = lazyResponsesStoreNativeFn('planReleaseRequestPayload');
const planRecordScopeCleanup = lazyResponsesStoreNativeFn('planRecordScopeCleanup');
const planRecordContinuationFlag = lazyResponsesStoreNativeFn('planRecordContinuationFlag');
const planRecordScopeEntryMatch = lazyResponsesStoreNativeFn('planRecordScopeEntryMatch');
const planResumeEntryMatch = lazyResponsesStoreNativeFn('planResumeEntryMatch');
const planStoreSweep = lazyResponsesStoreNativeFn('planStoreSweep');
const planStoreTokens = lazyResponsesStoreNativeFn('planStoreTokens');
const planScopeContinuationMatch = lazyResponsesStoreNativeFn('planScopeContinuationMatch');
const restoreContinuationPayload = lazyResponsesStoreNativeFn('restoreContinuationPayload');
const resumeConversationPayload = lazyResponsesStoreNativeFn('resumeConversationPayload');
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
const TTL_MS = 1000 * 60 * 30; // 30min
const PERSIST_SCHEMA_VERSION = 1;
function resolvePersistFilePath() {
    const explicit = typeof process.env.ROUTECODEX_RESPONSES_CONVERSATION_STORE === 'string'
        ? process.env.ROUTECODEX_RESPONSES_CONVERSATION_STORE.trim()
        : '';
    if (explicit)
        return explicit;
    const home = typeof process.env.ROUTECODEX_HOME === 'string' && process.env.ROUTECODEX_HOME.trim()
        ? process.env.ROUTECODEX_HOME.trim()
        : path.join(os.homedir(), '.rcc');
    return path.join(home, 'state', 'responses-conversation-store.json');
}
function cloneJsonRecord(value) {
    if (!isRecord(value))
        return undefined;
    try {
        const cloned = JSON.parse(JSON.stringify(value));
        return isRecord(cloned) ? cloned : undefined;
    }
    catch {
        return undefined;
    }
}
function serializeEntry(entry) {
    const cloned = cloneJsonRecord(entry);
    if (!cloned)
        return undefined;
    const plan = planPersistedEntry({ mode: 'serialize', entry: cloned });
    return plan.action === 'entry' ? plan.entry : undefined;
}
function deserializeEntry(value) {
    const cloned = cloneJsonRecord(value);
    if (!cloned)
        return undefined;
    const plan = planPersistedEntry({ mode: 'deserialize', entry: cloned, nowMs: Date.now() });
    return plan.action === 'entry' ? plan.entry : undefined;
}
function normalizeStoreTokens(input) {
    return planStoreTokens(input);
}
function readPortScopeKey(scope) {
    if (!scope)
        return undefined;
    return buildConversationScopePlan({ mode: 'stored', scope }).portScopeKey;
}
function buildStoredScopeKeysFromResolved(scope, portScopeKey) {
    return buildConversationScopePlan({
        mode: 'stored',
        scope: {
            ...scope,
            ...(portScopeKey ? { portScopeKey } : {})
        }
    }).keys;
}
function buildStoredScopeKeys(scope) {
    return buildConversationScopePlan({ mode: 'stored', scope }).keys;
}
function buildRequestedScopeKeys(scope) {
    return buildConversationScopePlan({ mode: 'requested', scope }).keys;
}
function readResumeScopeKeysFromSubmitPayload(payload) {
    return buildConversationScopePlan({ mode: 'submit_payload', payload }).keys;
}
function ensureMetaProviderKey(meta, entry) {
    return planContinuationMeta({ meta, entry }).meta;
}
function collectScopeMatchCandidates(scopeIndex, scopeKeys) {
    const entriesByScopeKey = new Map();
    const candidates = [];
    for (const scopeKey of scopeKeys) {
        const entry = scopeIndex.get(scopeKey);
        if (!entry)
            continue;
        entriesByScopeKey.set(scopeKey, entry);
        const tokens = normalizeStoreTokens({ continuationOwner: entry.continuationOwner });
        candidates.push({
            scopeKey,
            requestId: entry.requestId,
            lastResponseId: entry.lastResponseId,
            allowContinuation: entry.allowContinuation,
            continuationOwner: tokens.continuationOwner
        });
    }
    return { entriesByScopeKey, candidates };
}
function projectResumeEntryCandidate(entry, source, scopeKey) {
    const tokens = normalizeStoreTokens({
        entryKind: entry.entryKind,
        continuationOwner: entry.continuationOwner
    });
    return {
        source,
        scopeKey: scopeKey ?? '',
        requestId: entry.requestId,
        lastResponseId: entry.lastResponseId,
        allowContinuation: entry.allowContinuation,
        continuationOwner: tokens.continuationOwner,
        portScopeKey: entry.portScopeKey,
        entryKind: tokens.entryKind
    };
}
class ResponsesConversationStore {
    requestMap = new Map();
    responseIndex = new Map();
    scopeIndex = new Map();
    pruneTimer = null;
    lastPruneAt = 0;
    persistenceLoaded = false;
    ensurePersistenceLoaded() {
        if (this.persistenceLoaded)
            return;
        this.persistenceLoaded = true;
        let parsed;
        const persistFilePath = resolvePersistFilePath();
        try {
            if (!fs.existsSync(persistFilePath))
                return;
            parsed = JSON.parse(fs.readFileSync(persistFilePath, 'utf8'));
        }
        catch (error) {
            logResponsesStoreNonBlockingError('persist.load', error, { file: persistFilePath });
            return;
        }
        if (!isRecord(parsed) || parsed.version !== PERSIST_SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
            return;
        }
        const now = Date.now();
        for (const row of parsed.entries) {
            const entry = deserializeEntry(row);
            if (!entry)
                continue;
            const plan = planPersistenceEligibility(entry, { mode: 'load', nowMs: now, ttlMs: TTL_MS });
            if (plan.action !== 'persist' || !plan.lastResponseId)
                continue;
            this.requestMap.set(entry.requestId, entry);
            this.responseIndex.set(plan.lastResponseId, entry);
            this.attachEntryScopes(entry);
        }
    }
    flushPersistence() {
        if (!this.persistenceLoaded)
            return;
        const entries = [];
        const persistFilePath = resolvePersistFilePath();
        const seen = new Set();
        for (const entry of this.responseIndex.values()) {
            if (seen.has(entry))
                continue;
            const plan = planPersistenceEligibility(entry, { mode: 'flush' });
            if (plan.action !== 'persist' || !plan.lastResponseId)
                continue;
            seen.add(entry);
            const serialized = serializeEntry(entry);
            if (serialized)
                entries.push(serialized);
        }
        try {
            fs.mkdirSync(path.dirname(persistFilePath), { recursive: true });
            const tmpFile = `${persistFilePath}.${process.pid}.tmp`;
            fs.writeFileSync(tmpFile, JSON.stringify({ version: PERSIST_SCHEMA_VERSION, entries }, null, 2));
            fs.renameSync(tmpFile, persistFilePath);
        }
        catch (error) {
            logResponsesStoreNonBlockingError('persist.flush', error, { file: persistFilePath });
        }
    }
    getDebugStats() {
        let requestEntriesWithoutLastResponseId = 0;
        let retainedInputItems = 0;
        for (const entry of this.requestMap.values()) {
            if (typeof entry.lastResponseId !== 'string' || !entry.lastResponseId.trim()) {
                requestEntriesWithoutLastResponseId += 1;
            }
            retainedInputItems += Array.isArray(entry.input) ? entry.input.length : 0;
        }
        return {
            requestMapSize: this.requestMap.size,
            responseIndexSize: this.responseIndex.size,
            scopeIndexSize: this.scopeIndex.size,
            requestEntriesWithoutLastResponseId,
            retainedInputItems
        };
    }
    rebindRequestId(oldId, newId) {
        const plan = planRebindRequestId({
            oldId,
            newId,
            oldEntryExists: Boolean(oldId && this.requestMap.has(oldId)),
            newEntryExists: Boolean(newId && this.requestMap.has(newId))
        });
        if (plan.action !== 'rebind' || !plan.oldId || !plan.newId) {
            return;
        }
        const entry = this.requestMap.get(plan.oldId);
        if (!entry)
            return;
        this.requestMap.delete(plan.oldId);
        entry.requestId = plan.newId;
        this.requestMap.set(plan.newId, entry);
    }
    captureRequestContext(args) {
        this.ensurePersistenceLoaded();
        const { payload, context } = args;
        const capturePreflight = planConversationPreflight({
            mode: 'capture_request',
            requestId: args.requestId,
            payload
        });
        if (capturePreflight.action !== 'continue')
            return;
        const requestId = capturePreflight.requestId ?? args.requestId;
        if (!requestId) {
            throw new ProviderProtocolError('Responses conversation request capture requires request id', {
                code: 'MALFORMED_REQUEST',
                protocol: 'openai-responses',
                providerType: 'responses',
                details: {
                    context: 'responses-conversation-store.captureRequestContext',
                    reason: 'missing_request_id'
                }
            });
        }
        this.prune();
        assertResponsesConversationStoreNativeAvailable();
        const existing = this.requestMap.get(requestId);
        if (existing) {
            this.detachEntry(existing);
        }
        const scopeKeys = buildStoredScopeKeys({
            ...args,
            entryKind: normalizeStoreTokens({ entryKind: args.entryKind }).entryKind,
            continuationOwner: 'relay'
        });
        const portScopeKey = readPortScopeKey(args);
        const cleanupCandidates = scopeKeys.length
            ? [...this.requestMap.values()].map((candidate) => ({
                requestId: candidate.requestId,
                lastResponseId: candidate.lastResponseId,
                scopeKeys: Array.isArray(candidate.scopeKeys) ? candidate.scopeKeys : []
            }))
            : [];
        const cleanupPlan = planCapturePendingCleanup({
            requestId,
            scopeKeys,
            candidates: cleanupCandidates
        });
        for (const detachRequestId of cleanupPlan.detachRequestIds) {
            const candidate = this.requestMap.get(detachRequestId);
            if (candidate)
                this.detachEntry(candidate);
        }
        const entryTokens = normalizeStoreTokens({
            providerKey: args.providerKey,
            fallbackProviderKey: payload.providerKey,
            sessionId: args.sessionId,
            conversationId: args.conversationId,
            entryKind: args.entryKind
        });
        const entryPlan = planCapturedEntry({
            requestId,
            providerKey: entryTokens.providerKey,
            sessionId: entryTokens.sessionId,
            conversationId: entryTokens.conversationId,
            entryKind: entryTokens.entryKind,
            payload,
            context,
            scopeKeys,
            portScopeKey,
            nowMs: Date.now()
        });
        if (entryPlan.action !== 'entry' || !entryPlan.entry)
            return;
        const entry = entryPlan.entry;
        this.requestMap.set(requestId, entry);
        this.flushPersistence();
    }
    recordResponse(args) {
        this.ensurePersistenceLoaded();
        const response = args.response;
        const recordPreflight = planConversationPreflight({
            mode: 'record_response',
            requestId: args.requestId,
            response
        });
        const responseId = recordPreflight.responseId;
        const requestId = recordPreflight.requestId ?? '';
        if (recordPreflight.action === 'throw' && recordPreflight.reason === 'missing_request_id') {
            throw new ProviderProtocolError('Responses conversation response capture requires request context', {
                code: 'MALFORMED_RESPONSE',
                protocol: 'openai-responses',
                providerType: 'responses',
                details: {
                    context: 'responses-conversation-store.recordResponse',
                    reason: 'missing_request_id',
                    responseId
                }
            });
        }
        let entry = this.requestMap.get(requestId);
        if (!entry && responseId) {
            entry = this.requestMap.get(responseId);
        }
        if (!entry) {
            logResponsesStoreNonBlockingError('record.missing_request_context', new Error('missing_request_context'), {
                code: 'RESPONSES_STORE_MISSING_REQUEST_CONTEXT',
                reason: 'missing_request_context',
                requestId,
                responseId,
                providerKey: args.providerKey,
                sessionId: args.sessionId,
                conversationId: args.conversationId,
                matchedPort: args.matchedPort,
                routingPolicyGroup: args.routingPolicyGroup
            });
            throw new ProviderProtocolError('Responses conversation request context missing for response capture', {
                code: 'RESPONSES_STORE_MISSING_REQUEST_CONTEXT',
                protocol: 'openai-responses',
                providerType: 'responses',
                category: 'INTERNAL_ERROR',
                details: {
                    context: 'responses-conversation-store.recordResponse',
                    reason: 'missing_request_context',
                    requestId,
                    responseId
                }
            });
        }
        if (recordPreflight.action === 'throw' && recordPreflight.reason === 'missing_response_id') {
            throw new ProviderProtocolError('Responses conversation response capture requires response id', {
                code: 'MALFORMED_RESPONSE',
                protocol: 'openai-responses',
                providerType: 'responses',
                details: {
                    context: 'responses-conversation-store.recordResponse',
                    reason: 'missing_response_id',
                    requestId
                }
            });
        }
        if (recordPreflight.action !== 'continue' || !responseId) {
            throw new ProviderProtocolError('Responses conversation response capture preflight failed', {
                code: 'MALFORMED_RESPONSE',
                protocol: 'openai-responses',
                providerType: 'responses',
                details: {
                    context: 'responses-conversation-store.recordResponse',
                    reason: recordPreflight.reason,
                    requestId,
                    responseId
                }
            });
        }
        const responsePortScopeKey = readPortScopeKey(args);
        if (responsePortScopeKey && !entry.portScopeKey) {
            entry.portScopeKey = responsePortScopeKey;
        }
        const responseTokens = normalizeStoreTokens({
            providerKey: args.providerKey,
            sessionId: args.sessionId,
            conversationId: args.conversationId,
            entryKind: args.entryKind ?? entry.entryKind,
            continuationOwner: args.continuationOwner,
            fallbackContinuationOwner: entry.continuationOwner ?? 'relay'
        });
        if (responseTokens.providerKey) {
            entry.providerKey = responseTokens.providerKey;
        }
        entry.sessionId = responseTokens.sessionId ?? entry.sessionId;
        entry.conversationId = responseTokens.conversationId ?? entry.conversationId;
        entry.entryKind = responseTokens.entryKind;
        entry.continuationOwner = responseTokens.continuationOwner;
        const nextScopeKeys = buildStoredScopeKeysFromResolved({
            sessionId: entry.sessionId,
            conversationId: entry.conversationId,
            entryKind: entry.entryKind,
            continuationOwner: entry.continuationOwner
        }, responsePortScopeKey ?? entry.portScopeKey);
        entry.scopeKeys = nextScopeKeys;
        if (entry.lastResponseId) {
            this.responseIndex.delete(entry.lastResponseId);
        }
        const assistantBlocks = convertOutputToInputItems(response);
        if (assistantBlocks.length) {
            entry.input.push(...assistantBlocks);
        }
        const continuationPlan = planRecordContinuationFlag({
            allowContinuation: entry.allowContinuation,
            pendingToolCallIds: collectPendingToolCallIds(entry.input)
        });
        entry.allowContinuation = continuationPlan.allowContinuation;
        entry.lastResponseId = responseId;
        entry.updatedAt = Date.now();
        this.responseIndex.set(responseId, entry);
        const recordCleanupCandidates = new Map();
        for (const scopeKey of entry.scopeKeys) {
            const previous = this.scopeIndex.get(scopeKey);
            if (previous) {
                recordCleanupCandidates.set(previous.requestId, {
                    requestId: previous.requestId,
                    lastResponseId: previous.lastResponseId,
                    scopeKeys: Array.isArray(previous.scopeKeys) ? previous.scopeKeys : []
                });
            }
        }
        for (const candidate of this.requestMap.values()) {
            recordCleanupCandidates.set(candidate.requestId, {
                requestId: candidate.requestId,
                lastResponseId: candidate.lastResponseId,
                scopeKeys: Array.isArray(candidate.scopeKeys) ? candidate.scopeKeys : []
            });
        }
        const recordCleanupPlan = planRecordScopeCleanup({
            requestId: entry.requestId,
            scopeKeys: entry.scopeKeys,
            candidates: [...recordCleanupCandidates.values()]
        });
        for (const detachRequestId of recordCleanupPlan.detachRequestIds) {
            const candidate = this.requestMap.get(detachRequestId);
            if (candidate)
                this.detachEntry(candidate);
        }
        this.attachEntryScopes(entry);
        this.flushPersistence();
    }
    resumeConversation(responseId, submitPayload, options) {
        this.ensurePersistenceLoaded();
        const resumePreflight = planConversationPreflight({
            mode: 'resume_conversation',
            responseId,
            submitPayload
        });
        if (resumePreflight.action === 'throw' && resumePreflight.reason === 'missing_or_empty_response_id') {
            throw new ProviderProtocolError('Responses conversation requires valid response_id', {
                code: 'MALFORMED_REQUEST',
                protocol: 'openai-responses',
                providerType: 'responses',
                details: {
                    context: 'responses-conversation-store.resumeConversation',
                    reason: 'missing_or_empty_response_id'
                }
            });
        }
        const normalizedResponseId = resumePreflight.responseId;
        if (!normalizedResponseId) {
            throw new ProviderProtocolError('Responses conversation resume preflight failed', {
                code: 'MALFORMED_REQUEST',
                protocol: 'openai-responses',
                providerType: 'responses',
                details: {
                    context: 'responses-conversation-store.resumeConversation',
                    reason: resumePreflight.reason
                }
            });
        }
        this.prune();
        const requestedPortScopeKey = readPortScopeKey(options);
        const entriesByRequestId = new Map();
        const candidates = [];
        const indexedEntry = this.responseIndex.get(normalizedResponseId);
        if (indexedEntry) {
            entriesByRequestId.set(indexedEntry.requestId, indexedEntry);
            candidates.push(projectResumeEntryCandidate(indexedEntry, 'response_index'));
        }
        else {
            for (const candidate of this.requestMap.values()) {
                entriesByRequestId.set(candidate.requestId, candidate);
                candidates.push(projectResumeEntryCandidate(candidate, 'request_map'));
            }
        }
        for (const scopeKey of readResumeScopeKeysFromSubmitPayload(submitPayload)) {
            const candidate = this.scopeIndex.get(scopeKey);
            if (!candidate)
                continue;
            entriesByRequestId.set(candidate.requestId, candidate);
            candidates.push(projectResumeEntryCandidate(candidate, 'scope', scopeKey));
        }
        const plan = planResumeEntryMatch({
            responseId: normalizedResponseId,
            requestedPortScopeKey,
            options,
            candidates
        });
        if (plan.action === 'ambiguous') {
            throw new ProviderProtocolError('Responses conversation response_id index is ambiguous', {
                code: 'MALFORMED_REQUEST',
                protocol: 'openai-responses',
                providerType: 'responses',
                details: {
                    context: 'responses-conversation-store.resumeConversation',
                    reason: 'ambiguous_response_id_index',
                    responseId: normalizedResponseId
                }
            });
        }
        const entry = plan.action === 'select' && plan.requestId
            ? entriesByRequestId.get(plan.requestId)
            : undefined;
        if (!entry) {
            throw new ProviderProtocolError('Responses conversation expired or not found', {
                code: 'MALFORMED_REQUEST',
                protocol: 'openai-responses',
                providerType: 'responses',
                details: {
                    context: 'responses-conversation-store.resumeConversation',
                    reason: 'expired_or_unknown_response_id',
                    responseId: normalizedResponseId
                }
            });
        }
        if (plan.source === 'request_map') {
            this.responseIndex.set(normalizedResponseId, entry);
        }
        if (resumePreflight.action === 'throw' && resumePreflight.reason === 'missing_tool_outputs') {
            throw new ProviderProtocolError('tool_outputs array is required when submitting Responses tool results', {
                code: 'MALFORMED_REQUEST',
                protocol: 'openai-responses',
                providerType: 'responses',
                details: {
                    context: 'responses-conversation-store.resumeConversation',
                    reason: 'missing_tool_outputs',
                    responseId: normalizedResponseId
                }
            });
        }
        if (resumePreflight.action !== 'continue') {
            throw new ProviderProtocolError('Responses conversation resume preflight failed', {
                code: 'MALFORMED_REQUEST',
                protocol: 'openai-responses',
                providerType: 'responses',
                details: {
                    context: 'responses-conversation-store.resumeConversation',
                    reason: resumePreflight.reason,
                    responseId: normalizedResponseId
                }
            });
        }
        assertResponsesConversationStoreNativeAvailable();
        const resumed = resumeConversationPayload(entry, normalizedResponseId, submitPayload, options?.requestId);
        this.cleanupEntry(entry, normalizedResponseId);
        this.flushPersistence();
        return {
            payload: resumed.payload,
            meta: ensureMetaProviderKey(resumed.meta, entry)
        };
    }
    lookupContinuationByResponseId(responseId, options) {
        this.ensurePersistenceLoaded();
        if (typeof responseId !== 'string' || !responseId.trim()) {
            return null;
        }
        this.prune();
        const requestedPortScopeKey = readPortScopeKey(options);
        const entry = this.responseIndex.get(responseId.trim());
        const plan = planContinuationLookupByResponseId({
            responseId: responseId.trim(),
            requestedPortScopeKey,
            options,
            entry
        });
        if (plan.action !== 'select' || !plan.responseId) {
            return null;
        }
        return {
            responseId: plan.responseId,
            providerKey: plan.providerKey,
            continuationOwner: plan.continuationOwner,
            entryKind: plan.entryKind,
            requestId: plan.requestId,
        };
    }
    clearRequest(requestId) {
        this.ensurePersistenceLoaded();
        if (!requestId)
            return;
        const entry = this.requestMap.get(requestId);
        if (!entry)
            return;
        if (RESPONSES_DEBUG) {
            console.log('[responses-store] clear.request', requestId, entry.lastResponseId);
        }
        this.detachEntry(entry);
        this.flushPersistence();
    }
    clearUnresolvedRequests() {
        this.ensurePersistenceLoaded();
        const plan = planStoreSweep({
            mode: 'clear_unresolved',
            candidates: [...this.requestMap.values()].map((entry) => ({
                requestId: entry.requestId,
                lastResponseId: entry.lastResponseId,
                updatedAt: entry.updatedAt
            }))
        });
        let cleared = 0;
        for (const requestId of plan.detachRequestIds) {
            const entry = this.requestMap.get(requestId);
            if (!entry)
                continue;
            this.detachEntry(entry);
            cleared += 1;
        }
        this.pruneIndexes();
        if (cleared > 0)
            this.flushPersistence();
        return cleared;
    }
    releaseRequestPayload(requestId) {
        this.ensurePersistenceLoaded();
        if (!requestId)
            return;
        const entry = this.requestMap.get(requestId);
        if (!entry)
            return;
        const plan = planReleaseRequestPayload(entry);
        entry.releasedInputPrefix = plan.releasedInputPrefix;
        entry.basePayload = plan.basePayload;
        entry.releasedPendingToolCallIds = plan.releasedPendingToolCallIds;
        entry.input = plan.input;
        entry.updatedAt = Date.now();
        this.attachEntryScopes(entry);
        this.flushPersistence();
    }
    finalizeResponsesConversationRequestRetention(requestId, options) {
        if (!requestId) {
            return;
        }
        const entry = this.requestMap.get(requestId);
        if (!entry) {
            return;
        }
        const plan = planConversationRetention(entry, options);
        if (plan.action === 'noop')
            return;
        if (RESPONSES_DEBUG) {
            if (plan.reason === 'missing_response') {
                console.log('[responses-store] finalize.clear_missing_response', requestId);
            }
            else if (plan.reason === 'missing_scope') {
                console.log('[responses-store] finalize.clear_missing_scope', requestId, plan.lastResponseId);
            }
            else if (plan.reason === 'keep_for_submit') {
                console.log('[responses-store] finalize.keep_for_submit', requestId, plan.lastResponseId);
            }
            else {
                console.log('[responses-store] finalize.release', requestId, plan.lastResponseId);
            }
        }
        if (plan.action === 'clear') {
            this.clearRequest(requestId);
            return;
        }
        this.releaseRequestPayload(requestId);
    }
    resumeLatestContinuationByScope(args) {
        this.ensurePersistenceLoaded();
        this.prune();
        const requestTokens = normalizeStoreTokens({
            entryKind: args.entryKind,
            continuationOwner: args.continuationOwner
        });
        const scopeKeys = buildRequestedScopeKeys({
            ...args,
            entryKind: requestTokens.entryKind
        });
        const { entriesByScopeKey, candidates } = collectScopeMatchCandidates(this.scopeIndex, scopeKeys);
        const plan = planScopeContinuationMatch({
            mode: 'resume',
            candidates,
            options: { continuationOwner: requestTokens.continuationOwner }
        });
        if (plan.action !== 'restore' || !plan.scopeKey) {
            return null;
        }
        const match = entriesByScopeKey.get(plan.scopeKey);
        if (!match) {
            return null;
        }
        assertResponsesConversationStoreNativeAvailable();
        const restored = restoreContinuationPayload(match, args.payload, args.requestId, plan.scopeKey);
        if (!restored) {
            return null;
        }
        return {
            payload: restored.payload,
            meta: ensureMetaProviderKey(restored.meta, match)
        };
    }
    materializeLatestContinuationByScope(args) {
        this.ensurePersistenceLoaded();
        this.prune();
        const requestTokens = normalizeStoreTokens({
            entryKind: args.entryKind,
            continuationOwner: args.continuationOwner
        });
        const scopeKeys = buildRequestedScopeKeys({
            ...args,
            entryKind: requestTokens.entryKind
        });
        const { entriesByScopeKey, candidates } = collectScopeMatchCandidates(this.scopeIndex, scopeKeys);
        const plan = planScopeContinuationMatch({
            mode: 'materialize',
            candidates,
            options: { continuationOwner: requestTokens.continuationOwner }
        });
        if (plan.action !== 'materialize' || !plan.scopeKey) {
            return null;
        }
        const match = entriesByScopeKey.get(plan.scopeKey);
        if (!match) {
            return null;
        }
        assertResponsesConversationStoreNativeAvailable();
        const materialized = materializeContinuationPayload(match, args.payload, args.requestId, plan.scopeKey);
        if (!materialized) {
            return null;
        }
        return {
            payload: materialized.payload,
            meta: ensureMetaProviderKey(materialized.meta, match)
        };
    }
    cleanupEntry(entry, responseId) {
        this.responseIndex.delete(responseId);
        this.detachEntry(entry);
    }
    attachEntryScopes(entry) {
        const attachPlan = planAttachEntryScopes({
            requestId: entry.requestId,
            scopeKeys: entry.scopeKeys,
            candidates: entry.scopeKeys.map((scopeKey) => ({
                scopeKey,
                requestId: this.scopeIndex.get(scopeKey)?.requestId
            }))
        });
        for (const detachRequestId of attachPlan.detachRequestIds) {
            const previous = this.requestMap.get(detachRequestId);
            if (previous)
                this.detachEntry(previous);
        }
        for (const key of attachPlan.scopeKeys) {
            this.scopeIndex.set(key, entry);
        }
    }
    detachEntry(entry) {
        for (const [requestId, candidate] of this.requestMap.entries()) {
            if (candidate === entry) {
                this.requestMap.delete(requestId);
            }
        }
        if (entry.lastResponseId) {
            this.responseIndex.delete(entry.lastResponseId);
        }
        for (const key of entry.scopeKeys) {
            const current = this.scopeIndex.get(key);
            if (current === entry) {
                this.scopeIndex.delete(key);
            }
        }
    }
    prune() {
        this.ensurePersistenceLoaded();
        this.lastPruneAt = Date.now();
        const plan = planStoreSweep({
            mode: 'prune_expired',
            nowMs: this.lastPruneAt,
            ttlMs: TTL_MS,
            candidates: [...this.requestMap.values()].map((entry) => ({
                requestId: entry.requestId,
                lastResponseId: entry.lastResponseId,
                updatedAt: entry.updatedAt
            }))
        });
        for (const requestId of plan.detachRequestIds) {
            const entry = this.requestMap.get(requestId);
            if (!entry)
                continue;
            this.detachEntry(entry);
        }
        this.pruneIndexes();
        this.flushPersistence();
    }
    pruneIndexes() {
        for (const [respId, entry] of this.responseIndex.entries()) {
            if (!this.requestMap.has(entry.requestId)) {
                this.responseIndex.delete(respId);
            }
        }
        for (const [scopeKey, entry] of this.scopeIndex.entries()) {
            if (!this.requestMap.has(entry.requestId)) {
                this.scopeIndex.delete(scopeKey);
            }
        }
    }
    startPruneTimer() {
        if (this.pruneTimer)
            return;
        const PRUNE_INTERVAL_MS = 60_000; // 1min
        this.pruneTimer = setInterval(() => {
            try {
                this.prune();
            }
            catch (error) {
                logResponsesStoreNonBlockingError('prune.timer', error);
            }
        }, PRUNE_INTERVAL_MS);
        this.pruneTimer.unref?.();
    }
    stopPruneTimer() {
        if (this.pruneTimer) {
            clearInterval(this.pruneTimer);
            this.pruneTimer = null;
        }
    }
    clearAll() {
        this.requestMap.clear();
        this.responseIndex.clear();
        this.scopeIndex.clear();
        this.stopPruneTimer();
        this.persistenceLoaded = false;
    }
    clearAllAndPersist() {
        this.ensurePersistenceLoaded();
        this.requestMap.clear();
        this.responseIndex.clear();
        this.scopeIndex.clear();
        this.stopPruneTimer();
        this.flushPersistence();
        this.persistenceLoaded = false;
    }
    getLastPruneAt() {
        return this.lastPruneAt;
    }
}
const RESPONSES_CONVERSATION_STORE_GLOBAL_KEY = "__rccResponsesConversationStore";
function isResponsesConversationStoreLike(value) {
    return Boolean(value
        && typeof value === 'object'
        && !Array.isArray(value)
        && typeof value.captureRequestContext === 'function'
        && typeof value.recordResponse === 'function'
        && typeof value.getDebugStats === 'function');
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
export { store as responsesConversationStore };
// Expose raw store for memory-observer diagnostics
globalThis[RESPONSES_CONVERSATION_STORE_GLOBAL_KEY] = store;
//# sourceMappingURL=responses-conversation-store-host.js.map
