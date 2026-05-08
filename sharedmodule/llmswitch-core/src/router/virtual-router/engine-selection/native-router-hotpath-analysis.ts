import { formatUnknownError } from '../../../shared/common-utils.js';

export type PendingToolSyncPayload = {
  ready: boolean;
  insertAt: number;
};

export type ContinueExecutionInjectionPayload = {
  hasDirective: boolean;
};

export type ChatProcessMediaAnalysisPayload = {
  stripIndices: number[];
  containsCurrentTurnImage: boolean;
};

export type ChatProcessMediaStripPayload = {
  changed: boolean;
  messages: unknown[];
};

export type ChatWebSearchIntentPayload = {
  hasIntent: boolean;
  googlePreferred: boolean;
};

export type ClockClearDirectivePayload = {
  hadClear: boolean;
  next: string;
};

export type ProviderKeyParsePayload = {
  providerId: string | null;
  alias: string | null;
  keyIndex?: number;
};

export type AntigravitySessionIdPayload = {
  sessionId: string;
};

export type AntigravityPinnedAliasLookupPayload = {
  alias?: string;
};

export type AntigravityPinnedAliasUnpinPayload = {
  changed: boolean;
};

export type AntigravityCacheSignaturePayload = {
  ok: boolean;
};

export type AntigravityRequestSessionMetaPayload = {
  aliasKey?: string;
  sessionId?: string;
  messageCount?: number;
};

export type ServertoolResponseStageToolCallPayload = {
  id: string;
  name: string;
  arguments: string;
};

export type ServertoolResponseStagePayload = {
  providerResponseShape: string;
  isCanonicalChatCompletionPayload: boolean;
  payloadContractSignal?: {
    reason: string;
    marker: string;
  } | null;
  normalizedPayload: unknown;
  toolCalls: ServertoolResponseStageToolCallPayload[];
};

export type ServertoolDispatchCandidatePayload = {
  id: string;
  name: string;
  arguments: string;
  executionMode: string;
  stripAfterExecute: boolean;
};

export type ServertoolDispatchSkippedPayload = {
  id: string;
  name: string;
  reason: string;
};

export type ServertoolDispatchPlanPayload = {
  executableToolCalls: ServertoolDispatchCandidatePayload[];
  skippedToolCalls: ServertoolDispatchSkippedPayload[];
};

export type ServertoolOutcomePlanPayload = {
  outcomeMode: string;
  remainingToolCallIds: string[];
  pendingSessionId?: string | null;
  aliasSessionIds: string[];
  pendingInjectionMessageKinds: string[];
  pendingInjectionMessagesResolved: unknown[];
  flowId?: string | null;
  useLastExecutionFollowup: boolean;
  useGenericFollowup: boolean;
  followupStrategy: string;
  requiresPendingInjection: boolean;
  primaryExecutionMode?: string | null;
  followupInjectionOps: string[];
  followupInjectionOpsResolved: unknown[];
};

export type ServertoolAutoHookPlanEntryPayload = {
  id: string;
  phase: string;
  priority: number;
  order: number;
};

export type ServertoolAutoHookQueuesPayload = {
  optionalQueue: ServertoolAutoHookPlanEntryPayload[];
  mandatoryQueue: ServertoolAutoHookPlanEntryPayload[];
};

export type ServertoolGenericFollowupPayload = {
  model: string;
  messages: unknown[];
  tools: unknown[];
  parameters?: Record<string, unknown>;
};

export type ServertoolFollowupFlowProfilePayload = {
  noFollowup?: boolean;
  autoLimit?: boolean;
  flowOnlyLoopLimit?: boolean;
  stickyProvider?: boolean;
  clientInjectOnly?: boolean;
  seedLoopPayload?: boolean;
  retryEmptyFollowupOnce?: boolean;
  clientInjectSource?: string;
  transparentReplayRequestSuffix?: string;
  ignoreRequiresActionFollowup?: boolean;
  contextDecorationMode?: 'continue_execution_summary' | 'web_search_summary';
};

export type ServertoolFollowupRuntimePlanPayload = {
  outcomeMode: 'skip' | 'client_inject_only' | 'reenter';
  noFollowup: boolean;
  autoLimit: boolean;
  flowOnlyLoopLimit: boolean;
  stickyProvider: boolean;
  clientInjectOnly: boolean;
  seedLoopPayload: boolean;
  retryEmptyFollowupOnce: boolean;
  ignoreRequiresActionFollowup: boolean;
  clientInjectSource?: string;
  transparentReplayRequestSuffix?: string;
  contextDecorationMode?: 'continue_execution_summary' | 'web_search_summary';
};

const NON_BLOCKING_PARSE_LOG_THROTTLE_MS = 60_000;
const nonBlockingParseLogState = new Map<string, number>();
const JSON_PARSE_FAILED = Symbol('native-router-hotpath-analysis.parse-failed');


function logNativeRouterHotpathAnalysisNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingParseLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_PARSE_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingParseLogState.set(stage, now);
  console.warn(
    `[native-router-hotpath-analysis] ${stage} parse failed (non-blocking): ${formatUnknownError(error)}`
  );
}

function parseJson(stage: string, raw: string): unknown | typeof JSON_PARSE_FAILED {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logNativeRouterHotpathAnalysisNonBlocking(stage, error);
    return JSON_PARSE_FAILED;
  }
}

export function parsePendingToolSyncPayload(raw: string): PendingToolSyncPayload | null {
  const parsed = parseJson('parsePendingToolSyncPayload', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof (parsed as PendingToolSyncPayload).ready !== 'boolean') {
    return null;
  }
  const payload = parsed as PendingToolSyncPayload;
  const insertAt =
    typeof payload.insertAt === 'number' && Number.isFinite(payload.insertAt)
      ? Math.floor(payload.insertAt)
      : -1;
  return {
    ready: payload.ready,
    insertAt
  };
}

export function parseContinueExecutionInjectionPayload(raw: string): ContinueExecutionInjectionPayload | null {
  const parsed = parseJson('parseContinueExecutionInjectionPayload', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof (parsed as ContinueExecutionInjectionPayload).hasDirective !== 'boolean') {
    return null;
  }
  return { hasDirective: (parsed as ContinueExecutionInjectionPayload).hasDirective };
}

export function parseChatProcessMediaAnalysisPayload(raw: string): ChatProcessMediaAnalysisPayload | null {
  const parsed = parseJson('parseChatProcessMediaAnalysisPayload', raw) as {
    stripIndices?: unknown;
    containsCurrentTurnImage?: unknown;
  } | typeof JSON_PARSE_FAILED;
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed.containsCurrentTurnImage !== 'boolean') {
    return null;
  }
  const stripIndices = Array.isArray(parsed.stripIndices)
    ? parsed.stripIndices
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
        .map((value) => Math.floor(value))
    : [];
  return {
    stripIndices,
    containsCurrentTurnImage: parsed.containsCurrentTurnImage
  };
}

export function parseChatProcessMediaStripPayload(raw: string): ChatProcessMediaStripPayload | null {
  const parsed = parseJson('parseChatProcessMediaStripPayload', raw) as {
    changed?: unknown;
    messages?: unknown;
  } | typeof JSON_PARSE_FAILED;
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed.changed !== 'boolean' || !Array.isArray(parsed.messages)) {
    return null;
  }
  return {
    changed: parsed.changed,
    messages: parsed.messages
  };
}

export function parseChatWebSearchIntentPayload(raw: string): ChatWebSearchIntentPayload | null {
  const parsed = parseJson('parseChatWebSearchIntentPayload', raw) as {
    hasIntent?: unknown;
    googlePreferred?: unknown;
  } | typeof JSON_PARSE_FAILED;
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed.hasIntent !== 'boolean' || typeof parsed.googlePreferred !== 'boolean') {
    return null;
  }
  return {
    hasIntent: parsed.hasIntent,
    googlePreferred: parsed.googlePreferred
  };
}

export function parseClockClearDirectivePayload(raw: string): ClockClearDirectivePayload | null {
  const parsed = parseJson('parseClockClearDirectivePayload', raw) as {
    hadClear?: unknown;
    next?: unknown;
  } | typeof JSON_PARSE_FAILED;
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed.hadClear !== 'boolean' || typeof parsed.next !== 'string') {
    return null;
  }
  return {
    hadClear: parsed.hadClear,
    next: parsed.next
  };
}

export function parseProviderKeyPayload(raw: string): ProviderKeyParsePayload | null {
  const parsed = parseJson('parseProviderKeyPayload', raw) as {
    providerId?: unknown;
    alias?: unknown;
    keyIndex?: unknown;
  } | typeof JSON_PARSE_FAILED;
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object') {
    return null;
  }
  const providerId =
    typeof parsed.providerId === 'string'
      ? parsed.providerId
      : parsed.providerId === null
        ? null
        : null;
  const alias =
    typeof parsed.alias === 'string'
      ? parsed.alias
      : parsed.alias === null
        ? null
        : null;
  const keyIndex =
    typeof parsed.keyIndex === 'number' && Number.isFinite(parsed.keyIndex)
      ? Math.floor(parsed.keyIndex)
      : undefined;
  return {
    providerId,
    alias,
    ...(keyIndex !== undefined ? { keyIndex } : {})
  };
}

export function parseAntigravitySessionIdPayload(raw: string): AntigravitySessionIdPayload | null {
  const parsed = parseJson('parseAntigravitySessionIdPayload', raw);
  if (parsed === JSON_PARSE_FAILED || typeof parsed !== 'string') {
    return null;
  }
  const sessionId = parsed.trim();
  if (!sessionId) {
    return null;
  }
  return { sessionId };
}

export function parseAntigravityPinnedAliasLookupPayload(raw: string): AntigravityPinnedAliasLookupPayload | null {
  const parsed = parseJson('parseAntigravityPinnedAliasLookupPayload', raw) as
    | { alias?: unknown }
    | null
    | typeof JSON_PARSE_FAILED;
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null) {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  if (parsed.alias === undefined || parsed.alias === null) {
    return {};
  }
  if (typeof parsed.alias !== 'string') {
    return null;
  }
  const alias = parsed.alias.trim();
  if (!alias) {
    return {};
  }
  return { alias };
}

export function parseAntigravityPinnedAliasUnpinPayload(raw: string): AntigravityPinnedAliasUnpinPayload | null {
  const parsed = parseJson('parseAntigravityPinnedAliasUnpinPayload', raw) as
    | { changed?: unknown }
    | typeof JSON_PARSE_FAILED;
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed.changed !== 'boolean') {
    return null;
  }
  return { changed: parsed.changed };
}

export function parseAntigravityCacheSignaturePayload(raw: string): AntigravityCacheSignaturePayload | null {
  const parsed = parseJson('parseAntigravityCacheSignaturePayload', raw) as
    | { ok?: unknown }
    | typeof JSON_PARSE_FAILED;
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed.ok !== 'boolean') {
    return null;
  }
  return { ok: parsed.ok };
}

export function parseAntigravityRequestSessionMetaPayload(raw: string): AntigravityRequestSessionMetaPayload | null {
  const parsed = parseJson('parseAntigravityRequestSessionMetaPayload', raw) as
    | {
        aliasKey?: unknown;
        sessionId?: unknown;
        messageCount?: unknown;
      }
    | null
    | typeof JSON_PARSE_FAILED;
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null) {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const aliasKey =
    typeof parsed.aliasKey === 'string' && parsed.aliasKey.trim().length
      ? parsed.aliasKey.trim()
      : undefined;
  const sessionId =
    typeof parsed.sessionId === 'string' && parsed.sessionId.trim().length
      ? parsed.sessionId.trim()
      : undefined;
  const messageCount =
    typeof parsed.messageCount === 'number' && Number.isFinite(parsed.messageCount) && parsed.messageCount > 0
      ? Math.floor(parsed.messageCount)
      : undefined;
  return {
    ...(aliasKey ? { aliasKey } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(messageCount !== undefined ? { messageCount } : {})
  };
}

export function parseServertoolResponseStagePayload(raw: string): ServertoolResponseStagePayload | null {
  const parsed = parseJson('parseServertoolResponseStagePayload', raw) as
    | {
        providerResponseShape?: unknown;
        isCanonicalChatCompletionPayload?: unknown;
        payloadContractSignal?: unknown;
        normalizedPayload?: unknown;
        toolCalls?: unknown;
      }
    | typeof JSON_PARSE_FAILED;
  if (
    parsed === JSON_PARSE_FAILED ||
    !parsed ||
    typeof parsed.providerResponseShape !== 'string' ||
    typeof parsed.isCanonicalChatCompletionPayload !== 'boolean' ||
    !Array.isArray(parsed.toolCalls)
  ) {
    return null;
  }
  const toolCalls = parsed.toolCalls
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : '',
      name: typeof entry.name === 'string' ? entry.name : '',
      arguments: typeof entry.arguments === 'string' ? entry.arguments : ''
    }))
    .filter((entry) => entry.id && entry.name);
  const payloadContractSignal =
    parsed.payloadContractSignal &&
    typeof parsed.payloadContractSignal === 'object' &&
    !Array.isArray(parsed.payloadContractSignal) &&
    typeof (parsed.payloadContractSignal as Record<string, unknown>).reason === 'string' &&
    typeof (parsed.payloadContractSignal as Record<string, unknown>).marker === 'string'
      ? {
          reason: String((parsed.payloadContractSignal as Record<string, unknown>).reason),
          marker: String((parsed.payloadContractSignal as Record<string, unknown>).marker)
        }
      : parsed.payloadContractSignal == null
        ? null
        : undefined;
  return {
    providerResponseShape: parsed.providerResponseShape,
    isCanonicalChatCompletionPayload: parsed.isCanonicalChatCompletionPayload,
    ...(payloadContractSignal !== undefined ? { payloadContractSignal } : {}),
    normalizedPayload: parsed.normalizedPayload,
    toolCalls
  };
}

export function parseServertoolDispatchPlanPayload(raw: string): ServertoolDispatchPlanPayload | null {
  const parsed = parseJson('parseServertoolDispatchPlanPayload', raw) as
    | {
      executableToolCalls?: unknown;
      skippedToolCalls?: unknown;
    }
    | typeof JSON_PARSE_FAILED;
  if (
    parsed === JSON_PARSE_FAILED ||
    !parsed ||
    !Array.isArray(parsed.executableToolCalls) ||
    !Array.isArray(parsed.skippedToolCalls)
  ) {
    return null;
  }
  const executableToolCalls = parsed.executableToolCalls
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : '',
      name: typeof entry.name === 'string' ? entry.name : '',
      arguments: typeof entry.arguments === 'string' ? entry.arguments : '',
      executionMode: typeof entry.executionMode === 'string' ? entry.executionMode : '',
      stripAfterExecute: entry.stripAfterExecute === true
    }))
    .filter((entry) => entry.id && entry.name && entry.executionMode);
  const skippedToolCalls = parsed.skippedToolCalls
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : '',
      name: typeof entry.name === 'string' ? entry.name : '',
      reason: typeof entry.reason === 'string' ? entry.reason : ''
    }))
    .filter((entry) => entry.id && entry.name && entry.reason);
  return {
    executableToolCalls,
    skippedToolCalls
  };
}

export function parseServertoolOutcomePlanPayload(raw: string): ServertoolOutcomePlanPayload | null {
  const parsed = parseJson('parseServertoolOutcomePlanPayload', raw) as
    | {
      outcomeMode?: unknown;
      remainingToolCallIds?: unknown;
      pendingSessionId?: unknown;
      aliasSessionIds?: unknown;
      pendingInjectionMessageKinds?: unknown;
      pendingInjectionMessagesResolved?: unknown;
      flowId?: unknown;
      useLastExecutionFollowup?: unknown;
      useGenericFollowup?: unknown;
      followupStrategy?: unknown;
      requiresPendingInjection?: unknown;
      primaryExecutionMode?: unknown;
      followupInjectionOps?: unknown;
      followupInjectionOpsResolved?: unknown;
    }
    | typeof JSON_PARSE_FAILED;
  if (
    parsed === JSON_PARSE_FAILED ||
    !parsed ||
    typeof parsed.outcomeMode !== 'string' ||
    !Array.isArray(parsed.remainingToolCallIds) ||
    !Array.isArray(parsed.aliasSessionIds) ||
    !Array.isArray(parsed.pendingInjectionMessageKinds) ||
    !Array.isArray(parsed.pendingInjectionMessagesResolved) ||
    typeof parsed.useLastExecutionFollowup !== 'boolean' ||
    typeof parsed.useGenericFollowup !== 'boolean' ||
    typeof parsed.followupStrategy !== 'string' ||
    typeof parsed.requiresPendingInjection !== 'boolean' ||
    !Array.isArray(parsed.followupInjectionOps) ||
    !Array.isArray(parsed.followupInjectionOpsResolved)
  ) {
    return null;
  }
  return {
    outcomeMode: parsed.outcomeMode,
    remainingToolCallIds: parsed.remainingToolCallIds
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim()),
    ...(typeof parsed.pendingSessionId === 'string' && parsed.pendingSessionId.trim()
      ? { pendingSessionId: parsed.pendingSessionId.trim() }
      : parsed.pendingSessionId === null
        ? { pendingSessionId: null }
        : {}),
    aliasSessionIds: parsed.aliasSessionIds
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim()),
    pendingInjectionMessageKinds: parsed.pendingInjectionMessageKinds
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim()),
    pendingInjectionMessagesResolved: parsed.pendingInjectionMessagesResolved,
    ...(typeof parsed.flowId === 'string' && parsed.flowId.trim()
      ? { flowId: parsed.flowId.trim() }
      : parsed.flowId === null
        ? { flowId: null }
        : {}),
    useLastExecutionFollowup: parsed.useLastExecutionFollowup,
    useGenericFollowup: parsed.useGenericFollowup,
    followupStrategy: parsed.followupStrategy,
    requiresPendingInjection: parsed.requiresPendingInjection,
    followupInjectionOps: parsed.followupInjectionOps
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim()),
    followupInjectionOpsResolved: parsed.followupInjectionOpsResolved,
    ...(typeof parsed.primaryExecutionMode === 'string' && parsed.primaryExecutionMode.trim()
      ? { primaryExecutionMode: parsed.primaryExecutionMode.trim() }
      : parsed.primaryExecutionMode === null
        ? { primaryExecutionMode: null }
        : {})
  };
}

export function parseServertoolAutoHookQueuesPayload(raw: string): ServertoolAutoHookQueuesPayload | null {
  const parsed = parseJson('parseServertoolAutoHookQueuesPayload', raw) as
    | {
      optionalQueue?: unknown;
      mandatoryQueue?: unknown;
    }
    | typeof JSON_PARSE_FAILED;
  if (
    parsed === JSON_PARSE_FAILED ||
    !parsed ||
    !Array.isArray(parsed.optionalQueue) ||
    !Array.isArray(parsed.mandatoryQueue)
  ) {
    return null;
  }

  const normalizeQueue = (entries: unknown[]): ServertoolAutoHookPlanEntryPayload[] =>
    entries
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
      .map((entry) => ({
        id: typeof entry.id === 'string' ? entry.id : '',
        phase: typeof entry.phase === 'string' ? entry.phase : 'default',
        priority:
          typeof entry.priority === 'number' && Number.isFinite(entry.priority)
            ? Math.floor(entry.priority)
            : 100,
        order:
          typeof entry.order === 'number' && Number.isFinite(entry.order)
            ? Math.floor(entry.order)
            : 0
      }))
      .filter((entry) => entry.id.length > 0);

  return {
    optionalQueue: normalizeQueue(parsed.optionalQueue),
    mandatoryQueue: normalizeQueue(parsed.mandatoryQueue)
  };
}

export function parseServertoolGenericFollowupPayload(raw: string): ServertoolGenericFollowupPayload | null {
  const parsed = parseJson('parseServertoolGenericFollowupPayload', raw) as
    | {
      model?: unknown;
      messages?: unknown;
      tools?: unknown;
      parameters?: unknown;
    }
    | typeof JSON_PARSE_FAILED;
  if (
    parsed === JSON_PARSE_FAILED ||
    !parsed ||
    typeof parsed.model !== 'string' ||
    !Array.isArray(parsed.messages) ||
    !Array.isArray(parsed.tools)
  ) {
    return null;
  }
  return {
    model: parsed.model.trim(),
    messages: parsed.messages,
    tools: parsed.tools,
    ...(parsed.parameters && typeof parsed.parameters === 'object' && !Array.isArray(parsed.parameters)
      ? { parameters: parsed.parameters as Record<string, unknown> }
      : {})
  };
}

export function parseServertoolFollowupFlowProfilePayload(raw: string): ServertoolFollowupFlowProfilePayload | null {
  const parsed = parseJson('parseServertoolFollowupFlowProfilePayload', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null) {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const profile = parsed as Record<string, unknown>;
  return {
    ...(profile.noFollowup === true ? { noFollowup: true } : {}),
    ...(profile.autoLimit === true ? { autoLimit: true } : {}),
    ...(profile.flowOnlyLoopLimit === true ? { flowOnlyLoopLimit: true } : {}),
    ...(profile.stickyProvider === true ? { stickyProvider: true } : {}),
    ...(profile.clientInjectOnly === true ? { clientInjectOnly: true } : {}),
    ...(profile.seedLoopPayload === true ? { seedLoopPayload: true } : {}),
    ...(profile.retryEmptyFollowupOnce === true ? { retryEmptyFollowupOnce: true } : {}),
    ...(typeof profile.clientInjectSource === 'string' && profile.clientInjectSource.trim()
      ? { clientInjectSource: profile.clientInjectSource.trim() }
      : {}),
    ...(typeof profile.transparentReplayRequestSuffix === 'string' && profile.transparentReplayRequestSuffix.trim()
      ? { transparentReplayRequestSuffix: profile.transparentReplayRequestSuffix.trim() }
      : {}),
    ...(profile.ignoreRequiresActionFollowup === true ? { ignoreRequiresActionFollowup: true } : {}),
    ...(profile.contextDecorationMode === 'continue_execution_summary' || profile.contextDecorationMode === 'web_search_summary'
      ? { contextDecorationMode: profile.contextDecorationMode }
      : {})
  };
}

export function parseServertoolFollowupRuntimePlanPayload(raw: string): ServertoolFollowupRuntimePlanPayload | null {
  const parsed = parseJson('parseServertoolFollowupRuntimePlanPayload', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const plan = parsed as Record<string, unknown>;
  if (
    plan.outcomeMode !== 'skip' &&
    plan.outcomeMode !== 'client_inject_only' &&
    plan.outcomeMode !== 'reenter'
  ) {
    return null;
  }
  return {
    outcomeMode: plan.outcomeMode,
    noFollowup: plan.noFollowup === true,
    autoLimit: plan.autoLimit === true,
    flowOnlyLoopLimit: plan.flowOnlyLoopLimit === true,
    stickyProvider: plan.stickyProvider === true,
    clientInjectOnly: plan.clientInjectOnly === true,
    seedLoopPayload: plan.seedLoopPayload === true,
    retryEmptyFollowupOnce: plan.retryEmptyFollowupOnce === true,
    ignoreRequiresActionFollowup: plan.ignoreRequiresActionFollowup === true,
    ...(typeof plan.clientInjectSource === 'string' && plan.clientInjectSource.trim()
      ? { clientInjectSource: plan.clientInjectSource.trim() }
      : {}),
    ...(typeof plan.transparentReplayRequestSuffix === 'string' && plan.transparentReplayRequestSuffix.trim()
      ? { transparentReplayRequestSuffix: plan.transparentReplayRequestSuffix.trim() }
      : {}),
    ...(plan.contextDecorationMode === 'continue_execution_summary' || plan.contextDecorationMode === 'web_search_summary'
      ? { contextDecorationMode: plan.contextDecorationMode }
      : {})
  };
}
