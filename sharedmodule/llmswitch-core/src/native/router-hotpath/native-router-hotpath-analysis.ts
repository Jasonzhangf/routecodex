import { formatUnknownError } from '../../shared/common-utils.js';

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

export type SanitizeMessagesPayload = {
  messages: Record<string, unknown>[];
  removedAssistantTurns: number;
  removedEmptyAssistantTurns: number;
  removedTemplateAssistantTurns: number;
  removedDuplicateMirrorAssistantTurns: number;
  didMutateMessageShapes: boolean;
};

export type ClockClearDirectivePayload = {
  hadClear: boolean;
  next: string;
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

export type ServertoolDispatchNoopPayload = {
  id: string;
  name: string;
  arguments: string;
  executionMode?: string;
  stripAfterExecute?: boolean;
};

export type ServertoolDispatchPlanPayload = {
  executableToolCalls: ServertoolDispatchCandidatePayload[];
  noopToolCalls: ServertoolDispatchNoopPayload[];
  skippedToolCalls: ServertoolDispatchSkippedPayload[];
};

export type ServertoolDispatchPlanInputHandlerPayload = {
  name: string;
  trigger: string;
  executionMode: string;
  stripAfterExecute: boolean;
};

export type ServertoolDispatchPlanInputPayload = {
  toolCalls: ServertoolResponseStageToolCallPayload[];
  disableToolCallHandlers: boolean;
  includeToolCallHandlerNames?: string[] | null;
  excludeToolCallHandlerNames?: string[] | null;
  registeredToolCallHandlers: ServertoolDispatchPlanInputHandlerPayload[];
  runtimeMetadata?: Record<string, unknown>;
};

export type ServertoolOutcomePlanPayload = {
  outcomeMode: string;
  remainingToolCallIds: string[];
  flowId?: string | null;
  requiresPendingInjection: boolean;
  primaryExecutionMode?: string | null;
};

export type ServertoolHandlerContractPlanPayload = {
  action: string;
};

export type ServertoolOutcomePlanInputExecutedToolCallPayload = {
  id: string;
  name: string;
  arguments: string;
  executionMode: string;
  stripAfterExecute: boolean;
};

export type ServertoolOutcomePlanInputPayload = {
  toolCalls: ServertoolResponseStageToolCallPayload[];
  executedToolCalls: ServertoolOutcomePlanInputExecutedToolCallPayload[];
  executedFlowIds: string[];
  lastExecutionFlowId?: string | null;
};

export type ServertoolResponseStageGatePayload = {
  shouldBypass: boolean;
  nextAction: 'bypass' | 'run_auto_hooks' | 'continue_to_execution';
  responseHookMatched: boolean;
  responseHookRequired: boolean;
  responseHookName?: string;
  interceptKind?: string;
  schemaSource?: string;
  skipReason?: string;
};

export type ServertoolAutoHookPlanEntryPayload = {
  id: string;
  phase: string;
  priority: number;
  order: number;
  sourceIndex: number;
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

export type ServertoolFollowupRuntimePlanPayload = {
  flowId?: string;
  outcomeMode: 'skip' | 'client_inject_only' | 'reenter';
  noFollowup: boolean;
  autoLimit: boolean;
  flowOnlyLoopLimit: boolean;
  clientInjectOnly: boolean;
  clearStateOnFollowupFailure: boolean;
  seedLoopPayload: boolean;
  ignoreRequiresActionFollowup: boolean;
  clientInjectSource?: string;
  transparentReplayRequestSuffix?: string;
};

export type StopMessagePersistedLookupPlanPayload = {
  strictSessionScope?: string | null;
  stickyKey?: string | null;
  candidateKeys: string[];
  lookupPolicy: string;
  readStopMessageSnapshot: boolean;
  readStopMessageTombstone: boolean;
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

export function parseStopMessagePersistedLookupPlanPayload(raw: string): StopMessagePersistedLookupPlanPayload | null {
  const parsed = parseJson('parseStopMessagePersistedLookupPlanPayload', raw) as {
    strictSessionScope?: unknown;
    stickyKey?: unknown;
    candidateKeys?: unknown;
    lookupPolicy?: unknown;
    readStopMessageSnapshot?: unknown;
    readStopMessageTombstone?: unknown;
  } | typeof JSON_PARSE_FAILED;
  if (parsed === JSON_PARSE_FAILED || !parsed || !Array.isArray(parsed.candidateKeys) || typeof parsed.lookupPolicy !== 'string' || typeof parsed.readStopMessageSnapshot !== 'boolean' || typeof parsed.readStopMessageTombstone !== 'boolean') {
    return null;
  }
  const candidateKeys = parsed.candidateKeys
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());
  const strictSessionScope = typeof parsed.strictSessionScope === 'string' && parsed.strictSessionScope.trim().length > 0 ? parsed.strictSessionScope.trim() : null;
  const stickyKey = typeof parsed.stickyKey === 'string' && parsed.stickyKey.trim().length > 0 ? parsed.stickyKey.trim() : null;
  return {
    strictSessionScope,
    stickyKey,
    candidateKeys,
    lookupPolicy: parsed.lookupPolicy,
    readStopMessageSnapshot: parsed.readStopMessageSnapshot,
    readStopMessageTombstone: parsed.readStopMessageTombstone
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
      noopToolCalls?: unknown;
      skippedToolCalls?: unknown;
    }
    | typeof JSON_PARSE_FAILED;
  if (
    parsed === JSON_PARSE_FAILED ||
    !parsed ||
    !Array.isArray(parsed.executableToolCalls) ||
    !Array.isArray(parsed.noopToolCalls) ||
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
  const noopToolCalls = parsed.noopToolCalls
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : '',
      name: typeof entry.name === 'string' ? entry.name : '',
      arguments: typeof entry.arguments === 'string' ? entry.arguments : '',
      ...(typeof entry.executionMode === 'string' ? { executionMode: entry.executionMode } : {}),
      ...(typeof entry.stripAfterExecute === 'boolean' ? { stripAfterExecute: entry.stripAfterExecute } : {})
    }))
    .filter((entry) => entry.id && entry.name);
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
    noopToolCalls,
    skippedToolCalls
  };
}

export function parseServertoolDispatchPlanInputPayload(raw: string): ServertoolDispatchPlanInputPayload | null {
  const parsed = parseJson('parseServertoolDispatchPlanInputPayload', raw) as
    | {
      toolCalls?: unknown;
      disableToolCallHandlers?: unknown;
      includeToolCallHandlerNames?: unknown;
      excludeToolCallHandlerNames?: unknown;
      registeredToolCallHandlers?: unknown;
      runtimeMetadata?: Record<string, unknown> | null;
    }
    | typeof JSON_PARSE_FAILED;
  if (
    parsed === JSON_PARSE_FAILED ||
    !parsed ||
    !Array.isArray(parsed.toolCalls) ||
    typeof parsed.disableToolCallHandlers !== 'boolean' ||
    !Array.isArray(parsed.registeredToolCallHandlers)
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
  const registeredToolCallHandlers = parsed.registeredToolCallHandlers
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    .map((entry) => ({
      name: typeof entry.name === 'string' ? entry.name : '',
      trigger: typeof entry.trigger === 'string' ? entry.trigger : '',
      executionMode: typeof entry.executionMode === 'string' ? entry.executionMode : '',
      stripAfterExecute: entry.stripAfterExecute !== false
    }))
    .filter((entry) => entry.name && entry.trigger && entry.executionMode);
  const includeToolCallHandlerNames = Array.isArray(parsed.includeToolCallHandlerNames)
    ? parsed.includeToolCallHandlerNames
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : parsed.includeToolCallHandlerNames === null
      ? null
      : undefined;
  const excludeToolCallHandlerNames = Array.isArray(parsed.excludeToolCallHandlerNames)
    ? parsed.excludeToolCallHandlerNames
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : parsed.excludeToolCallHandlerNames === null
      ? null
      : undefined;
  return {
    toolCalls,
    disableToolCallHandlers: parsed.disableToolCallHandlers,
    ...(includeToolCallHandlerNames !== undefined ? { includeToolCallHandlerNames } : {}),
    ...(excludeToolCallHandlerNames !== undefined ? { excludeToolCallHandlerNames } : {}),
    registeredToolCallHandlers,
    ...(parsed.runtimeMetadata && typeof parsed.runtimeMetadata === 'object' && !Array.isArray(parsed.runtimeMetadata)
      ? { runtimeMetadata: parsed.runtimeMetadata }
      : {})
  };
}

export function parseServertoolOutcomePlanPayload(raw: string): ServertoolOutcomePlanPayload | null {
  const parsed = parseJson('parseServertoolOutcomePlanPayload', raw) as
    | {
      outcomeMode?: unknown;
      remainingToolCallIds?: unknown;
      flowId?: unknown;
      requiresPendingInjection?: unknown;
      primaryExecutionMode?: unknown;
    }
    | typeof JSON_PARSE_FAILED;
  if (
    parsed === JSON_PARSE_FAILED ||
    !parsed ||
    typeof parsed.outcomeMode !== 'string' ||
    !Array.isArray(parsed.remainingToolCallIds) ||
    typeof parsed.requiresPendingInjection !== 'boolean'
  ) {
    return null;
  }
  return {
    outcomeMode: parsed.outcomeMode,
    remainingToolCallIds: parsed.remainingToolCallIds
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim()),
    ...(typeof parsed.flowId === 'string' && parsed.flowId.trim()
      ? { flowId: parsed.flowId.trim() }
      : parsed.flowId === null
        ? { flowId: null }
        : {}),
    requiresPendingInjection: parsed.requiresPendingInjection,
    ...(typeof parsed.primaryExecutionMode === 'string' && parsed.primaryExecutionMode.trim()
      ? { primaryExecutionMode: parsed.primaryExecutionMode.trim() }
      : parsed.primaryExecutionMode === null
        ? { primaryExecutionMode: null }
        : {})
  };
}

export function parseServertoolOutcomePlanInputPayload(raw: string): ServertoolOutcomePlanInputPayload | null {
  const parsed = parseJson('parseServertoolOutcomePlanInputPayload', raw) as
    | {
      toolCalls?: unknown;
      executedToolCalls?: unknown;
      executedFlowIds?: unknown;
      lastExecutionFlowId?: unknown;
    }
    | typeof JSON_PARSE_FAILED;
  if (
    parsed === JSON_PARSE_FAILED ||
    !parsed ||
    !Array.isArray(parsed.toolCalls) ||
    !Array.isArray(parsed.executedToolCalls) ||
    !Array.isArray(parsed.executedFlowIds)
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
  const executedToolCalls = parsed.executedToolCalls
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : '',
      name: typeof entry.name === 'string' ? entry.name : '',
      arguments: typeof entry.arguments === 'string' ? entry.arguments : '',
      executionMode: typeof entry.executionMode === 'string' ? entry.executionMode : '',
      stripAfterExecute: entry.stripAfterExecute !== false
    }))
    .filter((entry) => entry.id && entry.name && entry.executionMode);
  const executedFlowIds = parsed.executedFlowIds
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
  return {
    toolCalls,
    executedToolCalls,
    executedFlowIds,
    ...(typeof parsed.lastExecutionFlowId === 'string' && parsed.lastExecutionFlowId.trim()
      ? { lastExecutionFlowId: parsed.lastExecutionFlowId.trim() }
      : parsed.lastExecutionFlowId === null
        ? { lastExecutionFlowId: null }
        : {}),
  };
}

export function parseServertoolHandlerContractPlanPayload(raw: string): ServertoolHandlerContractPlanPayload | null {
  const parsed = parseJson('parseServertoolHandlerContractPlanPayload', raw) as
    | {
      action?: unknown;
    }
    | typeof JSON_PARSE_FAILED;
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed.action !== 'string') {
    return null;
  }
  const action = parsed.action.trim();
  if (!action) {
    return null;
  }
  return { action };
}

export function parseServertoolResponseStageGatePayload(raw: string): ServertoolResponseStageGatePayload | null {
  const parsed = parseJson('parseServertoolResponseStageGatePayload', raw) as
    | {
      shouldBypass?: unknown;
      nextAction?: unknown;
      responseHookMatched?: unknown;
      responseHookRequired?: unknown;
      responseHookName?: unknown;
      interceptKind?: unknown;
      schemaSource?: unknown;
      skipReason?: unknown;
    }
    | typeof JSON_PARSE_FAILED;
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed.shouldBypass !== 'boolean') {
    return null;
  }
  const nextAction =
    parsed.nextAction === 'bypass' ||
    parsed.nextAction === 'run_auto_hooks' ||
    parsed.nextAction === 'continue_to_execution'
      ? parsed.nextAction
      : parsed.shouldBypass
        ? 'bypass'
        : 'continue_to_execution';
  return {
    shouldBypass: parsed.shouldBypass,
    nextAction,
    responseHookMatched: parsed.responseHookMatched === true,
    responseHookRequired: parsed.responseHookRequired === true,
    ...(typeof parsed.responseHookName === 'string' && parsed.responseHookName.trim()
      ? { responseHookName: parsed.responseHookName.trim() }
      : {}),
    ...(typeof parsed.interceptKind === 'string' && parsed.interceptKind.trim()
      ? { interceptKind: parsed.interceptKind.trim() }
      : {}),
    ...(typeof parsed.schemaSource === 'string' && parsed.schemaSource.trim()
      ? { schemaSource: parsed.schemaSource.trim() }
      : {}),
    ...(typeof parsed.skipReason === 'string' && parsed.skipReason.trim()
      ? { skipReason: parsed.skipReason.trim() }
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
            : 0,
        sourceIndex:
          typeof entry.sourceIndex === 'number' && Number.isInteger(entry.sourceIndex) && entry.sourceIndex >= 0
            ? entry.sourceIndex
            : -1
      }))
      .filter((entry) => entry.id.length > 0 && entry.sourceIndex >= 0);

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
    ...(typeof plan.flowId === 'string' && plan.flowId.trim()
      ? { flowId: plan.flowId.trim() }
      : {}),
    outcomeMode: plan.outcomeMode,
    noFollowup: plan.noFollowup === true,
    autoLimit: plan.autoLimit === true,
    flowOnlyLoopLimit: plan.flowOnlyLoopLimit === true,
    clientInjectOnly: plan.clientInjectOnly === true,
    clearStateOnFollowupFailure: plan.clearStateOnFollowupFailure === true,
    seedLoopPayload: plan.seedLoopPayload === true,
    ignoreRequiresActionFollowup: plan.ignoreRequiresActionFollowup === true,
    ...(typeof plan.clientInjectSource === 'string' && plan.clientInjectSource.trim()
      ? { clientInjectSource: plan.clientInjectSource.trim() }
      : {}),
    ...(typeof plan.transparentReplayRequestSuffix === 'string' && plan.transparentReplayRequestSuffix.trim()
      ? { transparentReplayRequestSuffix: plan.transparentReplayRequestSuffix.trim() }
      : {})
  };
}

export function parseSanitizeMessagesPayload(raw: string): SanitizeMessagesPayload | null {
  const parsed = parseJson('parseSanitizeMessagesPayload', raw);
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed as SanitizeMessagesPayload;
}
