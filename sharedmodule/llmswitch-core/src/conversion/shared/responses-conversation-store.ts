import { ProviderProtocolError } from '../provider-protocol-error.js';
import {
  convertResponsesOutputToInputItemsWithNative,
  pickResponsesPersistedFieldsWithNative,
  prepareResponsesConversationEntryWithNative,
  resumeResponsesConversationPayloadWithNative
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

type AnyRecord = Record<string, unknown>;

interface CaptureContextArgs {
  requestId?: string;
  payload: AnyRecord;
  context: AnyRecord;
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

interface ConversationEntry {
  requestId: string;
  basePayload: AnyRecord;
  input: AnyRecord[];
  tools?: AnyRecord[];
  createdAt: number;
  updatedAt: number;
  lastResponseId?: string;
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
    typeof resumeResponsesConversationPayloadWithNative !== 'function'
  ) {
    throw new Error('[responses-conversation-store] native bindings unavailable');
  }
}

class ResponsesConversationStore {
  private requestMap = new Map<string, ConversationEntry>();
  private responseIndex = new Map<string, ConversationEntry>();

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
    const prepared = prepareResponsesConversationEntryWithNative(payload, context);
    const entry: ConversationEntry = {
      requestId,
      basePayload: isRecord(prepared.basePayload) ? prepared.basePayload : pickPersistedFields(payload),
      input: Array.isArray(prepared.input) ? prepared.input : [],
      tools: Array.isArray(prepared.tools) ? prepared.tools : undefined,
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
    const assistantBlocks = convertOutputToInputItems(response);
    if (assistantBlocks.length) {
      entry.input.push(...assistantBlocks);
    }
    entry.lastResponseId = responseId;
    entry.updatedAt = Date.now();
    this.responseIndex.set(responseId, entry);
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
    this.requestMap.delete(requestId);
    if (entry.lastResponseId) {
      this.responseIndex.delete(entry.lastResponseId);
    }
  }

  private cleanupEntry(entry: ConversationEntry, responseId: string): void {
    this.responseIndex.delete(responseId);
    this.requestMap.delete(entry.requestId);
  }

  private prune(): void {
    const now = Date.now();
    for (const [requestId, entry] of this.requestMap.entries()) {
      if (now - entry.updatedAt > TTL_MS) {
        this.requestMap.delete(requestId);
        if (entry.lastResponseId) {
          this.responseIndex.delete(entry.lastResponseId);
        }
      }
    }
    for (const [respId, entry] of this.responseIndex.entries()) {
      if (!this.requestMap.has(entry.requestId)) {
        this.responseIndex.delete(respId);
      }
    }
  }
}

const store = new ResponsesConversationStore();
const RESPONSES_DEBUG = (process.env.ROUTECODEX_RESPONSES_DEBUG || '').trim() === '1';

export function captureResponsesRequestContext(args: CaptureContextArgs): void {
  try {
    if (RESPONSES_DEBUG) {
      console.log('[responses-store] capture', args.requestId);
    }
    store.captureRequestContext(args);
  } catch {
    /* ignore capture failures */
  }
}

export function recordResponsesResponse(args: RecordResponseArgs): void {
  try {
    if (RESPONSES_DEBUG) {
      console.log('[responses-store] record', args.requestId, (args.response as AnyRecord)?.id);
    }
    store.recordResponse(args);
  } catch {
    /* ignore */
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

export { store as responsesConversationStore };
