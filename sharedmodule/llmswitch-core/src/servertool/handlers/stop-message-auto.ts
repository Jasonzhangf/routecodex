import type { JsonObject } from '../../conversion/hub/types/json.js';
import type {
  ServerToolHandler,
  ServerToolHandlerContext,
  ServerToolHandlerPlan
} from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { isCompactionRequest } from './compaction-detect.js';
import { extractCapturedChatSeed } from '../followup-seed.js';
import { readRuntimeMetadata } from '../../conversion/runtime-metadata.js';
import { isStopEligibleForServerTool } from '../stop-gateway-context.js';
import { attachStopMessageCompareContext, type StopMessageCompareContext } from '../stop-message-compare-context.js';
import {
  resolveStopMessageDebugEnabled,
  resolveStopMessageDefaultEnabled,
  resolveStopMessageDefaultMaxRepeats,
  resolveStopMessageDefaultText
} from './stop-message-auto/config.js';
import { sanitizeFollowupText } from './followup-sanitize.js';
import {
  getCapturedRequest,
  hasCompactionFlag,
  persistStopMessageState,
  readServerToolFollowupFlowId,
  resolveClientConnectionState,
  resolveDefaultStopMessageSnapshot,
  resolveImplicitGeminiStopMessageSnapshot,
  resolveRuntimeStopMessageState,
  resolveStopMessageSessionScope,
  resolveStickyKey,
  readRuntimeStopMessageStageMode
} from './stop-message-auto/runtime-utils.js';
import { readStoplessGoalState } from './stopless-goal-state.js';
import { loadRoutingInstructionStateSync } from '../../router/virtual-router/sticky-session-store.js';
import {
  applyStopMessageSnapshotToState,
  clearStopMessageState,
  normalizeStopMessageStageMode,
  resolveStopMessageSnapshot
} from './stop-message-auto/routing-state.js';

export { extractBlockedReportFromMessagesForTests } from './stop-message-auto/blocked-report.js';

const STOPMESSAGE_DEBUG = resolveStopMessageDebugEnabled() ?? (process.env.ROUTECODEX_STOPMESSAGE_DEBUG || '').trim() === '1';
const STOPMESSAGE_IMPLICIT_GEMINI = false;
const FLOW_ID = 'stop_message_flow';
const STOP_MESSAGE_EXECUTION_APPEND = '继续执行';

function isPersistentStickyKey(value: unknown): value is string {
  return typeof value === 'string' && (
    value.startsWith('tmux:') || value.startsWith('session:') || value.startsWith('conversation:')
  );
}

function collectPersistedStopMessageCandidateKeys(args: {
  strictSessionScope?: string;
  fallbackStickyKey?: string;
  record: {
    tmuxSessionId?: unknown;
    clientTmuxSessionId?: unknown;
    sessionId?: unknown;
    conversationId?: unknown;
  };
}): string[] {
  const candidateKeys: string[] = [];
  const push = (value: unknown): void => {
    if (!isPersistentStickyKey(value)) {
      return;
    }
    if (!candidateKeys.includes(value)) {
      candidateKeys.push(value);
    }
  };

  const hasDirectTmuxSessionId = typeof args.record.tmuxSessionId === 'string' && args.record.tmuxSessionId.trim();
  const hasDirectClientTmuxSessionId = typeof args.record.clientTmuxSessionId === 'string' && args.record.clientTmuxSessionId.trim();
  const hasDirectSessionId = typeof args.record.sessionId === 'string' && args.record.sessionId.trim();
  const hasDirectConversationId = typeof args.record.conversationId === 'string' && args.record.conversationId.trim();

  if (hasDirectTmuxSessionId) {
    push(`tmux:${String(args.record.tmuxSessionId).trim()}`);
  }
  if (hasDirectClientTmuxSessionId) {
    push(`tmux:${String(args.record.clientTmuxSessionId).trim()}`);
  }
  if (hasDirectSessionId) {
    push(`tmux:${String(args.record.sessionId).trim()}`);
    push(`session:${String(args.record.sessionId).trim()}`);
  }
  if (hasDirectConversationId) {
    push(`conversation:${String(args.record.conversationId).trim()}`);
  }
  if (candidateKeys.length > 0) {
    push(args.strictSessionScope);
    push(args.fallbackStickyKey);
  }

  return candidateKeys;
}

function loadPersistedStopMessageSnapshot(args: {
  strictSessionScope?: string;
  fallbackStickyKey?: string;
  record: {
    tmuxSessionId?: unknown;
    clientTmuxSessionId?: unknown;
    sessionId?: unknown;
    conversationId?: unknown;
  };
}): ReturnType<typeof resolveStopMessageSnapshot> {
  const candidateKeys = collectPersistedStopMessageCandidateKeys(args);
  for (const key of candidateKeys) {
    const snapshot = resolveStopMessageSnapshot(loadRoutingInstructionStateSync(key));
    if (snapshot) {
      return snapshot;
    }
  }
  return null;
}

function loadPersistedStopMessageTombstone(args: {
  strictSessionScope?: string;
  fallbackStickyKey?: string;
  record: {
    tmuxSessionId?: unknown;
    clientTmuxSessionId?: unknown;
    sessionId?: unknown;
    conversationId?: unknown;
  };
}): {
  exhaustedDefault: boolean;
} {
  const candidateKeys = collectPersistedStopMessageCandidateKeys(args);

  for (const key of candidateKeys) {
    const state = loadRoutingInstructionStateSync(key);
    if (!state) {
      continue;
    }
    if (state.stopMessageSource === 'default_exhausted') {
      return { exhaustedDefault: true };
    }
  }
  return { exhaustedDefault: false };
}

function persistSnapshotUsage(args: {
  stickyKey?: string;
  snapshot: {
    text: string;
    maxRepeats: number;
    source?: string;
    stageMode?: 'on' | 'off' | 'auto';
    aiMode?: 'on' | 'off';
  };
  used: number;
  resetLastUsedAt?: boolean;
}): void {
  if (!isPersistentStickyKey(args.stickyKey)) {
    return;
  }
  const now = Date.now();
  const nextState = applyStopMessageSnapshotToState(null, {
    text: args.snapshot.text,
    maxRepeats: args.snapshot.maxRepeats,
    used: args.used,
    source: args.snapshot.source,
    stageMode: args.snapshot.stageMode,
    aiMode: args.snapshot.aiMode ?? 'off',
    updatedAt: now,
    ...(args.resetLastUsedAt ? {} : { lastUsedAt: now })
  });
  persistStopMessageState(args.stickyKey, nextState);
}

function clearPersistedStopMessageSnapshot(args: {
  stickyKey?: string;
  snapshot: {
    text: string;
    maxRepeats: number;
    source?: string;
    stageMode?: 'on' | 'off' | 'auto';
    aiMode?: 'on' | 'off';
  };
}): void {
  if (!isPersistentStickyKey(args.stickyKey)) {
    return;
  }
  const now = Date.now();
  const nextState = applyStopMessageSnapshotToState(null, {
    text: args.snapshot.text,
    maxRepeats: args.snapshot.maxRepeats,
    used: 0,
    source: args.snapshot.source,
    stageMode: args.snapshot.stageMode,
    aiMode: args.snapshot.aiMode ?? 'off',
    updatedAt: now
  });
  clearStopMessageState(nextState, now);
  if (args.snapshot.source === 'default') {
    nextState.stopMessageSource = 'default_exhausted';
  }
  persistStopMessageState(args.stickyKey, nextState);
}

function resolveStopMessageDefaultEnabledLive(): boolean {
  return resolveStopMessageDefaultEnabled() ?? true;
}

function resolveStopMessageDefaultTextLive(): string {
  const fromConfig = resolveStopMessageDefaultText();
  if (typeof fromConfig === 'string' && fromConfig.trim().length > 0) {
    return fromConfig.trim();
  }
  const raw = process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_TEXT;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : '继续执行';
}

function resolveStopMessageDefaultMaxRepeatsLive(): number {
  const fromConfig = resolveStopMessageDefaultMaxRepeats();
  if (Number.isFinite(fromConfig) && Number(fromConfig) > 0) {
    return Math.floor(Number(fromConfig));
  }
  const raw = process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_MAX_REPEATS;
  const parsed = typeof raw === 'string' ? Number(raw.trim()) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 2;
}

function debugLog(message: string, extra?: JsonObject): void {
  if (!STOPMESSAGE_DEBUG) {
    return;
  }
  try {
    // eslint-disable-next-line no-console
    console.log(`\x1b[38;5;33m[stopMessage][debug] ${message}` + (extra ? ` ${JSON.stringify(extra)}` : '') + '\x1b[0m');
  } catch {
    /* ignore logging failures */
  }
}

function emitStopFollowupPinLog(args: {
  adapterContext: unknown;
  pinnedTarget: { providerKey?: string; modelId?: string; routecodexPortMode?: string };
  followupText: string;
}): void {
  try {
    const record =
      args.adapterContext && typeof args.adapterContext === 'object' && !Array.isArray(args.adapterContext)
        ? (args.adapterContext as Record<string, unknown>)
        : {};
    const metadata =
      record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
        ? (record.metadata as Record<string, unknown>)
        : {};
    const runtime = readRuntimeMetadata(record) ?? {};
    const target =
      record.target && typeof record.target === 'object' && !Array.isArray(record.target)
        ? (record.target as Record<string, unknown>)
        : {};
    const runtimeTarget =
      runtime.target && typeof runtime.target === 'object' && !Array.isArray(runtime.target)
        ? (runtime.target as Record<string, unknown>)
        : {};
    const metadataTarget =
      metadata.target && typeof metadata.target === 'object' && !Array.isArray(metadata.target)
        ? (metadata.target as Record<string, unknown>)
        : {};
    console.log('[servertool.followup.pin.stop_handler]', JSON.stringify({
      requestId:
        (typeof record.requestId === 'string' && record.requestId)
        || (typeof runtime.requestId === 'string' && runtime.requestId)
        || (typeof metadata.requestId === 'string' && metadata.requestId)
        || undefined,
      pinnedProviderKey: args.pinnedTarget.providerKey,
      pinnedModelId: args.pinnedTarget.modelId,
      routecodexPortMode: args.pinnedTarget.routecodexPortMode,
      followupText: args.followupText
    }));
  } catch {
    // ignore logging failure
  }
}

function enforceStopMessageExecutionFollowupText(text: string): string {
  const rawBase = sanitizeFollowupText(text);
  return sanitizeFollowupText(rawBase) || STOP_MESSAGE_EXECUTION_APPEND;
}

function readPinnedTargetFromAdapterContext(adapterContext: unknown): {
  providerKey?: string;
  modelId?: string;
  routecodexPortMode?: string;
} {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return {};
  }
  const record = adapterContext as Record<string, unknown>;
  const metadata =
    record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : undefined;
  const runtime = readRuntimeMetadata(record);
  const metadataTarget =
    metadata?.target && typeof metadata.target === 'object' && !Array.isArray(metadata.target)
      ? (metadata.target as Record<string, unknown>)
      : undefined;
  const runtimeTarget =
    runtime?.target && typeof runtime.target === 'object' && !Array.isArray(runtime.target)
      ? (runtime.target as Record<string, unknown>)
      : undefined;
  const target =
    record.target && typeof record.target === 'object' && !Array.isArray(record.target)
      ? (record.target as Record<string, unknown>)
      : undefined;
  const providerKey =
    (typeof record.__shadowCompareForcedProviderKey === 'string' && record.__shadowCompareForcedProviderKey.trim()
      ? record.__shadowCompareForcedProviderKey.trim()
      : '')
    || (typeof runtime?.__shadowCompareForcedProviderKey === 'string' && runtime.__shadowCompareForcedProviderKey.trim()
      ? runtime.__shadowCompareForcedProviderKey.trim()
      : '')
    || (typeof target?.providerKey === 'string' && target.providerKey.trim() ? target.providerKey.trim() : '')
    || (typeof metadataTarget?.providerKey === 'string' && metadataTarget.providerKey.trim() ? metadataTarget.providerKey.trim() : '')
    || (typeof runtimeTarget?.providerKey === 'string' && runtimeTarget.providerKey.trim() ? runtimeTarget.providerKey.trim() : '')
    || (typeof target?.providerId === 'string' && target.providerId.trim() ? target.providerId.trim() : '')
    || (typeof metadataTarget?.providerId === 'string' && metadataTarget.providerId.trim() ? metadataTarget.providerId.trim() : '')
    || (typeof runtimeTarget?.providerId === 'string' && runtimeTarget.providerId.trim() ? runtimeTarget.providerId.trim() : '')
    || (typeof record.targetProviderKey === 'string' && record.targetProviderKey.trim() ? record.targetProviderKey.trim() : '')
    || (typeof metadata?.targetProviderKey === 'string' && metadata.targetProviderKey.trim() ? metadata.targetProviderKey.trim() : '')
    || (typeof runtime?.targetProviderKey === 'string' && runtime.targetProviderKey.trim() ? runtime.targetProviderKey.trim() : '')
    || (typeof record.providerKey === 'string' && record.providerKey.trim() ? record.providerKey.trim() : '')
    || (typeof metadata?.providerKey === 'string' && metadata.providerKey.trim() ? metadata.providerKey.trim() : '')
    || (typeof runtime?.providerKey === 'string' && runtime.providerKey.trim() ? runtime.providerKey.trim() : '')
    || undefined;
  const modelId =
    (typeof target?.modelId === 'string' && target.modelId.trim() ? target.modelId.trim() : '')
    || (typeof metadataTarget?.modelId === 'string' && metadataTarget.modelId.trim() ? metadataTarget.modelId.trim() : '')
    || (typeof runtimeTarget?.modelId === 'string' && runtimeTarget.modelId.trim() ? runtimeTarget.modelId.trim() : '')
    || (typeof record.assignedModelId === 'string' && record.assignedModelId.trim() ? record.assignedModelId.trim() : '')
    || (typeof metadata?.assignedModelId === 'string' && metadata.assignedModelId.trim() ? metadata.assignedModelId.trim() : '')
    || (typeof runtime?.assignedModelId === 'string' && runtime.assignedModelId.trim() ? runtime.assignedModelId.trim() : '')
    || (typeof record.modelId === 'string' && record.modelId.trim() ? record.modelId.trim() : '')
    || (typeof metadata?.modelId === 'string' && metadata.modelId.trim() ? metadata.modelId.trim() : '')
    || (typeof runtime?.modelId === 'string' && runtime.modelId.trim() ? runtime.modelId.trim() : '')
    || (typeof record.originalModelId === 'string' && record.originalModelId.trim() ? record.originalModelId.trim() : '')
    || (typeof metadata?.originalModelId === 'string' && metadata.originalModelId.trim() ? metadata.originalModelId.trim() : '')
    || (typeof runtime?.originalModelId === 'string' && runtime.originalModelId.trim() ? runtime.originalModelId.trim() : '')
    || undefined;
  const routecodexPortMode =
    typeof record.routecodexPortMode === 'string' && record.routecodexPortMode.trim()
      ? record.routecodexPortMode.trim()
      : undefined;
  return {
    ...(providerKey ? { providerKey } : {}),
    ...(modelId ? { modelId } : {}),
    ...(routecodexPortMode ? { routecodexPortMode } : {})
  };
}

function isDirectStoplessGoalStateSnapshot(value: unknown): value is {
  status: string;
  objective: string;
  updatedAt: number;
  createdAt: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.status === 'string' &&
    typeof record.objective === 'string' &&
    typeof record.updatedAt === 'number' &&
    Number.isFinite(record.updatedAt) &&
    typeof record.createdAt === 'number' &&
    Number.isFinite(record.createdAt)
  );
}

function readRequestScopedGoalState(adapterContext: unknown): {
  state?: {
    status: string;
    objective: string;
    updatedAt: number;
    createdAt: number;
  };
  explicit: boolean;
} {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return { explicit: false };
  }
  const record = adapterContext as Record<string, unknown>;
  const directState = isDirectStoplessGoalStateSnapshot(record.stoplessGoalState)
    ? record.stoplessGoalState
    : undefined;
  const rt =
    record.__rt && typeof record.__rt === 'object' && !Array.isArray(record.__rt)
      ? (record.__rt as Record<string, unknown>)
      : undefined;
  const source =
    typeof rt?.stoplessGoalStateSource === 'string'
      ? rt.stoplessGoalStateSource.trim().toLowerCase()
      : '';
  const explicit = Boolean(directState) && source !== 'persisted';
  return {
    ...(directState ? { state: directState } : {}),
    explicit
  };
}

const handler: ServerToolHandler = async (
  ctx: ServerToolHandlerContext
): Promise<ServerToolHandlerPlan | null> => {
  const record = ctx.adapterContext as unknown as {
    clientConnectionState?: unknown;
    sessionId?: unknown;
    providerProtocol?: unknown;
    metadata?: unknown;
  };
  const rt = readRuntimeMetadata(ctx.adapterContext as unknown as Record<string, unknown>);
  const compare: StopMessageCompareContext = {
    armed: false,
    mode: 'off',
    allowModeOnly: false,
    textLength: 0,
    maxRepeats: 0,
    used: 0,
    remaining: 0,
    active: false,
    stopEligible: false,
    hasCapturedRequest: false,
    compactionRequest: false,
    hasSeed: false,
    decision: 'skip',
    reason: 'handler_start'
  };

  const syncCompareRound = (): void => {
    const max = Number.isFinite(compare.maxRepeats) ? Math.max(0, Math.floor(compare.maxRepeats)) : 0;
    const used = Number.isFinite(compare.used) ? Math.max(0, Math.floor(compare.used)) : 0;
    compare.maxRepeats = max;
    compare.used = used;
    compare.remaining = max > 0 ? Math.max(0, max - used) : 0;
    compare.active = compare.armed && compare.mode !== 'off' && max > 0 && compare.textLength > 0;
  };

  const updateCompare = (patch: Partial<StopMessageCompareContext>): void => {
    Object.assign(compare, patch);
    syncCompareRound();
  };

  const markSkip = (reason: string, patch?: Partial<StopMessageCompareContext>): null => {
    updateCompare({ decision: 'skip', reason, ...(patch || {}) });
    return null;
  };

  try {
    const followupFlowId = readServerToolFollowupFlowId(rt);
    if (followupFlowId) {
      debugLog('followup_request_allowed', { followupFlowId } as JsonObject);
      return markSkip('skip_servertool_followup_hop');
    }

    const strictSessionScope = resolveStopMessageSessionScope(record, rt);
    const stickyKey = strictSessionScope || resolveStickyKey(record, rt);
    const persistedStopMessageState = loadPersistedStopMessageSnapshot({
      strictSessionScope,
      fallbackStickyKey: stickyKey,
      record
    });
    const persistedStopMessageTombstone = loadPersistedStopMessageTombstone({
      strictSessionScope,
      fallbackStickyKey: stickyKey,
      record
    });
    const runtimeStopMessageState = resolveRuntimeStopMessageState(rt);
    const requestScopedGoal = readRequestScopedGoalState(ctx.adapterContext);
    const effectiveGoalState = requestScopedGoal.state;
    const hasManagedGoal = Boolean(
      requestScopedGoal.explicit &&
      effectiveGoalState &&
      effectiveGoalState.status !== 'idle'
    );
    let snapshot = persistedStopMessageState ?? runtimeStopMessageState;
    const stickyMode = normalizeStopMessageStageMode(undefined);
    const runtimeMode = readRuntimeStopMessageStageMode(rt);
    const explicitMode = stickyMode ?? runtimeMode;

    if (explicitMode === 'off') {
      return markSkip('skip_stopmessage_mode_off');
    }

    if (!snapshot) {
      if (explicitMode === 'on' || explicitMode === 'auto') {
        return markSkip('skip_explicit_mode_without_snapshot');
      }
      const implicit = STOPMESSAGE_IMPLICIT_GEMINI
        ? resolveImplicitGeminiStopMessageSnapshot(ctx, record)
        : null;
      const shouldUseGoalDefault = hasManagedGoal && effectiveGoalState?.status !== 'active';
      if (shouldUseGoalDefault && persistedStopMessageTombstone.exhaustedDefault) {
        return markSkip('skip_goal_default_exhausted');
      }
      const defaultSnapshot = shouldUseGoalDefault && resolveStopMessageDefaultEnabledLive()
        ? resolveDefaultStopMessageSnapshot(ctx, {
            text: resolveStopMessageDefaultTextLive(),
            maxRepeats: resolveStopMessageDefaultMaxRepeatsLive()
          })
        : null;
      const snapshotCandidate = implicit
        ? {
            text: implicit.text,
            maxRepeats: implicit.maxRepeats,
            used: implicit.used,
            source: implicit.source,
            updatedAt: implicit.updatedAt,
            lastUsedAt: implicit.lastUsedAt,
            stageMode: 'on' as const,
            aiMode: 'off' as const
          }
        : defaultSnapshot
          ? {
              text: defaultSnapshot.text,
              maxRepeats: defaultSnapshot.maxRepeats,
              used: defaultSnapshot.used,
              source: defaultSnapshot.source,
              updatedAt: defaultSnapshot.updatedAt,
              lastUsedAt: defaultSnapshot.lastUsedAt,
              stageMode: 'on' as const,
              aiMode: 'off' as const
            }
          : null;
      snapshot = snapshotCandidate;
      if (!snapshot) {
        return markSkip('skip_no_stopmessage_snapshot');
      }
    }

    const mode = snapshot.stageMode ?? 'on';
    const textRaw = typeof snapshot.text === 'string' ? snapshot.text.trim() : '';
    const text = textRaw;
    const maxRepeats =
      typeof snapshot.maxRepeats === 'number' && Number.isFinite(snapshot.maxRepeats)
        ? Math.max(1, Math.floor(snapshot.maxRepeats))
        : 0;
    const used =
      typeof snapshot.used === 'number' && Number.isFinite(snapshot.used)
        ? Math.max(0, Math.floor(snapshot.used))
        : 0;

    updateCompare({
      armed: true,
      mode,
      allowModeOnly: false,
      textLength: text.length,
      maxRepeats,
      used
    });

    if (mode === 'off') {
      return markSkip('skip_stopmessage_mode_off');
    }
    if (!text.length) {
      return markSkip('skip_stopmessage_empty_text');
    }
    if (!(maxRepeats > 0)) {
      return markSkip('skip_stopmessage_invalid_repeats');
    }

    if (used >= maxRepeats) {
      clearPersistedStopMessageSnapshot({
        stickyKey,
        snapshot: {
          text,
          maxRepeats,
          source: snapshot.source,
          stageMode: mode,
          aiMode: snapshot.aiMode ?? 'off'
        }
      });
      return markSkip('skip_reached_max_repeats');
    }

    const stopEligible = isStopEligibleForServerTool(ctx.base, ctx.adapterContext);
    updateCompare({ stopEligible });
    if (!stopEligible) {
      return markSkip('skip_not_stop_finish_reason');
    }

    if (hasManagedGoal && effectiveGoalState?.status === 'active') {
      return markSkip('skip_goal_active');
    }

    const captured = getCapturedRequest(ctx.adapterContext);
    updateCompare({
      hasCapturedRequest: Boolean(captured),
      compactionRequest: Boolean(captured && isCompactionRequest(captured)),
      hasSeed: Boolean(captured && extractCapturedChatSeed(captured))
    });

    const followupText = enforceStopMessageExecutionFollowupText(STOP_MESSAGE_EXECUTION_APPEND);
    const nextUsed = used + 1;
    if (nextUsed >= maxRepeats) {
      clearPersistedStopMessageSnapshot({
        stickyKey,
        snapshot: {
          text,
          maxRepeats,
          source: snapshot.source,
          stageMode: mode,
          aiMode: snapshot.aiMode ?? 'off'
        }
      });
    } else {
      persistSnapshotUsage({
        stickyKey,
        snapshot: {
          text,
          maxRepeats,
          source: snapshot.source,
          stageMode: mode,
          aiMode: snapshot.aiMode ?? 'off'
        },
        used: nextUsed
      });
    }
    updateCompare({ used: nextUsed, decision: 'trigger', reason: 'triggered' });

    const connectionState = resolveClientConnectionState(record.clientConnectionState);
    const pinnedTarget = readPinnedTargetFromAdapterContext(ctx.adapterContext);
    emitStopFollowupPinLog({
      adapterContext: ctx.adapterContext,
      pinnedTarget,
      followupText
    });
    return {
      flowId: FLOW_ID,
      finalize: async () => ({
        chatResponse: ctx.base,
        execution: {
          flowId: FLOW_ID,
          followup: {
            requestIdSuffix: ':stop_followup',
            injection: {
              ops: [
                { op: 'append_assistant_message', required: false },
                { op: 'append_user_text', text: followupText }
              ]
            },
            metadata: {
              ...(connectionState ? { clientConnectionState: connectionState as JsonObject } : {}),
              ...(pinnedTarget.providerKey ? {
                __shadowCompareForcedProviderKey: pinnedTarget.providerKey,
                providerKey: pinnedTarget.providerKey,
                targetProviderKey: pinnedTarget.providerKey
              } : {}),
              ...(pinnedTarget.modelId ? {
                assignedModelId: pinnedTarget.modelId,
                modelId: pinnedTarget.modelId,
                target: {
                  ...(pinnedTarget.providerKey ? { providerKey: pinnedTarget.providerKey } : {}),
                  modelId: pinnedTarget.modelId
                }
              } : {}),
              ...(pinnedTarget.routecodexPortMode ? { routecodexPortMode: pinnedTarget.routecodexPortMode } : {}),
              clientInjectText: followupText,
              clientInjectSource: 'servertool.stop_message'
            } as JsonObject
          }
        }
      })
    };
  } finally {
    attachStopMessageCompareContext(ctx.adapterContext, compare);
  }
};

registerServerToolHandler('stop_message_auto', handler, { trigger: 'auto', hook: { phase: 'default', priority: 40 } });
