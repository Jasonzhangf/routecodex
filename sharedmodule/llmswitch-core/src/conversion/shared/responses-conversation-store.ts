import { ProviderProtocolError } from '../provider-protocol-error.js';
import {
  convertResponsesOutputToInputItemsWithNative,
  materializeResponsesContinuationPayloadWithNative,
  pickResponsesPersistedFieldsWithNative,
  prepareResponsesConversationEntryWithNative,
  restoreResponsesContinuationPayloadWithNative,
  resumeResponsesConversationPayloadWithNative
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

type AnyRecord = Record<string, unknown>;

interface CaptureContextArgs {
  requestId?: string;
  payload: AnyRecord;
  context: AnyRecord;
  sessionId?: string;
  conversationId?: string;
}

interface RecordResponseArgs {
  requestId?: string;
  response: AnyRecord;
}

interface ResumeOptions {
  requestId?: string;
}

interface ResumeResult {
  payload: AnyRecord;
  meta: AnyRecord;
}

interface RestoreByScopeArgs {
  payload: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  requestId?: string;
}

interface ConversationEntry {
  requestId: string;
  basePayload: AnyRecord;
  input: AnyRecord[];
  tools?: AnyRecord[];
  createdAt: number;
  updatedAt: number;
  lastResponseId?: string;
  sessionId?: string;
  conversationId?: string;
  scopeKeys: string[];
}

const TTL_MS = 1000 * 60 * 30; // 30min

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function pickPersistedFields(payload: AnyRecord): AnyRecord {
  return pickResponsesPersistedFieldsWithNative(payload) as AnyRecord;
}

function convertOutputToInputItems(response: AnyRecord): AnyRecord[] {
  return convertResponsesOutputToInputItemsWithNative(response) as AnyRecord[];
}

function assertResponsesConversationStoreNativeAvailable(): void {
  if (
    typeof pickResponsesPersistedFieldsWithNative !== 'function' ||
    typeof convertResponsesOutputToInputItemsWithNative !== 'function' ||
    typeof prepareResponsesConversationEntryWithNative !== 'function' ||
    typeof materializeResponsesContinuationPayloadWithNative !== 'function' ||
    typeof restoreResponsesContinuationPayloadWithNative !== 'function' ||
    typeof resumeResponsesConversationPayloadWithNative !== 'function'
  ) {
    throw new Error('[responses-conversation-store] native bindings unavailable');
  }
}

function readScopeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
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

class ResponsesConversationStore {
  private requestMap = new Map<string, ConversationEntry>();
  private responseIndex = new Map<string, ConversationEntry>();
  private scopeIndex = new Map<string, ConversationEntry>();

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
    const prepared = prepareResponsesConversationEntryWithNative(payload, context);
    const scopeKeys = buildScopeKeys(args);
    const entry: ConversationEntry = {
      requestId,
      basePayload: isRecord(prepared.basePayload) ? prepared.basePayload : pickPersistedFields(payload),
      input: Array.isArray(prepared.input) ? prepared.input : [],
      tools: Array.isArray(prepared.tools) ? prepared.tools : undefined,
      sessionId: readScopeToken(args.sessionId),
      conversationId: readScopeToken(args.conversationId),
      scopeKeys,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.requestMap.set(requestId, entry);
  }

  recordResponse(args: RecordResponseArgs): void {
    const entry = args.requestId ? this.requestMap.get(args.requestId) : undefined;
    if (!entry) return;
    const response = args.response;
    const responseId = typeof response.id === 'string' ? response.id : undefined;
    if (!responseId) return;
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
    const entry = this.responseIndex.get(responseId);
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
    const resumed = resumeResponsesConversationPayloadWithNative(
      {
        requestId: entry.requestId,
        basePayload: entry.basePayload,
        input: entry.input,
        tools: entry.tools
      },
      responseId,
      submitPayload,
      options?.requestId
    );
    this.cleanupEntry(entry, responseId);
    return {
      payload: resumed.payload,
      meta: resumed.meta
    };
  }

  clearRequest(requestId?: string): void {
    if (!requestId) return;
    const entry = this.requestMap.get(requestId);
    if (!entry) return;
    this.detachEntry(entry);
  }

  resumeLatestContinuationByScope(args: RestoreByScopeArgs): ResumeResult | null {
    this.prune();
    const scopeKeys = buildScopeKeys(args);
    for (const scopeKey of scopeKeys) {
      const entry = this.scopeIndex.get(scopeKey);
      if (!entry || !entry.lastResponseId) {
        continue;
      }
      assertResponsesConversationStoreNativeAvailable();
      const restored = restoreResponsesContinuationPayloadWithNative(
        {
          requestId: entry.requestId,
          basePayload: entry.basePayload,
          input: entry.input,
          tools: entry.tools,
          lastResponseId: entry.lastResponseId
        },
        args.payload,
        args.requestId,
        scopeKey
      );
      if (!restored) {
        continue;
      }
      return {
        payload: restored.payload,
        meta: restored.meta
      };
    }
    return null;
  }

  materializeLatestContinuationByScope(args: RestoreByScopeArgs): ResumeResult | null {
    this.prune();
    const scopeKeys = buildScopeKeys(args);
    for (const scopeKey of scopeKeys) {
      const entry = this.scopeIndex.get(scopeKey);
      if (!entry) {
        continue;
      }
      assertResponsesConversationStoreNativeAvailable();
      const materialized = materializeResponsesContinuationPayloadWithNative(
        {
          requestId: entry.requestId,
          basePayload: entry.basePayload,
          input: entry.input,
          tools: entry.tools,
          lastResponseId: entry.lastResponseId
        },
        args.payload,
        args.requestId,
        scopeKey
      );
      if (!materialized) {
        continue;
      }
      return {
        payload: materialized.payload,
        meta: materialized.meta
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
}

const store = new ResponsesConversationStore();
const RESPONSES_DEBUG = (process.env.ROUTECODEX_RESPONSES_DEBUG || '').trim() === '1';
const RESPONSES_WARN_THROTTLE_MS = 60_000;
const responsesWarnAt = new Map<string, number>();

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? 'unknown');
}

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
    logResponsesStoreNonBlockingError('capture', error, {
      requestId: args.requestId,
      sessionId: args.sessionId,
      conversationId: args.conversationId
    });
  }
}

export function recordResponsesResponse(args: RecordResponseArgs): void {
  try {
    if (RESPONSES_DEBUG) {
      console.log('[responses-store] record', args.requestId, (args.response as AnyRecord)?.id);
    }
    store.recordResponse(args);
  } catch (error) {
    logResponsesStoreNonBlockingError('record', error, {
      requestId: args.requestId,
      responseId: (args.response as AnyRecord)?.id
    });
  }
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

export { store as responsesConversationStore };
