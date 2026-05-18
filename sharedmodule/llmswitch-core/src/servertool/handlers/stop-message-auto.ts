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
import { loadRoutingInstructionStateSync } from '../../router/virtual-router/sticky-session-store.js';
import { readStoplessGoalState } from './stopless-goal-state.js';
import {
  applyStopMessageSnapshotToState,
  createStopMessageState,
  normalizeStopMessageStageMode,
  resolveStopMessageSnapshot
} from './stop-message-auto/routing-state.js';

export { extractBlockedReportFromMessagesForTests } from './stop-message-auto/blocked-report.js';

const STOPMESSAGE_DEBUG = resolveStopMessageDebugEnabled() ?? (process.env.ROUTECODEX_STOPMESSAGE_DEBUG || '').trim() === '1';
const STOPMESSAGE_IMPLICIT_GEMINI = false;
const STOPMESSAGE_DEFAULT_ENABLED = resolveStopMessageDefaultEnabled() ?? true;
const STOPMESSAGE_DEFAULT_TEXT = (() => {
  const fromConfig = resolveStopMessageDefaultText();
  if (typeof fromConfig === 'string' && fromConfig.trim().length > 0) {
    return fromConfig.trim();
  }
  const raw = process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_TEXT;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : '继续执行';
})();
const STOPMESSAGE_DEFAULT_MAX_REPEATS = (() => {
  const fromConfig = resolveStopMessageDefaultMaxRepeats();
  if (Number.isFinite(fromConfig) && Number(fromConfig) > 0) {
    return Math.floor(Number(fromConfig));
  }
  const raw = process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_MAX_REPEATS;
  const parsed = typeof raw === 'string' ? Number(raw.trim()) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 2;
})();
const FLOW_ID = 'stop_message_flow';
const STOP_MESSAGE_EXECUTION_APPEND = '继续执行';

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

function enforceStopMessageExecutionFollowupText(text: string): string {
  const rawBase = sanitizeFollowupText(text);
  return sanitizeFollowupText(rawBase) || STOP_MESSAGE_EXECUTION_APPEND;
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
    }

    const strictSessionScope = resolveStopMessageSessionScope(record, rt);
    const stickyKey = strictSessionScope || resolveStickyKey(record, rt);
    let stickyState = stickyKey ? loadRoutingInstructionStateSync(stickyKey) : null;
    const runtimeStopMessageState = resolveRuntimeStopMessageState(rt);
    let snapshot = resolveStopMessageSnapshot(stickyState) ?? runtimeStopMessageState;
    const stickyMode = normalizeStopMessageStageMode(stickyState?.stopMessageStageMode);
    const runtimeMode = readRuntimeStopMessageStageMode(rt);
    const explicitMode = stickyMode ?? runtimeMode;

    if (!snapshot) {
      const implicit = STOPMESSAGE_IMPLICIT_GEMINI
        ? resolveImplicitGeminiStopMessageSnapshot(ctx, record)
        : null;
      const defaultSnapshot = STOPMESSAGE_DEFAULT_ENABLED
        ? resolveDefaultStopMessageSnapshot(ctx, {
            text: STOPMESSAGE_DEFAULT_TEXT,
            maxRepeats: STOPMESSAGE_DEFAULT_MAX_REPEATS
          })
        : null;
      const fallback = implicit
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
      snapshot = fallback ?? {
        text: STOPMESSAGE_DEFAULT_TEXT,
        maxRepeats: STOPMESSAGE_DEFAULT_MAX_REPEATS,
        used: 0,
        source: 'default',
        updatedAt: Date.now(),
        stageMode: 'on' as const,
        aiMode: 'off' as const
      };
      if (stickyKey) {
        stickyState = applyStopMessageSnapshotToState(stickyState, snapshot);
        persistStopMessageState(stickyKey, stickyState);
      }
    } else if (!stickyState && stickyKey && snapshot) {
      stickyState = applyStopMessageSnapshotToState(stickyState, snapshot);
      persistStopMessageState(stickyKey, stickyState);
    }

    const mode = snapshot.stageMode ?? 'on';
    const textRaw = typeof snapshot.text === 'string' ? snapshot.text.trim() : '';
    const text = textRaw || STOP_MESSAGE_EXECUTION_APPEND;
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

    if (used >= maxRepeats) {
      if (stickyKey) {
        const resetState =
          stickyState ??
          createStopMessageState({
            text,
            maxRepeats,
            used,
            ...(snapshot.source ? { source: snapshot.source } : {}),
            ...(snapshot.updatedAt ? { updatedAt: snapshot.updatedAt } : {}),
            ...(snapshot.lastUsedAt ? { lastUsedAt: snapshot.lastUsedAt } : {}),
            ...(snapshot.stageMode ? { stageMode: snapshot.stageMode } : {}),
            aiMode: 'off'
          });
        resetState.stopMessageText = text;
        resetState.stopMessageMaxRepeats = maxRepeats;
        resetState.stopMessageUsed = 0;
        resetState.stopMessageStageMode = mode;
        resetState.stopMessageAiMode = 'off';
        resetState.stopMessageAiSeedPrompt = undefined;
        resetState.stopMessageAiHistory = undefined;
        persistStopMessageState(stickyKey, resetState);
      }
      return markSkip('skip_reached_max_repeats');
    }

    const stopEligible = isStopEligibleForServerTool(ctx.base, ctx.adapterContext);
    updateCompare({ stopEligible });
    if (!stopEligible) {
      return markSkip('skip_not_stop_finish_reason');
    }

    const effectiveGoalState = stickyState?.stoplessGoalState ?? readStoplessGoalState(ctx.adapterContext).state;
    const hasManagedGoal = Boolean(effectiveGoalState && effectiveGoalState.status !== 'idle');
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
    updateCompare({ used: nextUsed, decision: 'trigger', reason: 'triggered' });

    if (stickyKey) {
      const nextState =
        stickyState ??
        createStopMessageState({
          text,
          maxRepeats,
          used,
          ...(snapshot.source ? { source: snapshot.source } : {}),
          ...(snapshot.updatedAt ? { updatedAt: snapshot.updatedAt } : {}),
          ...(snapshot.lastUsedAt ? { lastUsedAt: snapshot.lastUsedAt } : {}),
          ...(snapshot.stageMode ? { stageMode: snapshot.stageMode } : {}),
          aiMode: 'off'
        });
      const now = Date.now();
      nextState.stopMessageText = text;
      nextState.stopMessageMaxRepeats = maxRepeats;
      nextState.stopMessageUsed = Math.min(nextUsed, maxRepeats);
      nextState.stopMessageStageMode = mode;
      nextState.stopMessageAiMode = 'off';
      nextState.stopMessageLastUsedAt = now;
      nextState.stopMessageAiSeedPrompt = undefined;
      nextState.stopMessageAiHistory = undefined;
      persistStopMessageState(stickyKey, nextState);
    }

    const connectionState = resolveClientConnectionState(record.clientConnectionState);
    return {
      flowId: FLOW_ID,
      finalize: async () => ({
        chatResponse: ctx.base,
        execution: {
          flowId: FLOW_ID,
          ...(stickyKey
            ? {
                stopMessageReservation: {
                  stickyKey,
                  previousState: stickyState
                    ? (JSON.parse(JSON.stringify(stickyState)) as Record<string, unknown>)
                    : null
                }
              }
            : {}),
          followup: {
            requestIdSuffix: ':stop_followup',
            metadata: {
              ...(connectionState ? { clientConnectionState: connectionState as JsonObject } : {}),
              clientInjectOnly: true,
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
