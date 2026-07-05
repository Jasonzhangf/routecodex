import { ProviderProtocolError } from '../provider-protocol-error.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isRecord } from '../../shared/common-utils.js';
import {
  assertResponsesConversationStoreNativeAvailable,
  buildConversationScopePlan,
  collectPendingToolCallIds,
  convertOutputToInputItems,
  materializeContinuationPayload,
  pickPersistedFields,
  planCapturePendingCleanup,
  planContinuationLookupByResponseId,
  planConversationRetention,
  planPersistenceEligibility,
  planReleaseRequestPayload,
  planRecordScopeCleanup,
  planRecordScopeEntryMatch,
  planResumeEntryMatch,
  planStoreSweep,
  planScopeContinuationMatch,
  prepareConversationEntry,
  restoreContinuationPayload,
  resumeConversationPayload,
  shouldAllowContinuation
} from './responses-conversation-store-native.js';
import type {
  AnyRecord,
  CaptureContextArgs,
  ConversationEntry,
  ContinuationLookupOptions,
  RecordResponseArgs,
  ResponsesStoreLookupResult,
  ResponsesContinuationEntryKind,
  RestoreByScopeArgs,
  ResumeOptions,
  ResumeResult
} from './responses-conversation-store-types.js';

const TTL_MS = 1000 * 60 * 30; // 30min
const PERSIST_SCHEMA_VERSION = 1;

function resolvePersistFilePath(): string {
  const explicit = typeof process.env.ROUTECODEX_RESPONSES_CONVERSATION_STORE === 'string'
    ? process.env.ROUTECODEX_RESPONSES_CONVERSATION_STORE.trim()
    : '';
  if (explicit) return explicit;
  const home = typeof process.env.ROUTECODEX_HOME === 'string' && process.env.ROUTECODEX_HOME.trim()
    ? process.env.ROUTECODEX_HOME.trim()
    : path.join(os.homedir(), '.rcc');
  return path.join(home, 'state', 'responses-conversation-store.json');
}

function cloneJsonRecord(value: unknown): AnyRecord | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const cloned = JSON.parse(JSON.stringify(value));
    return isRecord(cloned) ? cloned : undefined;
  } catch {
    return undefined;
  }
}

function cloneJsonRecordArray(value: unknown): AnyRecord[] {
  if (!Array.isArray(value)) return [];
  const rows: AnyRecord[] = [];
  for (const item of value) {
    const cloned = cloneJsonRecord(item);
    if (cloned) rows.push(cloned);
  }
  return rows;
}

function serializeEntry(entry: ConversationEntry): ConversationEntry | undefined {
  const basePayload = cloneJsonRecord(entry.basePayload);
  if (!basePayload) return undefined;
  return {
    requestId: entry.requestId,
    basePayload,
    input: cloneJsonRecordArray(entry.input),
    allowContinuation: entry.allowContinuation,
    releasedInputPrefix: cloneJsonRecordArray(entry.releasedInputPrefix),
    releasedPendingToolCallIds: Array.isArray(entry.releasedPendingToolCallIds)
      ? entry.releasedPendingToolCallIds.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      : undefined,
    inputPrefixDigest: typeof entry.inputPrefixDigest === 'string' ? entry.inputPrefixDigest : undefined,
    inputItemCount: typeof entry.inputItemCount === 'number' ? entry.inputItemCount : undefined,
    tools: cloneJsonRecordArray(entry.tools),
    providerKey: typeof entry.providerKey === 'string' ? entry.providerKey : undefined,
    entryKind: normalizeEntryKind(entry.entryKind),
    continuationOwner:
      entry.continuationOwner === 'direct' || entry.continuationOwner === 'relay'
        ? entry.continuationOwner
        : undefined,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lastResponseId: typeof entry.lastResponseId === 'string' ? entry.lastResponseId : undefined,
    sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : undefined,
    conversationId: typeof entry.conversationId === 'string' ? entry.conversationId : undefined,
    scopeKeys: Array.isArray(entry.scopeKeys) ? entry.scopeKeys.filter((v): v is string => typeof v === 'string' && v.trim().length > 0) : [],
    portScopeKey: typeof entry.portScopeKey === 'string' ? entry.portScopeKey : undefined
  };
}

function deserializeEntry(value: unknown): ConversationEntry | undefined {
  if (!isRecord(value)) return undefined;
  const requestId = readScopeToken(value.requestId);
  const basePayload = cloneJsonRecord(value.basePayload);
  const lastResponseId = readScopeToken(value.lastResponseId);
  if (!requestId || !basePayload || !lastResponseId) return undefined;
  const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : Date.now();
  const updatedAt = typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : createdAt;
  return {
    requestId,
    basePayload,
    input: cloneJsonRecordArray(value.input),
    allowContinuation: value.allowContinuation === true,
    releasedInputPrefix: cloneJsonRecordArray(value.releasedInputPrefix),
    releasedPendingToolCallIds: Array.isArray(value.releasedPendingToolCallIds)
      ? value.releasedPendingToolCallIds.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      : undefined,
    inputPrefixDigest: readScopeToken(value.inputPrefixDigest),
    inputItemCount: typeof value.inputItemCount === 'number' && Number.isFinite(value.inputItemCount) ? value.inputItemCount : undefined,
    tools: cloneJsonRecordArray(value.tools),
    providerKey: readScopeToken(value.providerKey),
    entryKind: normalizeEntryKind(value.entryKind),
    continuationOwner:
      value.continuationOwner === 'direct' || value.continuationOwner === 'relay'
        ? value.continuationOwner
        : undefined,
    createdAt,
    updatedAt,
    lastResponseId,
    sessionId: readScopeToken(value.sessionId),
    conversationId: readScopeToken(value.conversationId),
    scopeKeys: Array.isArray(value.scopeKeys) ? value.scopeKeys.filter((v): v is string => typeof v === 'string' && v.trim().length > 0) : [],
    portScopeKey: readScopeToken(value.portScopeKey)
  };
}

function readScopeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeEntryKind(value: unknown): ResponsesContinuationEntryKind {
  if (value === 'chat' || value === 'messages') {
    return value;
  }
  return 'responses';
}

function normalizeContinuationOwner(value: unknown): 'direct' | 'relay' | undefined {
  return value === 'direct' || value === 'relay' ? value : undefined;
}

function readPortScopeKey(scope: { matchedPort?: unknown; routingPolicyGroup?: unknown } | undefined): string | undefined {
  if (!scope) return undefined;
  return buildConversationScopePlan({ mode: 'stored', scope }).portScopeKey;
}

function buildStoredScopeKeysFromResolved(scope: {
  sessionId?: unknown;
  conversationId?: unknown;
  entryKind?: unknown;
  continuationOwner?: unknown;
}, portScopeKey: string | undefined): string[] {
  return buildConversationScopePlan({
    mode: 'stored',
    scope: {
      ...scope,
      ...(portScopeKey ? { portScopeKey } : {})
    }
  }).keys;
}

function buildStoredScopeKeys(scope: {
  sessionId?: unknown;
  conversationId?: unknown;
  matchedPort?: unknown;
  routingPolicyGroup?: unknown;
  entryKind?: unknown;
  continuationOwner?: unknown;
}): string[] {
  return buildConversationScopePlan({ mode: 'stored', scope }).keys;
}

function buildRequestedScopeKeys(scope: {
  sessionId?: unknown;
  conversationId?: unknown;
  matchedPort?: unknown;
  routingPolicyGroup?: unknown;
  entryKind?: unknown;
  continuationOwner?: unknown;
}): string[] {
  return buildConversationScopePlan({ mode: 'requested', scope }).keys;
}

function readResumeScopeKeysFromSubmitPayload(payload: AnyRecord | undefined): string[] {
  return buildConversationScopePlan({ mode: 'submit_payload', payload }).keys;
}


function ensureMetaProviderKey(meta: AnyRecord | undefined, entry: ConversationEntry): AnyRecord {
  const baseMeta: AnyRecord = isRecord(meta) ? { ...meta } : {};
  const metaProviderKey = readScopeToken(baseMeta.providerKey);
  const entryProviderKey = readScopeToken(entry.providerKey);
  if (!metaProviderKey && entryProviderKey) {
    baseMeta.providerKey = entryProviderKey;
  }
  if (!readScopeToken(baseMeta.continuationOwner) && entry.continuationOwner) {
    baseMeta.continuationOwner = entry.continuationOwner;
  }
  if (!readScopeToken(baseMeta.entryKind) && entry.entryKind) {
    baseMeta.entryKind = entry.entryKind;
  }
  return baseMeta;
}

type ScopeMatchCandidate = {
  scopeKey: string;
  requestId?: string;
  lastResponseId?: string;
  allowContinuation?: boolean;
  continuationOwner?: 'direct' | 'relay';
};

type ResumeEntryMatchCandidate = ScopeMatchCandidate & {
  source: 'response_index' | 'request_map' | 'scope';
  portScopeKey?: string;
  entryKind?: ResponsesContinuationEntryKind;
};

type CapturePendingCleanupCandidate = {
  requestId?: string;
  lastResponseId?: string;
  scopeKeys?: string[];
};

type RecordScopeCleanupCandidate = {
  requestId?: string;
  lastResponseId?: string;
  scopeKeys?: string[];
};

function collectScopeMatchCandidates(scopeIndex: Map<string, ConversationEntry>, scopeKeys: string[]): {
  entriesByScopeKey: Map<string, ConversationEntry>;
  candidates: ScopeMatchCandidate[];
} {
  const entriesByScopeKey = new Map<string, ConversationEntry>();
  const candidates: ScopeMatchCandidate[] = [];
  for (const scopeKey of scopeKeys) {
    const entry = scopeIndex.get(scopeKey);
    if (!entry) continue;
    entriesByScopeKey.set(scopeKey, entry);
    candidates.push({
      scopeKey,
      requestId: entry.requestId,
      lastResponseId: entry.lastResponseId,
      allowContinuation: entry.allowContinuation,
      continuationOwner: normalizeContinuationOwner(entry.continuationOwner)
    });
  }
  return { entriesByScopeKey, candidates };
}

function projectResumeEntryCandidate(
  entry: ConversationEntry,
  source: ResumeEntryMatchCandidate['source'],
  scopeKey?: string
): ResumeEntryMatchCandidate {
  return {
    source,
    scopeKey: scopeKey ?? '',
    requestId: entry.requestId,
    lastResponseId: entry.lastResponseId,
    allowContinuation: entry.allowContinuation,
    continuationOwner: normalizeContinuationOwner(entry.continuationOwner),
    portScopeKey: entry.portScopeKey,
    entryKind: normalizeEntryKind(entry.entryKind)
  };
}

class ResponsesConversationStore {
  private requestMap = new Map<string, ConversationEntry>();
  private responseIndex = new Map<string, ConversationEntry>();
  private scopeIndex = new Map<string, ConversationEntry>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private lastPruneAt = 0;
  private persistenceLoaded = false;

  private ensurePersistenceLoaded(): void {
    if (this.persistenceLoaded) return;
    this.persistenceLoaded = true;
    let parsed: unknown;
    const persistFilePath = resolvePersistFilePath();
    try {
      if (!fs.existsSync(persistFilePath)) return;
      parsed = JSON.parse(fs.readFileSync(persistFilePath, 'utf8'));
    } catch (error) {
      logResponsesStoreNonBlockingError('persist.load', error, { file: persistFilePath });
      return;
    }
    if (!isRecord(parsed) || parsed.version !== PERSIST_SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
      return;
    }
    const now = Date.now();
    for (const row of parsed.entries) {
      const entry = deserializeEntry(row);
      if (!entry) continue;
      const plan = planPersistenceEligibility(entry, { mode: 'load', nowMs: now, ttlMs: TTL_MS });
      if (plan.action !== 'persist' || !plan.lastResponseId) continue;
      this.requestMap.set(entry.requestId, entry);
      this.responseIndex.set(plan.lastResponseId, entry);
      this.attachEntryScopes(entry);
    }
  }

  private flushPersistence(): void {
    if (!this.persistenceLoaded) return;
    const entries: ConversationEntry[] = [];
    const persistFilePath = resolvePersistFilePath();
    const seen = new Set<ConversationEntry>();
    for (const entry of this.responseIndex.values()) {
      if (seen.has(entry)) continue;
      const plan = planPersistenceEligibility(entry, { mode: 'flush' });
      if (plan.action !== 'persist' || !plan.lastResponseId) continue;
      seen.add(entry);
      const serialized = serializeEntry(entry);
      if (serialized) entries.push(serialized);
    }
    try {
      fs.mkdirSync(path.dirname(persistFilePath), { recursive: true });
      const tmpFile = `${persistFilePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify({ version: PERSIST_SCHEMA_VERSION, entries }, null, 2));
      fs.renameSync(tmpFile, persistFilePath);
    } catch (error) {
      logResponsesStoreNonBlockingError('persist.flush', error, { file: persistFilePath });
    }
  }

  getDebugStats(): {
    requestMapSize: number;
    responseIndexSize: number;
    scopeIndexSize: number;
    requestEntriesWithoutLastResponseId: number;
    retainedInputItems: number;
  } {
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

  rebindRequestId(oldId: string | undefined, newId: string | undefined): void {
    if (!oldId || !newId || oldId === newId) {
      return;
    }
    const entry = this.requestMap.get(oldId);
    if (!entry) {
      return;
    }
    this.requestMap.delete(oldId);
    entry.requestId = newId;
    this.requestMap.set(newId, entry);
  }

  captureRequestContext(args: CaptureContextArgs): void {
    this.ensurePersistenceLoaded();
    const { requestId, payload, context } = args;
    if (!requestId || !payload) return;
    this.prune();
    assertResponsesConversationStoreNativeAvailable();
    const existing = this.requestMap.get(requestId);
    if (existing) {
      this.detachEntry(existing);
    }
    const scopeKeys = buildStoredScopeKeys({
      ...args,
      entryKind: normalizeEntryKind(args.entryKind),
      continuationOwner: 'relay'
    });
    const portScopeKey = readPortScopeKey(args);
    const prepared = prepareConversationEntry(payload, context);
    const cleanupCandidates: CapturePendingCleanupCandidate[] = scopeKeys.length
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
      if (candidate) this.detachEntry(candidate);
    }
    const entry: ConversationEntry = {
      requestId,
      basePayload: isRecord(prepared.basePayload) ? prepared.basePayload : pickPersistedFields(payload),
      input: Array.isArray(prepared.input) ? prepared.input : [],
      allowContinuation: shouldAllowContinuation(payload),
      tools: Array.isArray(prepared.tools) ? prepared.tools : undefined,
      providerKey: readScopeToken(args.providerKey) ?? readScopeToken(payload.providerKey),
      entryKind: normalizeEntryKind(args.entryKind),
      continuationOwner: undefined,
      sessionId: readScopeToken(args.sessionId),
      conversationId: readScopeToken(args.conversationId),
      scopeKeys,
      portScopeKey,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.requestMap.set(requestId, entry);
    this.flushPersistence();
  }

  recordResponse(args: RecordResponseArgs): void {
    this.ensurePersistenceLoaded();
    const response = args.response;
    const responseId = typeof response.id === 'string' ? response.id : undefined;
    const requestId = typeof args.requestId === 'string' ? args.requestId.trim() : '';
    if (!requestId) {
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
      const fallbackScopeKeys = buildRequestedScopeKeys({
        sessionId: args.sessionId,
        conversationId: args.conversationId,
        entryKind: normalizeEntryKind(args.entryKind),
        continuationOwner: normalizeContinuationOwner(args.continuationOwner),
        matchedPort: args.matchedPort,
        routingPolicyGroup: args.routingPolicyGroup
      });
      const { entriesByScopeKey, candidates } = collectScopeMatchCandidates(this.scopeIndex, fallbackScopeKeys);
      const fallbackPlan = planRecordScopeEntryMatch({
        scopeKeys: fallbackScopeKeys,
        candidates
      });
      if (fallbackPlan.action === 'select' && fallbackPlan.scopeKey) {
        entry = entriesByScopeKey.get(fallbackPlan.scopeKey);
      }
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
    if (!responseId) {
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
    const responsePortScopeKey = readPortScopeKey(args);
    if (responsePortScopeKey && !entry.portScopeKey) {
      entry.portScopeKey = responsePortScopeKey;
    }
    const responseProviderKey = readScopeToken(args.providerKey);
    if (responseProviderKey) {
      entry.providerKey = responseProviderKey;
    }
    entry.sessionId = readScopeToken(args.sessionId) ?? entry.sessionId;
    entry.conversationId = readScopeToken(args.conversationId) ?? entry.conversationId;
    entry.entryKind = normalizeEntryKind(args.entryKind ?? entry.entryKind);
    entry.continuationOwner = normalizeContinuationOwner(args.continuationOwner) ?? entry.continuationOwner ?? 'relay';
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
    const hasPendingToolCalls = collectPendingToolCallIds(entry.input).length > 0;
    if (hasPendingToolCalls) {
      entry.allowContinuation = true;
    }
    if (entry.allowContinuation === true && args.allowScopeContinuation === true && entry.scopeKeys.length > 0) {
      entry.allowContinuation = true;
    }
    entry.lastResponseId = responseId;
    entry.updatedAt = Date.now();
    this.responseIndex.set(responseId, entry);
    const recordCleanupCandidates = new Map<string, RecordScopeCleanupCandidate>();
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
      if (candidate) this.detachEntry(candidate);
    }
    this.attachEntryScopes(entry);
    this.flushPersistence();
  }

  resumeConversation(responseId: string, submitPayload: AnyRecord, options?: ResumeOptions): ResumeResult {
    this.ensurePersistenceLoaded();
    if (typeof responseId !== 'string' || !responseId.trim()) {
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
    this.prune();
    const requestedPortScopeKey = readPortScopeKey(options);
    const entriesByRequestId = new Map<string, ConversationEntry>();
    const candidates: ResumeEntryMatchCandidate[] = [];
    const indexedEntry = this.responseIndex.get(responseId);
    if (indexedEntry) {
      entriesByRequestId.set(indexedEntry.requestId, indexedEntry);
      candidates.push(projectResumeEntryCandidate(indexedEntry, 'response_index'));
    } else {
      for (const candidate of this.requestMap.values()) {
        entriesByRequestId.set(candidate.requestId, candidate);
        candidates.push(projectResumeEntryCandidate(candidate, 'request_map'));
      }
    }
    for (const scopeKey of readResumeScopeKeysFromSubmitPayload(submitPayload)) {
      const candidate = this.scopeIndex.get(scopeKey);
      if (!candidate) continue;
      entriesByRequestId.set(candidate.requestId, candidate);
      candidates.push(projectResumeEntryCandidate(candidate, 'scope', scopeKey));
    }
    const plan = planResumeEntryMatch({
      responseId,
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
          responseId
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
          responseId
        }
      });
    }
    if (plan.source === 'request_map') {
      this.responseIndex.set(responseId, entry);
    }
    const toolOutputs = Array.isArray(submitPayload.tool_outputs) ? submitPayload.tool_outputs : [];
    if (!toolOutputs.length) {
      throw new ProviderProtocolError('tool_outputs array is required when submitting Responses tool results', {
        code: 'MALFORMED_REQUEST',
        protocol: 'openai-responses',
        providerType: 'responses',
        details: {
          context: 'responses-conversation-store.resumeConversation',
          reason: 'missing_tool_outputs',
          responseId
        }
      });
    }
    assertResponsesConversationStoreNativeAvailable();
    const resumed = resumeConversationPayload(entry, responseId, submitPayload, options?.requestId);
    this.cleanupEntry(entry, responseId);
    this.flushPersistence();
    return {
      payload: resumed.payload,
      meta: ensureMetaProviderKey(resumed.meta, entry)
    };
  }

  lookupContinuationByResponseId(
    responseId: string,
    options?: ContinuationLookupOptions,
  ): ResponsesStoreLookupResult | null {
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

  clearRequest(requestId?: string): void {
    this.ensurePersistenceLoaded();
    if (!requestId) return;
    const entry = this.requestMap.get(requestId);
    if (!entry) return;
    if (RESPONSES_DEBUG) {
      console.log('[responses-store] clear.request', requestId, entry.lastResponseId);
    }
    this.detachEntry(entry);
    this.flushPersistence();
  }

  clearUnresolvedRequests(): number {
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
      if (!entry) continue;
      this.detachEntry(entry);
      cleared += 1;
    }
    this.pruneIndexes();
    if (cleared > 0) this.flushPersistence();
    return cleared;
  }

  releaseRequestPayload(requestId?: string): void {
    this.ensurePersistenceLoaded();
    if (!requestId) return;
    const entry = this.requestMap.get(requestId);
    if (!entry) return;
    const plan = planReleaseRequestPayload(entry);
    entry.releasedInputPrefix = plan.releasedInputPrefix;
    entry.basePayload = plan.basePayload;
    entry.releasedPendingToolCallIds = plan.releasedPendingToolCallIds;
    entry.input = plan.input;
    entry.updatedAt = Date.now();
    this.attachEntryScopes(entry);
    this.flushPersistence();
  }

  finalizeResponsesConversationRequestRetention(
    requestId?: string,
    options?: { keepForSubmitToolOutputs?: boolean }
  ): void {
    if (!requestId) {
      return;
    }
    const entry = this.requestMap.get(requestId);
    if (!entry) {
      return;
    }
    const plan = planConversationRetention(entry, options);
    if (plan.action === 'noop') return;
    if (RESPONSES_DEBUG) {
      if (plan.reason === 'missing_response') {
        console.log('[responses-store] finalize.clear_missing_response', requestId);
      } else if (plan.reason === 'missing_scope') {
        console.log('[responses-store] finalize.clear_missing_scope', requestId, plan.lastResponseId);
      } else if (plan.reason === 'keep_for_submit') {
        console.log('[responses-store] finalize.keep_for_submit', requestId, plan.lastResponseId);
      } else {
        console.log('[responses-store] finalize.release', requestId, plan.lastResponseId);
      }
    }
    if (plan.action === 'clear') {
      this.clearRequest(requestId);
      return;
    }
    this.releaseRequestPayload(requestId);
  }

  resumeLatestContinuationByScope(args: RestoreByScopeArgs): ResumeResult | null {
    this.ensurePersistenceLoaded();
    this.prune();
    const scopeKeys = buildRequestedScopeKeys({
      ...args,
      entryKind: normalizeEntryKind(args.entryKind)
    });
    const { entriesByScopeKey, candidates } = collectScopeMatchCandidates(this.scopeIndex, scopeKeys);
    const plan = planScopeContinuationMatch({
      mode: 'resume',
      candidates,
      options: { continuationOwner: normalizeContinuationOwner(args.continuationOwner) }
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

  materializeLatestContinuationByScope(args: RestoreByScopeArgs): ResumeResult | null {
    this.ensurePersistenceLoaded();
    this.prune();
    const requestedOwner = normalizeContinuationOwner(args.continuationOwner);
    const scopeKeys = buildRequestedScopeKeys({
      ...args,
      entryKind: normalizeEntryKind(args.entryKind)
    });
    const { entriesByScopeKey, candidates } = collectScopeMatchCandidates(this.scopeIndex, scopeKeys);
    const plan = planScopeContinuationMatch({
      mode: 'materialize',
      candidates,
      options: { continuationOwner: requestedOwner }
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

  private cleanupEntry(entry: ConversationEntry, responseId: string): void {
    this.responseIndex.delete(responseId);
    this.detachEntry(entry);
  }

  private attachEntryScopes(entry: ConversationEntry): void {
    for (const key of entry.scopeKeys) {
      const previous = this.scopeIndex.get(key);
      if (previous && previous !== entry) {
        this.detachEntry(previous);
      }
      this.scopeIndex.set(key, entry);
    }
  }

  private detachEntry(entry: ConversationEntry): void {
    this.requestMap.delete(entry.requestId);
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

  private prune(): void {
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
      if (!entry) continue;
      this.detachEntry(entry);
    }
    this.pruneIndexes();
    this.flushPersistence();
  }

  private pruneIndexes(): void {
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

  startPruneTimer(): void {
    if (this.pruneTimer) return;
    const PRUNE_INTERVAL_MS = 60_000; // 1min
    this.pruneTimer = setInterval(() => {
      this.prune();
    }, PRUNE_INTERVAL_MS);
  }

  private stopPruneTimer(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  clearAll(): void {
    this.requestMap.clear();
    this.responseIndex.clear();
    this.scopeIndex.clear();
    this.stopPruneTimer();
    this.persistenceLoaded = false;
  }

  clearAllAndPersist(): void {
    this.ensurePersistenceLoaded();
    this.requestMap.clear();
    this.responseIndex.clear();
    this.scopeIndex.clear();
    this.stopPruneTimer();
    this.flushPersistence();
    this.persistenceLoaded = false;
  }

  getLastPruneAt(): number {
    return this.lastPruneAt;
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

export function releaseResponsesConversationRequestPayload(requestId?: string): void {
  if (RESPONSES_DEBUG && requestId) {
    console.log('[responses-store] release-payload', requestId);
  }
  store.releaseRequestPayload(requestId);
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

export { store as responsesConversationStore };

// Expose raw store for memory-observer diagnostics
(globalThis as Record<string, unknown>)[RESPONSES_CONVERSATION_STORE_GLOBAL_KEY] = store;
