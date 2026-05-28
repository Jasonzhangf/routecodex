import { ProviderProtocolError } from '../provider-protocol-error.js';
import { formatUnknownError, isRecord } from '../../shared/common-utils.js';
import {
  assertResponsesConversationStoreNativeAvailable,
  convertOutputToInputItems,
  materializeContinuationPayload,
  pickPersistedFields,
  prepareConversationEntry,
  restoreContinuationPayload,
  resumeConversationPayload
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

function buildScopeKeys(scope: { sessionId?: unknown; conversationId?: unknown }): string[] {
  const keys: string[] = [];
  const sessionId = readScopeToken(scope.sessionId);
  const conversationId = readScopeToken(scope.conversationId);
  if (sessionId) {
    keys.push(`session:${sessionId}`);
  }
  if (conversationId) {
    keys.push(`conversation:${conversationId}`);
  }
  return [...new Set(keys)];
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
  return buildScopeKeys({ sessionId, conversationId });
}


function ensureMetaProviderKey(meta: AnyRecord | undefined, entry: ConversationEntry): AnyRecord {
  const baseMeta: AnyRecord = isRecord(meta) ? { ...meta } : {};
  const metaProviderKey = readScopeToken(baseMeta.providerKey);
  const entryProviderKey = readScopeToken(entry.providerKey) ?? readScopeToken((entry.basePayload as AnyRecord | undefined)?.providerKey);
  if (!metaProviderKey && entryProviderKey) {
    baseMeta.providerKey = entryProviderKey;
  }
  return baseMeta;
}

class ResponsesConversationStore {
  private requestMap = new Map<string, ConversationEntry>();
  private responseIndex = new Map<string, ConversationEntry>();
  private scopeIndex = new Map<string, ConversationEntry>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private lastPruneAt = 0;

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
    const { requestId, payload, context } = args;
    if (!requestId || !payload) return;
    this.prune();
    assertResponsesConversationStoreNativeAvailable();
    const existing = this.requestMap.get(requestId);
    if (existing) {
      this.detachEntry(existing);
    }
    const prepared = prepareConversationEntry(payload, context);
    const scopeKeys = buildScopeKeys(args);
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
      providerKey: readScopeToken(args.providerKey) ?? readScopeToken(payload.providerKey) ?? readScopeToken((prepared.basePayload as AnyRecord | undefined)?.providerKey),
      sessionId: readScopeToken(args.sessionId),
      conversationId: readScopeToken(args.conversationId),
      scopeKeys,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.requestMap.set(requestId, entry);
  }

  recordResponse(args: RecordResponseArgs): void {
    const response = args.response;
    const responseId = typeof response.id === 'string' ? response.id : undefined;
    const requestId = typeof args.requestId === 'string' ? args.requestId.trim() : '';
    if (!requestId) {
      // Silent return + log: preserves original fire-and-forget behavior while maintaining observability
      console.error('[ResponsesConversationStore] recordResponse: missing requestId, skipping', {
        context: 'responses-conversation-store.recordResponse',
        responseId
      });
      return;
    }
    let entry = this.requestMap.get(requestId);
    if (!entry && responseId) {
      entry = this.requestMap.get(responseId);
    }
    if (!entry) {
      const fallbackScopeKeys = buildScopeKeys({
        sessionId: args.sessionId,
        conversationId: args.conversationId
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
      console.warn('[ResponsesConversationStore] recordResponse: missing request context, skipping', {
        context: 'responses-conversation-store.recordResponse',
        reason: 'missing_request_context',
        requestId,
        responseId
      });
      return;
    }
    if (!responseId) return;
    const responseProviderKey = readScopeToken(args.providerKey);
    if (responseProviderKey) {
      entry.providerKey = responseProviderKey;
      entry.basePayload.providerKey = responseProviderKey;
    }
    const nextScopeKeys = buildScopeKeys({
      sessionId: args.sessionId,
      conversationId: args.conversationId
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
    entry.lastResponseId = responseId;
    entry.updatedAt = Date.now();
    this.responseIndex.set(responseId, entry);
    this.attachEntryScopes(entry);
  }

  resumeConversation(responseId: string, submitPayload: AnyRecord, options?: ResumeOptions): ResumeResult {
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
    let entry = this.responseIndex.get(responseId);
    if (!entry) {
      for (const scopeKey of readResumeScopeKeysFromSubmitPayload(submitPayload)) {
        const candidate = this.scopeIndex.get(scopeKey);
        if (
          candidate
          && typeof candidate.lastResponseId === 'string'
          && candidate.lastResponseId === responseId
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
    return {
      payload: resumed.payload,
      meta: ensureMetaProviderKey(resumed.meta, entry)
    };
  }

  clearRequest(requestId?: string): void {
    if (!requestId) return;
    const entry = this.requestMap.get(requestId);
    if (!entry) return;
    this.detachEntry(entry);
  }

  releaseRequestPayload(requestId?: string): void {
    if (!requestId) return;
    const entry = this.requestMap.get(requestId);
    if (!entry) return;
    entry.releasedInputPrefix = Array.isArray(entry.input)
      ? entry.input.map((item) => ({ ...item }))
      : [];
    entry.basePayload = {
      ...(isRecord(entry.basePayload) ? entry.basePayload : {}),
      ...(entry.providerKey ? { providerKey: entry.providerKey } : {}),
      ...(entry.lastResponseId ? { previous_response_id: entry.lastResponseId } : {})
    };
    entry.releasedPendingToolCallIds = collectPendingToolCallIds(entry.input);
    entry.input = [];
    entry.updatedAt = Date.now();
    this.attachEntryScopes(entry);
  }

  resumeLatestContinuationByScope(args: RestoreByScopeArgs): ResumeResult | null {
    this.prune();
    const scopeKeys = buildScopeKeys(args);
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
    this.prune();
    const scopeKeys = buildScopeKeys(args);
    for (const scopeKey of scopeKeys) {
      const entry = this.scopeIndex.get(scopeKey);
      if (!entry || entry.allowContinuation !== true) {
        continue;
      }
      assertResponsesConversationStoreNativeAvailable();
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
    this.lastPruneAt = Date.now();
    const now = Date.now();
    for (const [, entry] of this.requestMap.entries()) {
      if (now - entry.updatedAt > TTL_MS) {
        this.detachEntry(entry);
      }
    }
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
  if (!requestId) {
    return;
  }
  const entry = (store as unknown as {
    requestMap?: Map<string, {
      scopeKeys?: string[];
    }>;
  }).requestMap?.get(requestId);
  if (!entry) {
    return;
  }
  if (
    typeof (entry as { lastResponseId?: unknown }).lastResponseId !== 'string' ||
    !String((entry as { lastResponseId?: unknown }).lastResponseId).trim()
  ) {
    store.clearRequest(requestId);
    return;
  }
  if (options?.keepForSubmitToolOutputs === true) {
    store.releaseRequestPayload(requestId);
    return;
  }
  if (!Array.isArray(entry.scopeKeys) || entry.scopeKeys.length <= 0) {
    store.clearRequest(requestId);
    return;
  }
  store.releaseRequestPayload(requestId);
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
  store.clearAll();
}

export { store as responsesConversationStore };

// Expose raw store for memory-observer diagnostics
(globalThis as Record<string, unknown>)["__rccResponsesConversationStore"] = store;
