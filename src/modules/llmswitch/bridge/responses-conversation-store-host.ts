import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

interface ConversationEntry {
  requestId: string;
  basePayload: AnyRecord;
  input: AnyRecord[];
  allowContinuation?: boolean;
  releasedInputPrefix?: AnyRecord[];
  releasedPendingToolCallIds?: string[];
  inputPrefixDigest?: string;
  inputItemCount?: number;
  tools?: AnyRecord[];
  providerKey?: string;
  entryKind?: ResponsesContinuationEntryKind;
  continuationOwner?: 'direct' | 'relay';
  createdAt: number;
  updatedAt: number;
  lastResponseId?: string;
  sessionId?: string;
  conversationId?: string;
  scopeKeys: string[];
  portScopeKey?: string;
}

type ScopeContinuationMatchCandidate = {
  scopeKey: string;
  requestId?: string;
  lastResponseId?: string;
  allowContinuation?: boolean;
  continuationOwner?: 'direct' | 'relay';
};

type ResponsesConversationStoreNativeModule = {
  assertResponsesConversationStoreNativeAvailable?: () => void;
  buildConversationScopePlan?: (input: unknown) => { keys: string[]; portScopeKey?: string };
  collectPendingToolCallIds?: (input: AnyRecord[]) => string[];
  convertOutputToInputItems?: (response: unknown) => AnyRecord[];
  materializeContinuationPayload?: (
    entry: ConversationEntry,
    payload: AnyRecord,
    requestId?: string,
    scopeKey?: string
  ) => ResumeResult | null;
  restoreContinuationPayload?: (
    entry: ConversationEntry,
    payload: AnyRecord,
    requestId?: string,
    scopeKey?: string
  ) => ResumeResult | null;
  resumeConversationPayload?: (
    entry: ConversationEntry,
    responseId: string,
    submitPayload: AnyRecord,
    requestId?: string
  ) => ResumeResult;
  planAttachEntryScopes?: (input: {
    requestId: string;
    scopeKeys: string[];
    candidates: Array<{ scopeKey?: string; requestId?: string }>;
  }) => { action: string; reason: string; scopeKeys: string[]; detachRequestIds: string[] };
  planCapturePendingCleanup?: (input: {
    requestId: string;
    scopeKeys: string[];
    candidates: Array<{ requestId?: string; lastResponseId?: string; scopeKeys?: string[] }>;
  }) => { action: string; reason: string; detachRequestIds: string[] };
  planCapturedEntry?: (input: unknown) => { action: 'entry' | 'skip'; reason: string; entry?: ConversationEntry };
  planConversationPreflight?: (input: unknown) => {
    action: 'continue' | 'skip' | 'throw';
    reason: string;
    code?: string;
    requestId?: string;
    responseId?: string;
    toolOutputCount?: number;
  };
  planContinuationLookupByResponseId?: (input: unknown) => {
    action: 'none' | 'select';
    reason: string;
    responseId?: string;
    providerKey?: string;
    continuationOwner?: 'direct' | 'relay';
    entryKind?: ResponsesContinuationEntryKind;
    requestId?: string;
  };
  planContinuationMeta?: (input: { meta?: unknown; entry: ConversationEntry }) => {
    action: 'meta';
    reason: string;
    meta: AnyRecord;
  };
  planConversationRetention?: (
    entry: ConversationEntry,
    options: { keepForSubmitToolOutputs?: boolean } | undefined
  ) => { action: 'noop' | 'clear' | 'release'; reason: string; lastResponseId?: string };
  planPersistedEntry?: (input: {
    mode: 'serialize' | 'deserialize';
    entry: unknown;
    nowMs?: number;
  }) => { action: 'entry' | 'skip'; reason: string; entry?: ConversationEntry };
  planPersistenceEligibility?: (
    entry: ConversationEntry,
    options: { mode: 'load' | 'flush'; nowMs?: number; ttlMs?: number }
  ) => { action: 'persist' | 'skip'; reason: string; lastResponseId?: string };
  planRebindRequestId?: (input: {
    oldId?: string;
    newId?: string;
    oldEntryExists: boolean;
    newEntryExists: boolean;
  }) => { action: 'noop' | 'rebind'; reason: string; oldId?: string; newId?: string };
  planReleaseRequestPayload?: (entry: ConversationEntry) => {
    basePayload: AnyRecord;
    releasedInputPrefix: AnyRecord[];
    releasedPendingToolCallIds: string[];
    input: AnyRecord[];
  };
  planRecordScopeCleanup?: (input: {
    requestId: string;
    scopeKeys: string[];
    candidates: Array<{ requestId?: string; lastResponseId?: string; scopeKeys?: string[] }>;
  }) => { action: string; reason: string; detachRequestIds: string[] };
  planRecordContinuationFlag?: (input: {
    allowContinuation?: boolean;
    pendingToolCallIds?: string[];
  }) => { allowContinuation: boolean; reason: string; pendingToolCallCount: number };
  planRecordScopeEntryMatch?: (input: {
    scopeKeys: string[];
    candidates: ScopeContinuationMatchCandidate[];
  }) => { action: 'none' | 'select'; reason: string; scopeKey?: string; requestId?: string };
  planResumeEntryMatch?: (input: unknown) => {
    action: 'none' | 'select' | 'ambiguous';
    reason: string;
    source?: 'response_index' | 'request_map' | 'scope';
    requestId?: string;
    lastResponseId?: string;
    scopeKey?: string;
    matchCount?: number;
  };
  planStoreSweep?: (input: {
    mode: 'clear_unresolved' | 'prune_expired';
    nowMs?: number;
    ttlMs?: number;
    candidates: Array<{ requestId?: string; lastResponseId?: string; updatedAt?: number }>;
  }) => { action: string; reason: string; detachRequestIds: string[] };
  planStoreTokens?: (input: unknown) => {
    providerKey?: string;
    sessionId?: string;
    conversationId?: string;
    entryKind: ResponsesContinuationEntryKind;
    continuationOwner?: 'direct' | 'relay';
  };
  planScopeContinuationMatch?: (input: {
    mode: 'resume' | 'materialize';
    candidates: ScopeContinuationMatchCandidate[];
    options?: { continuationOwner?: 'direct' | 'relay' };
  }) => {
    action: 'none' | 'restore' | 'materialize';
    reason: string;
    scopeKey?: string;
    dedupeKey?: string;
    requestId?: string;
    lastResponseId?: string;
    matchCount?: number;
  };
};

function callNativeJson<T>(capability: string, ...args: unknown[]): T {
  const binding = getRouterHotpathJsonBindingSync() as unknown as Record<string, (...jsonArgs: string[]) => string>;
  const fn = binding[capability];
  if (typeof fn !== 'function') {
    throw new Error(`[responses-conversation-store-host] ${capability} not available`);
  }
  const raw = fn(...args.map((arg) => JSON.stringify(arg ?? null)));
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`[responses-conversation-store-host] ${capability} returned empty result`);
  }
  return JSON.parse(raw) as T;
}

function callNativeResumeJson<T>(
  capability: string,
  entry: unknown,
  payload: unknown,
  requestId?: string,
  scopeKey?: string
): T {
  const binding = getRouterHotpathJsonBindingSync() as unknown as Record<string, (...jsonArgs: Array<string | undefined>) => string>;
  const fn = binding[capability];
  if (typeof fn !== 'function') {
    throw new Error(`[responses-conversation-store-host] ${capability} not available`);
  }
  const raw = fn(JSON.stringify(entry ?? null), JSON.stringify(payload ?? null), requestId, scopeKey);
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`[responses-conversation-store-host] ${capability} returned empty result`);
  }
  return JSON.parse(raw) as T;
}

function callNativeResumeConversationJson<T>(
  entry: unknown,
  responseId: string,
  submitPayload: unknown,
  requestId?: string
): T {
  const binding = getRouterHotpathJsonBindingSync() as unknown as Record<string, (...jsonArgs: Array<string | undefined>) => string>;
  const fn = binding.resumeResponsesConversationPayloadJson;
  if (typeof fn !== 'function') {
    throw new Error('[responses-conversation-store-host] resumeResponsesConversationPayloadJson not available');
  }
  const raw = fn(JSON.stringify(entry ?? null), String(responseId ?? ''), JSON.stringify(submitPayload ?? null), requestId);
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('[responses-conversation-store-host] resumeResponsesConversationPayloadJson returned empty result');
  }
  return JSON.parse(raw) as T;
}

function getResponsesConversationStoreNative(): ResponsesConversationStoreNativeModule {
  return {
    assertResponsesConversationStoreNativeAvailable: () => {
      for (const name of [
        'buildResponsesConversationScopePlanJson',
        'collectResponsesPendingToolCallIdsJson',
        'convertResponsesOutputToInputItemsJson',
        'materializeResponsesContinuationPayloadJson',
        'restoreResponsesContinuationPayloadJson',
        'resumeResponsesConversationPayloadJson',
        'planResponsesConversationPreflightJson',
        'planResponsesCapturedEntryJson',
        'planResponsesContinuationLookupByResponseIdJson',
        'planResponsesContinuationMetaJson',
        'planResponsesConversationRetentionJson',
        'planResponsesStoreTokensJson',
        'planResponsesScopeContinuationMatchJson',
      ]) {
        if (typeof (getRouterHotpathJsonBindingSync() as unknown as Record<string, unknown>)[name] !== 'function') {
          throw new Error(`[responses-conversation-store-host] ${name} not available`);
        }
      }
    },
    buildConversationScopePlan: (input) => callNativeJson('buildResponsesConversationScopePlanJson', input),
    collectPendingToolCallIds: (input) => callNativeJson('collectResponsesPendingToolCallIdsJson', input),
    convertOutputToInputItems: (response) => callNativeJson('convertResponsesOutputToInputItemsJson', response),
    materializeContinuationPayload: (entry, payload, requestId, scopeKey) =>
      callNativeResumeJson('materializeResponsesContinuationPayloadJson', entry, payload, requestId, scopeKey),
    restoreContinuationPayload: (entry, payload, requestId, scopeKey) =>
      callNativeResumeJson('restoreResponsesContinuationPayloadJson', entry, payload, requestId, scopeKey),
    resumeConversationPayload: (entry, responseId, submitPayload, requestId) =>
      callNativeResumeConversationJson(entry, responseId, submitPayload, requestId),
    planAttachEntryScopes: (input) => callNativeJson('planResponsesAttachEntryScopesJson', input),
    planCapturePendingCleanup: (input) => callNativeJson('planResponsesCapturePendingCleanupJson', input),
    planCapturedEntry: (input) => callNativeJson('planResponsesCapturedEntryJson', input),
    planConversationPreflight: (input) => callNativeJson('planResponsesConversationPreflightJson', input),
    planContinuationLookupByResponseId: (input) => callNativeJson('planResponsesContinuationLookupByResponseIdJson', input),
    planContinuationMeta: (input) => callNativeJson('planResponsesContinuationMetaJson', input),
    planConversationRetention: (entry, options) => callNativeJson('planResponsesConversationRetentionJson', entry, options),
    planPersistedEntry: (input) => callNativeJson('planResponsesPersistedEntryJson', input),
    planPersistenceEligibility: (entry, options) => callNativeJson('planResponsesConversationPersistenceEligibilityJson', entry, options),
    planRebindRequestId: (input) => callNativeJson('planResponsesRebindRequestIdJson', input),
    planReleaseRequestPayload: (entry) => callNativeJson('planResponsesReleaseRequestPayloadJson', entry),
    planRecordScopeCleanup: (input) => callNativeJson('planResponsesRecordScopeCleanupJson', input),
    planRecordContinuationFlag: (input) => callNativeJson('planResponsesRecordContinuationFlagJson', input),
    planRecordScopeEntryMatch: (input) => callNativeJson('planResponsesRecordScopeEntryMatchJson', input),
    planResumeEntryMatch: (input) => callNativeJson('planResponsesConversationResumeEntryMatchJson', input),
    planStoreSweep: (input) => callNativeJson('planResponsesStoreSweepJson', input),
    planStoreTokens: (input) => callNativeJson('planResponsesStoreTokensJson', input),
    planScopeContinuationMatch: (input) => callNativeJson('planResponsesScopeContinuationMatchJson', input),
  };
}

function requireResponsesStoreNativeFn<TFunction extends Function>(
  name: keyof ResponsesConversationStoreNativeModule
): TFunction {
  const responsesConversationStoreNative = getResponsesConversationStoreNative();
  const fn = responsesConversationStoreNative[name];
  if (typeof fn !== 'function') {
    throw new Error(`[responses-conversation-store-host] ${String(name)} not available`);
  }
  return fn as unknown as TFunction;
}

function lazyResponsesStoreNativeFn<TFunction extends Function>(
  name: keyof ResponsesConversationStoreNativeModule
): TFunction {
  return ((...args: unknown[]) => {
    const fn = requireResponsesStoreNativeFn<TFunction>(name) as unknown as (...innerArgs: unknown[]) => unknown;
    return fn(...args);
  }) as unknown as TFunction;
}

const assertResponsesConversationStoreNativeAvailable =
  lazyResponsesStoreNativeFn<() => void>('assertResponsesConversationStoreNativeAvailable');
const buildConversationScopePlan =
  lazyResponsesStoreNativeFn<NonNullable<ResponsesConversationStoreNativeModule['buildConversationScopePlan']>>('buildConversationScopePlan');
const collectPendingToolCallIds =
  lazyResponsesStoreNativeFn<NonNullable<ResponsesConversationStoreNativeModule['collectPendingToolCallIds']>>('collectPendingToolCallIds');
const convertOutputToInputItems =
  lazyResponsesStoreNativeFn<NonNullable<ResponsesConversationStoreNativeModule['convertOutputToInputItems']>>('convertOutputToInputItems');
const materializeContinuationPayload =
  lazyResponsesStoreNativeFn<NonNullable<ResponsesConversationStoreNativeModule['materializeContinuationPayload']>>('materializeContinuationPayload');
const planAttachEntryScopes =
  lazyResponsesStoreNativeFn<NonNullable<ResponsesConversationStoreNativeModule['planAttachEntryScopes']>>('planAttachEntryScopes');
const planCapturePendingCleanup =
  lazyResponsesStoreNativeFn<NonNullable<ResponsesConversationStoreNativeModule['planCapturePendingCleanup']>>('planCapturePendingCleanup');
const planCapturedEntry =
  lazyResponsesStoreNativeFn<NonNullable<ResponsesConversationStoreNativeModule['planCapturedEntry']>>('planCapturedEntry');
const planConversationPreflight =
  lazyResponsesStoreNativeFn<NonNullable<ResponsesConversationStoreNativeModule['planConversationPreflight']>>('planConversationPreflight');
const planContinuationLookupByResponseId =
  lazyResponsesStoreNativeFn<NonNullable<ResponsesConversationStoreNativeModule['planContinuationLookupByResponseId']>>('planContinuationLookupByResponseId');
const planContinuationMeta =
  lazyResponsesStoreNativeFn<NonNullable<ResponsesConversationStoreNativeModule['planContinuationMeta']>>('planContinuationMeta');
const planConversationRetention =
  lazyResponsesStoreNativeFn<NonNullable<ResponsesConversationStoreNativeModule['planConversationRetention']>>('planConversationRetention');
const planPersistedEntry =
  lazyResponsesStoreNativeFn<NonNullable<ResponsesConversationStoreNativeModule['planPersistedEntry']>>('planPersistedEntry');
const planPersistenceEligibility =
  lazyResponsesStoreNativeFn<NonNullable<ResponsesConversationStoreNativeModule['planPersistenceEligibility']>>('planPersistenceEligibility');
const planRebindRequestId =
  lazyResponsesStoreNativeFn<NonNullable<ResponsesConversationStoreNativeModule['planRebindRequestId']>>('planRebindRequestId');
const planReleaseRequestPayload =
  lazyResponsesStoreNativeFn<NonNullable<ResponsesConversationStoreNativeModule['planReleaseRequestPayload']>>('planReleaseRequestPayload');
const planRecordScopeCleanup =
  lazyResponsesStoreNativeFn<NonNullable<ResponsesConversationStoreNativeModule['planRecordScopeCleanup']>>('planRecordScopeCleanup');
const planRecordContinuationFlag =
  lazyResponsesStoreNativeFn<NonNullable<ResponsesConversationStoreNativeModule['planRecordContinuationFlag']>>('planRecordContinuationFlag');
const planRecordScopeEntryMatch =
  lazyResponsesStoreNativeFn<NonNullable<ResponsesConversationStoreNativeModule['planRecordScopeEntryMatch']>>('planRecordScopeEntryMatch');
const planResumeEntryMatch =
  lazyResponsesStoreNativeFn<NonNullable<ResponsesConversationStoreNativeModule['planResumeEntryMatch']>>('planResumeEntryMatch');
const planStoreSweep =
  lazyResponsesStoreNativeFn<NonNullable<ResponsesConversationStoreNativeModule['planStoreSweep']>>('planStoreSweep');
const planStoreTokens =
  lazyResponsesStoreNativeFn<NonNullable<ResponsesConversationStoreNativeModule['planStoreTokens']>>('planStoreTokens');
const planScopeContinuationMatch =
  lazyResponsesStoreNativeFn<NonNullable<ResponsesConversationStoreNativeModule['planScopeContinuationMatch']>>('planScopeContinuationMatch');
const restoreContinuationPayload =
  lazyResponsesStoreNativeFn<NonNullable<ResponsesConversationStoreNativeModule['restoreContinuationPayload']>>('restoreContinuationPayload');
const resumeConversationPayload =
  lazyResponsesStoreNativeFn<NonNullable<ResponsesConversationStoreNativeModule['resumeConversationPayload']>>('resumeConversationPayload');

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

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

function serializeEntry(entry: ConversationEntry): ConversationEntry | undefined {
  const cloned = cloneJsonRecord(entry);
  if (!cloned) return undefined;
  const plan = planPersistedEntry({ mode: 'serialize', entry: cloned });
  return plan.action === 'entry' ? plan.entry : undefined;
}

function deserializeEntry(value: unknown): ConversationEntry | undefined {
  const cloned = cloneJsonRecord(value);
  if (!cloned) return undefined;
  const plan = planPersistedEntry({ mode: 'deserialize', entry: cloned, nowMs: Date.now() });
  return plan.action === 'entry' ? plan.entry : undefined;
}

function normalizeStoreTokens(input: unknown): {
  providerKey?: string;
  sessionId?: string;
  conversationId?: string;
  entryKind: ResponsesContinuationEntryKind;
  continuationOwner?: 'direct' | 'relay';
} {
  return planStoreTokens(input);
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
  return planContinuationMeta({ meta, entry }).meta;
}

function collectScopeMatchCandidates(scopeIndex: Map<string, ConversationEntry>, scopeKeys: string[]) {
  const entriesByScopeKey = new Map<string, ConversationEntry>();
  const candidates: ScopeContinuationMatchCandidate[] = [];
  for (const scopeKey of scopeKeys) {
    const entry = scopeIndex.get(scopeKey);
    if (!entry) continue;
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

function projectResumeEntryCandidate(
  entry: ConversationEntry,
  source: 'response_index' | 'request_map' | 'scope',
  scopeKey?: string
) {
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

  deleteResponseIndexForDebug(responseId?: string): void {
    if (typeof responseId !== 'string' || !responseId.trim()) return;
    this.responseIndex.delete(responseId.trim());
  }

  hasRequestForDebug(requestId?: string): boolean {
    return typeof requestId === 'string' && requestId.trim().length > 0
      ? this.requestMap.has(requestId.trim())
      : false;
  }

  hasResponseForDebug(responseId?: string): boolean {
    return typeof responseId === 'string' && responseId.trim().length > 0
      ? this.responseIndex.has(responseId.trim())
      : false;
  }

  hasScopeForDebug(scopeKey?: string): boolean {
    return typeof scopeKey === 'string' && scopeKey.trim().length > 0
      ? this.scopeIndex.has(scopeKey.trim())
      : false;
  }

  rebindRequestId(oldId: string | undefined, newId: string | undefined): void {
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
    if (!entry) return;
    this.requestMap.delete(plan.oldId);
    entry.requestId = plan.newId;
    this.requestMap.set(plan.newId, entry);
  }

  captureRequestContext(args: CaptureContextArgs): void {
    this.ensurePersistenceLoaded();
    const { payload, context } = args;
    const capturePreflight = planConversationPreflight({
      mode: 'capture_request',
      requestId: args.requestId,
      payload
    });
    if (capturePreflight.action !== 'continue') return;
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
      if (candidate) this.detachEntry(candidate);
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
    if (entryPlan.action !== 'entry' || !entryPlan.entry) return;
    const entry = entryPlan.entry;
    this.requestMap.set(requestId, entry);
    this.flushPersistence();
  }

  recordResponse(args: RecordResponseArgs): void {
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
    const recordCleanupCandidates = new Map<string, {
      requestId?: string;
      lastResponseId?: string;
      scopeKeys?: string[];
    }>();
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
    const entriesByRequestId = new Map<string, ConversationEntry>();
    const candidates: ReturnType<typeof projectResumeEntryCandidate>[] = [];
    const indexedEntry = this.responseIndex.get(normalizedResponseId);
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

  materializeLatestContinuationByScope(args: RestoreByScopeArgs): ResumeResult | null {
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

  private cleanupEntry(entry: ConversationEntry, responseId: string): void {
    this.responseIndex.delete(responseId);
    this.detachEntry(entry);
  }

  private attachEntryScopes(entry: ConversationEntry): void {
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
      if (previous) this.detachEntry(previous);
    }
    for (const key of attachPlan.scopeKeys) {
      this.scopeIndex.set(key, entry);
    }
  }

  private detachEntry(entry: ConversationEntry): void {
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
      try {
        this.prune();
      } catch (error) {
        logResponsesStoreNonBlockingError('prune.timer', error);
      }
    }, PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();
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

// Expose raw store for memory-observer diagnostics
(globalThis as Record<string, unknown>)[RESPONSES_CONVERSATION_STORE_GLOBAL_KEY] = store;
