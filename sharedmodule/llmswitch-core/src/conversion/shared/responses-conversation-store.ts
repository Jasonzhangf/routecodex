import { ProviderProtocolError } from '../provider-protocol-error.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatUnknownError, isRecord } from '../../shared/common-utils.js';
import {
  assertResponsesConversationStoreNativeAvailable,
  convertOutputToInputItems,
  materializeContinuationPayload,
  pickPersistedFields,
  prepareConversationEntry,
  restoreContinuationPayload,
  resumeConversationPayload,
  stripStoredContextInputMedia
} from './responses-conversation-store-native.js';
import type {
  AnyRecord,
  CaptureContextArgs,
  ConversationEntry,
  RecordResponseArgs,
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

function readToolCallId(item: AnyRecord): string | undefined {
  for (const key of ['call_id', 'tool_call_id', 'id']) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function shouldAllowContinuation(payload: AnyRecord | undefined): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  if (payload.store === false) {
    return false;
  }
  if (payload.store === true) {
    return true;
  }
  const previousResponseId = typeof payload.previous_response_id === 'string' ? payload.previous_response_id.trim() : '';
  const responseId = typeof payload.response_id === 'string' ? payload.response_id.trim() : '';
  const toolOutputs = Array.isArray(payload.tool_outputs) ? payload.tool_outputs : [];
  return Boolean((previousResponseId || responseId) && toolOutputs.length > 0);
}

function collectPendingToolCallIds(input: AnyRecord[]): string[] {
  const pending: string[] = [];
  for (const item of input) {
    const type = typeof item.type === 'string' ? item.type.trim().toLowerCase() : '';
    const callId = readToolCallId(item);
    if (!callId) continue;
    if (type === 'function_call') {
      if (!pending.includes(callId)) pending.push(callId);
      continue;
    }
    if (type === 'function_call_output' || type === 'tool_result' || type === 'tool_message') {
      const index = pending.indexOf(callId);
      if (index >= 0) pending.splice(index, 1);
    }
  }
  return pending;
}

function readPortScopeKey(scope: { matchedPort?: unknown; routingPolicyGroup?: unknown } | undefined): string | undefined {
  if (!scope) return undefined;
  const port = typeof scope.matchedPort === 'number' && Number.isFinite(scope.matchedPort) && scope.matchedPort > 0
    ? Math.floor(scope.matchedPort)
    : undefined;
  if (port !== undefined) return `port:${port}`;
  const group = readScopeToken(scope.routingPolicyGroup);
  return group ? `group:${group}` : undefined;
}

function qualifyScopeKey(portScopeKey: string | undefined, key: string): string {
  return portScopeKey ? `${portScopeKey}|${key}` : key;
}

function buildScopeKeys(scope: { sessionId?: unknown; conversationId?: unknown; matchedPort?: unknown; routingPolicyGroup?: unknown }): string[] {
  const keys: string[] = [];
  const portScopeKey = readPortScopeKey(scope);
  const sessionId = readScopeToken(scope.sessionId);
  const conversationId = readScopeToken(scope.conversationId);
  if (sessionId) {
    keys.push(qualifyScopeKey(portScopeKey, `session:${sessionId}`));
  }
  if (conversationId) {
    keys.push(qualifyScopeKey(portScopeKey, `conversation:${conversationId}`));
  }
  return [...new Set(keys)];
}

function entryMatchesPortScope(entry: ConversationEntry, requestedPortScopeKey: string | undefined): boolean {
  if (!requestedPortScopeKey) return true;
  return entry.portScopeKey === requestedPortScopeKey;
}

function readResumeScopeKeysFromSubmitPayload(payload: AnyRecord | undefined): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return [];
  }
  const metadata = payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
    ? (payload.metadata as Record<string, unknown>)
    : undefined;
  const sessionId =
    readScopeToken(payload.session_id)
    ?? readScopeToken(payload.sessionId)
    ?? readScopeToken(metadata?.session_id)
    ?? readScopeToken(metadata?.sessionId);
  const conversationId =
    readScopeToken(payload.conversation_id)
    ?? readScopeToken(payload.conversationId)
    ?? readScopeToken(metadata?.conversation_id)
    ?? readScopeToken(metadata?.conversationId);
  return buildScopeKeys({
    sessionId,
    conversationId,
    matchedPort: metadata?.matchedPort ?? (metadata?.portContext && typeof metadata.portContext === 'object' && !Array.isArray(metadata.portContext) ? (metadata.portContext as AnyRecord).matchedPort : undefined),
    routingPolicyGroup: metadata?.routingPolicyGroup ?? (metadata?.portContext && typeof metadata.portContext === 'object' && !Array.isArray(metadata.portContext) ? (metadata.portContext as AnyRecord).routingPolicyGroup : undefined)
  });
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
  return baseMeta;
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
      if (!entry || !entry.lastResponseId || now - entry.updatedAt > TTL_MS) continue;
      this.requestMap.set(entry.requestId, entry);
      this.responseIndex.set(entry.lastResponseId, entry);
      this.attachEntryScopes(entry);
    }
  }

  private flushPersistence(): void {
    if (!this.persistenceLoaded) return;
    const entries: ConversationEntry[] = [];
    const persistFilePath = resolvePersistFilePath();
    const seen = new Set<ConversationEntry>();
    for (const entry of this.responseIndex.values()) {
      if (seen.has(entry) || entry.allowContinuation !== true || !entry.lastResponseId) continue;
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
    const scopeKeys = buildScopeKeys(args);
    const portScopeKey = readPortScopeKey(args);
    const prepared = prepareConversationEntry(payload, context);
    for (const candidate of scopeKeys.length ? this.requestMap.values() : []) {
      if (
        candidate
        && candidate.requestId !== requestId
        && (!candidate.lastResponseId || !String(candidate.lastResponseId).trim())
        && Array.isArray(candidate.scopeKeys)
        && candidate.scopeKeys.some((k) => scopeKeys.includes(k))
      ) this.detachEntry(candidate);
    }
    const entry: ConversationEntry = {
      requestId,
      basePayload: isRecord(prepared.basePayload) ? prepared.basePayload : pickPersistedFields(payload),
      input: Array.isArray(prepared.input) ? prepared.input : [],
      allowContinuation: shouldAllowContinuation(payload),
      tools: Array.isArray(prepared.tools) ? prepared.tools : undefined,
      providerKey: readScopeToken(args.providerKey) ?? readScopeToken(payload.providerKey),
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
      const fallbackScopeKeys = buildScopeKeys({
        sessionId: args.sessionId,
        conversationId: args.conversationId,
        matchedPort: args.matchedPort,
        routingPolicyGroup: args.routingPolicyGroup
      });
      for (const scopeKey of fallbackScopeKeys) {
        const candidate = this.scopeIndex.get(scopeKey);
        if (candidate) {
          entry = candidate;
          break;
        }
      }
    }
    if (!entry) {
      logResponsesStoreNonBlockingError('record.missing_request_context', new Error('missing_request_context'), {
        requestId,
        responseId,
        providerKey: args.providerKey,
        sessionId: args.sessionId,
        conversationId: args.conversationId,
        matchedPort: args.matchedPort,
        routingPolicyGroup: args.routingPolicyGroup
      });
      throw new ProviderProtocolError('Responses conversation request context missing for response capture', {
        code: 'MALFORMED_RESPONSE',
        protocol: 'openai-responses',
        providerType: 'responses',
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
    if (args.continuationOwner === 'direct' || args.continuationOwner === 'relay') {
      entry.continuationOwner = args.continuationOwner;
    }
    const nextScopeKeys = buildScopeKeys({
      sessionId: args.sessionId,
      conversationId: args.conversationId,
      matchedPort: args.matchedPort,
      routingPolicyGroup: args.routingPolicyGroup
    });
    for (const scopeKey of nextScopeKeys) {
      if (!entry.scopeKeys.includes(scopeKey)) {
        entry.scopeKeys.push(scopeKey);
      }
    }
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
    for (const scopeKey of entry.scopeKeys) {
      const previous = this.scopeIndex.get(scopeKey);
      if (previous && previous !== entry && previous.lastResponseId && previous.requestId !== entry.requestId) {
        this.detachEntry(previous);
      }
    }
    this.attachEntryScopes(entry);
    for (const [requestKey, candidate] of this.requestMap.entries()) {
      if (candidate === entry) continue;
      if (!candidate.lastResponseId) continue;
      if (!candidate.scopeKeys.some((scopeKey) => entry.scopeKeys.includes(scopeKey))) continue;
      this.detachEntry(candidate);
      if (requestKey === candidate.requestId) {
        break;
      }
    }
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
    let entry = this.responseIndex.get(responseId);
    if (entry && !entryMatchesPortScope(entry, requestedPortScopeKey)) {
      entry = undefined;
    }
    if (!entry) {
      for (const scopeKey of readResumeScopeKeysFromSubmitPayload(submitPayload)) {
        const candidate = this.scopeIndex.get(scopeKey);
        if (
          candidate
          && typeof candidate.lastResponseId === 'string'
          && candidate.lastResponseId === responseId
          && entryMatchesPortScope(candidate, requestedPortScopeKey)
        ) {
          entry = candidate;
          break;
        }
      }
    }
    if (!entry || entry.allowContinuation !== true) {
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
    let cleared = 0;
    for (const entry of [...this.requestMap.values()]) {
      if (typeof entry.lastResponseId === 'string' && entry.lastResponseId.trim()) {
        continue;
      }
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
    const releasedInputPrefixRaw = Array.isArray(entry.input)
      ? entry.input.map((item) => ({ ...item }))
      : [];
    const releasedInputPrefix = stripStoredContextInputMedia(releasedInputPrefixRaw).messages;
    entry.releasedInputPrefix = releasedInputPrefix;
    entry.basePayload = {
      ...(isRecord(entry.basePayload) ? entry.basePayload : {}),
      ...(entry.lastResponseId ? { previous_response_id: entry.lastResponseId } : {})
    };
    entry.releasedPendingToolCallIds = collectPendingToolCallIds(releasedInputPrefix);
    entry.input = [];
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
    if (
      typeof entry.lastResponseId !== 'string' ||
      !String(entry.lastResponseId).trim()
    ) {
      if (RESPONSES_DEBUG) {
        console.log('[responses-store] finalize.clear_missing_response', requestId);
      }
      this.clearRequest(requestId);
      return;
    }
    if (options?.keepForSubmitToolOutputs === true) {
      if (RESPONSES_DEBUG) {
        console.log('[responses-store] finalize.keep_for_submit', requestId, entry.lastResponseId);
      }
      this.releaseRequestPayload(requestId);
      return;
    }
    if (!Array.isArray(entry.scopeKeys) || entry.scopeKeys.length <= 0) {
      if (RESPONSES_DEBUG) {
        console.log('[responses-store] finalize.clear_missing_scope', requestId, entry.lastResponseId);
      }
      this.clearRequest(requestId);
      return;
    }
    if (RESPONSES_DEBUG) {
      console.log('[responses-store] finalize.release', requestId, entry.lastResponseId);
    }
    this.releaseRequestPayload(requestId);
  }

  resumeLatestContinuationByScope(args: RestoreByScopeArgs): ResumeResult | null {
    this.ensurePersistenceLoaded();
    this.prune();
    const scopeKeys = buildScopeKeys(args);
    const portScopeKey = readPortScopeKey(args);
    for (const scopeKey of scopeKeys) {
      const entry = this.scopeIndex.get(scopeKey);
      if (!entry || entry.allowContinuation !== true || !entry.lastResponseId) {
        continue;
      }
      assertResponsesConversationStoreNativeAvailable();
      const restored = restoreContinuationPayload(entry, args.payload, args.requestId, scopeKey);
      if (!restored) {
        continue;
      }
      return {
        payload: restored.payload,
        meta: ensureMetaProviderKey(restored.meta, entry)
      };
    }
    return null;
  }

  materializeLatestContinuationByScope(args: RestoreByScopeArgs): ResumeResult | null {
    this.ensurePersistenceLoaded();
    this.prune();
    const scopeKeys = buildScopeKeys(args);
    const portScopeKey = readPortScopeKey(args);
    for (const scopeKey of scopeKeys) {
      const entry = this.scopeIndex.get(scopeKey);
      if (!entry || entry.allowContinuation !== true) {
        continue;
      }
      assertResponsesConversationStoreNativeAvailable();
      if (entry.continuationOwner === 'direct') {
        const restored = restoreContinuationPayload(entry, args.payload, args.requestId, scopeKey);
        if (!restored) {
          continue;
        }
        return {
          payload: restored.payload,
          meta: ensureMetaProviderKey(restored.meta, entry)
        };
      }
      const materialized = materializeContinuationPayload(entry, args.payload, args.requestId, scopeKey);
      if (!materialized) {
        continue;
      }
      return {
        payload: materialized.payload,
        meta: ensureMetaProviderKey(materialized.meta, entry)
      };
    }
    return null;
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
    const now = Date.now();
    for (const [, entry] of this.requestMap.entries()) {
      if (now - entry.updatedAt > TTL_MS) {
        this.detachEntry(entry);
      }
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

const store = new ResponsesConversationStore();
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
    const detailSuffix =
      details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(
      `[responses-store] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`
    );
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
(globalThis as Record<string, unknown>)["__rccResponsesConversationStore"] = store;
