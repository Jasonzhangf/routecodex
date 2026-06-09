import type { JsonObject } from '../../conversion/hub/types/json.js';
import type {
  ServerToolHandler,
  ServerToolHandlerContext,
  ServerToolHandlerPlan
} from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import type { ServerToolFollowupPlan } from '../types.js';
import { isCompactionRequest } from '../../conversion/compaction-detect.js';
import {
  shouldBypassStopMessageForMediaContext,
  shouldRunVisionFlowForAdapterContext
} from './vision-eligibility.js';
import { extractCapturedChatSeed } from '../backend-route-seed.js';
import { readRuntimeMetadata } from '../../conversion/runtime-metadata.js';
import { isStopEligibleForServerTool, resolveStopGatewayContext } from '../stop-gateway-context.js';
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
  resolveRuntimeStopMessageStateFromAdapterContext,
  planStoplessDecisionContextSignals,
  planStopMessagePersistedLookup,
  planStopMessagePersistedStateSelection,
  readRuntimeStopMessageStageMode
} from './stop-message-auto/runtime-utils.js';
import { readStoplessGoalState } from './stopless-goal-state.js';
import { loadRoutingInstructionStateSync } from '../../native/router-hotpath/native-virtual-router-routing-state.js';
import type {
  StopMessageDecisionContext,
  StopMessageDecision
} from '../../native/router-hotpath/native-stop-message-auto-semantics.js';
import {
  evaluateGoalActiveStopLoopGuardWithNative,
  evaluateStopSchemaGateWithNative,
  runStopMessageAutoHandlerWithNative
} from '../../native/router-hotpath/native-stop-message-auto-semantics.js';
import {
  applyStopMessageSnapshotToState,
  clearStopMessageState
} from './stop-message-auto/routing-state.js';
import {
  resolveWorkingDirectoryFromAdapterContext,
  writeStoplessLearnedNoteEntry
} from './memory/cache-writer.js';
import {
  buildStopMessageTerminalVisiblePayloadWithNative,
  extractCurrentAssistantStopTextWithNative
} from '../../native/router-hotpath/native-servertool-core-semantics.js';

export { extractBlockedReportFromMessagesForTests } from './stop-message-auto/blocked-report.js';

/** Pluggable decision function — default calls native, overridable for tests. */
let decideOverride: ((ctx: StopMessageDecisionContext) => StopMessageDecision) | null = null;

export function __setDecideOverrideForTests(
  fn: ((ctx: StopMessageDecisionContext) => StopMessageDecision) | null
): void {
  decideOverride = fn;
}

async function decideStopMessageAction(
  ctx: StopMessageDecisionContext
): Promise<StopMessageDecision> {
  if (decideOverride) {
    return decideOverride(ctx);
  }
  const { decideStopMessageActionWithNative: nativeFn } = await import(
    '../../native/router-hotpath/native-stop-message-auto-semantics.js'
  );
  return nativeFn(ctx);
}

async function evaluateGoalActiveStopLoopGuard(args: {
  capturedRequest: Record<string, unknown>;
  assistantText: string;
  threshold?: number;
}) {
  return evaluateGoalActiveStopLoopGuardWithNative(args);
}

const STOPMESSAGE_DEBUG = resolveStopMessageDebugEnabled() ?? (process.env.ROUTECODEX_STOPMESSAGE_DEBUG || '').trim() === '1';
const STOPMESSAGE_IMPLICIT_GEMINI = false;
const FLOW_ID = 'stop_message_flow';
const STOP_SCHEMA_CONSECUTIVE_STOP_MAX_REPEATS = 3;
const STOP_MESSAGE_EXECUTION_APPEND = '继续完成当前用户目标。若仍需操作、检查或验证，必须调用可用工具继续执行；不要只总结、道歉、复述状态或输出计划。只有目标已经完成时，才输出最终简短结果。';

function applyStopSummaryPrefix(payload: JsonObject, prefix: unknown): JsonObject {
  return buildStopMessageTerminalVisiblePayloadWithNative({
    payload,
    mode: 'prefix',
    prefix: typeof prefix === 'string' ? prefix : null
  }) as JsonObject;
}

function replaceStopSummaryContent(payload: JsonObject, prefix: unknown): JsonObject {
  return buildStopMessageTerminalVisiblePayloadWithNative({
    payload,
    mode: 'replace',
    prefix: typeof prefix === 'string' ? prefix : null
  }) as JsonObject;
}

function stripTerminalStopVisiblePayload(payload: JsonObject): JsonObject {
  return buildStopMessageTerminalVisiblePayloadWithNative({
    payload,
    mode: 'strip',
    prefix: null
  }) as JsonObject;
}

function buildStopSchemaFinalPlan(chatResponse: JsonObject): ServerToolHandlerPlan {
  const visibleChatResponse = stripTerminalStopVisiblePayload(chatResponse);
  return {
    flowId: FLOW_ID,
    finalize: async () => ({
      chatResponse: visibleChatResponse,
      execution: {
        flowId: FLOW_ID,
        context: {
          stopMessageTerminalFinal: true
        }
      }
    })
  };
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function persistStoplessLearnedNoteOnAllowStop(args: {
  adapterContext: Record<string, unknown>;
  requestId: string;
  parsed?: Record<string, unknown>;
}): void {
  const learned = readNonEmptyString(args.parsed?.learned);
  if (!learned) {
    return;
  }
  writeStoplessLearnedNoteEntry({
    workingDirectory: resolveWorkingDirectoryFromAdapterContext(args.adapterContext),
    requestId: args.requestId,
    sessionId: readNonEmptyString(args.adapterContext.sessionId),
    timestampMs: Date.now(),
    learned,
    reason: readNonEmptyString(args.parsed?.reason),
    evidence: readNonEmptyString(args.parsed?.evidence)
  });
}

function attachStopMessageRuntimeStateToMetadata(metadata: Record<string, unknown>, state: {
  text: string;
  maxRepeats: number;
  used: number;
  stageMode: string;
}): void {
  const rt = metadata.__rt && typeof metadata.__rt === 'object' && !Array.isArray(metadata.__rt)
    ? metadata.__rt as Record<string, unknown>
    : {};
  rt.stopMessageState = {
    stopMessageText: state.text,
    stopMessageMaxRepeats: state.maxRepeats,
    stopMessageUsed: state.used,
    stopMessageStageMode: state.stageMode
  };
  const loopState = rt.serverToolLoopState && typeof rt.serverToolLoopState === 'object' && !Array.isArray(rt.serverToolLoopState)
    ? { ...(rt.serverToolLoopState as Record<string, unknown>) }
    : {};
  rt.serverToolLoopState = {
    ...loopState,
    flowId: FLOW_ID,
    repeatCount: state.used,
    maxRepeats: state.maxRepeats
  };
  metadata.__rt = rt;
}

function attachStopMessageRuntimeStateToFollowup(followup: unknown, state: {
  text: string;
  maxRepeats: number;
  used: number;
  stageMode: string;
}): void {
  const row = followup && typeof followup === 'object' && !Array.isArray(followup)
    ? followup as Record<string, unknown>
    : null;
  if (!row) return;
  const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown>
    : {};
  attachStopMessageRuntimeStateToMetadata(metadata, state);
  row.metadata = metadata;
}

function clearPersistedStopMessageRuntimeState(keys: string[]): void {
  for (const key of keys) {
    if (!isPersistentStickyKey(key)) continue;
    const persistedState = loadRoutingInstructionStateSync(key) ?? null;
    if (!persistedState) continue;
    clearStopMessageState(persistedState, Date.now());
    persistStopMessageState(key, persistedState);
  }
}

function resetPersistedStopMessageUsed(keys: string[]): void {
  const now = Date.now();
  for (const key of keys) {
    if (!isPersistentStickyKey(key)) continue;
    const persistedState = loadRoutingInstructionStateSync(key) ?? null;
    if (!persistedState) continue;
    if (persistedState.stopMessageUsed !== undefined || persistedState.stopMessageLastUsedAt !== undefined) {
      persistedState.stopMessageUsed = 0;
      persistedState.stopMessageLastUsedAt = undefined;
      persistedState.stopMessageUpdatedAt = now;
      persistStopMessageState(key, persistedState);
    }
  }
}

function handlerResultPersistKeys(candidateKeys: string[], stickyKey?: string, strictSessionScope?: string): string[] {
  const out: string[] = [];
  for (const key of [stickyKey, strictSessionScope, ...candidateKeys]) {
    if (!isPersistentStickyKey(key)) continue;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

function isPersistentStickyKey(value: unknown): value is string {
  return typeof value === 'string' && (
    value.startsWith('tmux:') || value.startsWith('session:') || value.startsWith('conversation:')
  );
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
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : STOP_MESSAGE_EXECUTION_APPEND;
}

function resolveStopMessageDefaultMaxRepeatsLive(): number {
  const fromConfig = resolveStopMessageDefaultMaxRepeats();
  if (Number.isFinite(fromConfig) && Number(fromConfig) > 0) {
    return Math.floor(Number(fromConfig));
  }
  const raw = process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_MAX_REPEATS;
  const parsed = typeof raw === 'string' ? Number(raw.trim()) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 3;
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
  if (
    shouldRunVisionFlowForAdapterContext(ctx.adapterContext) ||
    shouldBypassStopMessageForMediaContext(ctx.adapterContext)
  ) {
    return null;
  }
  const record = ctx.adapterContext as unknown as Record<string, unknown>;
  const rt = readRuntimeMetadata(ctx.adapterContext as unknown as Record<string, unknown>) ?? {};

  // ── Build native decision context ──
  const followupFlowId = readServerToolFollowupFlowId(rt)
    || (rt.serverToolFollowup === true ? '__servertool_followup__' : '');
  if (followupFlowId && followupFlowId !== FLOW_ID) {
    const stopGateway = resolveStopGatewayContext(ctx.base, ctx.adapterContext);
    attachStopMessageCompareContext(ctx.adapterContext, {
      armed: false,
      mode: 'off',
      allowModeOnly: false,
      textLength: 0,
      maxRepeats: 0,
      used: 0,
      remaining: 0,
      active: false,
      stopEligible: stopGateway.eligible,
      hasCapturedRequest: Boolean(getCapturedRequest(ctx.adapterContext)),
      compactionRequest: false,
      hasSeed: false,
      decision: 'skip',
      reason: 'skip_servertool_followup_hop',
    });
    return null;
  }
  const persistedLookupPlan = planStopMessagePersistedLookup(record, rt, {
    includeSnapshotLookup: true,
    includeTombstoneLookup: true
  });
  const candidateKeys = persistedLookupPlan.candidateKeys;
  const persistedStateSelection = planStopMessagePersistedStateSelection(candidateKeys);
  const persistedSnap = persistedLookupPlan.readStopMessageSnapshot
    ? persistedStateSelection.snapshot ?? null
    : null;
  const runtimeSnap = resolveRuntimeStopMessageStateFromAdapterContext(ctx.adapterContext);
  const requestScopedGoal = readRequestScopedGoalState(ctx.adapterContext);
  const persistedGoalRead = readStoplessGoalState(ctx.adapterContext);
  const effectiveGoal = requestScopedGoal.state ?? persistedGoalRead.state;
  const hasExplicitGoalState = requestScopedGoal.explicit;
  const tombstone = persistedLookupPlan.readStopMessageTombstone
    ? persistedStateSelection.tombstone
    : { exhaustedDefault: false, cleared: false };
  const explicitMode = (
    tombstone.cleared
      ? undefined
      : (readRuntimeStopMessageStageMode(rt)
        ?? persistedStateSelection.stageMode)
  );
  const stopGateway = resolveStopGatewayContext(ctx.base, ctx.adapterContext);
  const captured = getCapturedRequest(ctx.adapterContext);
  const decisionSignals = planStoplessDecisionContextSignals({
    adapterContext: ctx.adapterContext,
    runtimeMetadata: rt,
    capturedRequest: captured
  });
  const assistantStopText = extractCurrentAssistantStopTextWithNative(ctx.base);
  const goalLoopContext = captured
    ? await evaluateGoalActiveStopLoopGuard({
        capturedRequest: captured as Record<string, unknown>,
        assistantText: assistantStopText,
        threshold: 3
      })
    : undefined;

  const decisionCtx: StopMessageDecisionContext = {
    port_stop_message_disabled: decisionSignals.portStopMessageDisabled,
    followup_flow_id: followupFlowId || undefined,
    stop_eligible: stopGateway.eligible,
    has_responses_submit_tool_outputs_resume: decisionSignals.hasResponsesSubmitToolOutputsResume,
    persisted_snapshot: persistedSnap ? {
      text: String(persistedSnap.text ?? ''),
      max_repeats: typeof persistedSnap.maxRepeats === 'number' ? Math.max(0, Math.floor(persistedSnap.maxRepeats)) : 0,
      used: typeof persistedSnap.used === 'number' ? Math.max(0, Math.floor(persistedSnap.used)) : 0,
      source: (persistedSnap.source === 'default' ? 'default' : 'persisted') as any,
      stage_mode: (persistedSnap.stageMode ?? 'on') as any,
    } : undefined,
    runtime_snapshot: runtimeSnap ? {
      text: String(runtimeSnap.text ?? ''),
      max_repeats: typeof runtimeSnap.maxRepeats === 'number' ? Math.max(0, Math.floor(runtimeSnap.maxRepeats)) : 0,
      used: typeof runtimeSnap.used === 'number' ? Math.max(0, Math.floor(runtimeSnap.used)) : 0,
      source: 'default' as any,
      stage_mode: 'on' as any,
    } : undefined,
    persisted_default_exhausted: tombstone.exhaustedDefault,
    explicit_mode: explicitMode === 'on'
      ? 'on' as any
      : explicitMode === 'auto'
        ? 'auto' as any
        : explicitMode === 'off'
          ? 'off' as any
          : undefined,
    goal_status: hasExplicitGoalState && effectiveGoal?.status === 'active'
      ? 'active' as any
      : (!effectiveGoal || effectiveGoal.status === 'idle' || effectiveGoal.status === 'active'
        ? 'idle' as any
        : effectiveGoal.status as any),
    plan_mode_active: decisionSignals.planModeActive,
    default_enabled: tombstone.cleared ? false : resolveStopMessageDefaultEnabledLive(),
    default_max_repeats: resolveStopMessageDefaultMaxRepeatsLive(),
    default_text: resolveStopMessageDefaultTextLive(),
    provider_pin: undefined,
  };

  // ── Call decision (native by default, overridable for tests) ──
  const decision = await decideStopMessageAction(decisionCtx);

  // ── Build compare context ──
  const compare: StopMessageCompareContext = {
    armed: decision.action === 'trigger',
    mode: decision.action === 'trigger' ? 'on' : 'off',
    allowModeOnly: false,
    textLength: decision.followup_text?.length ?? 0,
    maxRepeats: decision.max_repeats,
    used: decision.used,
    remaining: decision.max_repeats > decision.used ? decision.max_repeats - decision.used : 0,
    active: decision.action === 'trigger',
    stopEligible: stopGateway.eligible,
    hasCapturedRequest: Boolean(captured),
    compactionRequest: Boolean(captured && isCompactionRequest(captured)),
    hasSeed: Boolean(captured && extractCapturedChatSeed(captured)),
    decision: decision.action === 'trigger' ? 'trigger' : 'skip',
    reason: decision.skip_reason ?? 'native_decision',
  };

  try {
    if (decision.action !== 'trigger' && decision.skip_reason === 'skip_reached_max_repeats') {
      const prefixed = applyStopSummaryPrefix(ctx.base, '');
      clearPersistedStopMessageRuntimeState(handlerResultPersistKeys(candidateKeys, persistedLookupPlan.stickyKey || undefined, persistedLookupPlan.strictSessionScope || undefined));
      compare.reason = 'stop_schema_budget_exhausted';
      return buildStopSchemaFinalPlan(prefixed);
    }
    if (decision.action !== 'trigger') {
      if (!stopGateway.eligible) {
        resetPersistedStopMessageUsed(handlerResultPersistKeys(candidateKeys, persistedLookupPlan.stickyKey || undefined, persistedLookupPlan.strictSessionScope || undefined));
      }
      if (decision.skip_reason === 'skip_no_stopmessage_snapshot' || decision.skip_reason === 'skip_goal_active') {
        const assistantText = assistantStopText;
        if (assistantText && captured) {
          const goalLoop = goalLoopContext ?? await evaluateGoalActiveStopLoopGuard({
            capturedRequest: captured as Record<string, unknown>,
            assistantText,
            threshold: 3
          });
          if (goalLoop.loopDetected) {
            compare.reason = goalLoop.reasonCode || 'goal_active_repeated_stop';
            throw Object.assign(
              new Error(
                `[servertool] goal active stop loop detected: repeat=${goalLoop.repeatCount}/${goalLoop.threshold}; ` +
                `assistant repeatedly stopped without tool progress: ${assistantText.slice(0, 160)}`
              ),
              {
                code: 'GOAL_ACTIVE_STOP_LOOP_DETECTED',
                status: 500,
                repeatCount: goalLoop.repeatCount,
                threshold: goalLoop.threshold,
                goalContextCount: goalLoop.goalContextCount
              }
            );
          }
        }
      }
      return null;
    }

    let schemaGate = evaluateStopSchemaGateWithNative({
      assistantText: extractCurrentAssistantStopTextWithNative(ctx.base),
      used: decision.used,
      maxRepeats: decision.max_repeats
    });
    const schemaUsedBeforeCount = decision.used;
    compare.reason = schemaGate.reason_code || compare.reason;
    if (schemaGate.action === 'fail_fast') {
      const prefixed = applyStopSummaryPrefix(ctx.base, '');
      clearPersistedStopMessageRuntimeState(handlerResultPersistKeys(candidateKeys, persistedLookupPlan.stickyKey || undefined, persistedLookupPlan.strictSessionScope || undefined));
      return buildStopSchemaFinalPlan(prefixed);
    }

    if (schemaGate.action === 'allow_stop') {
      const prefixed = schemaGate.reason_code === 'stop_schema_needs_user_input'
        ? replaceStopSummaryContent(ctx.base, schemaGate.summary_prefix)
        : applyStopSummaryPrefix(ctx.base, schemaGate.summary_prefix);
      persistStoplessLearnedNoteOnAllowStop({
        adapterContext: ctx.adapterContext as unknown as Record<string, unknown>,
        requestId: ctx.requestId,
        parsed: schemaGate.parsed
      });
      clearPersistedStopMessageRuntimeState(handlerResultPersistKeys(candidateKeys, persistedLookupPlan.stickyKey || undefined, persistedLookupPlan.strictSessionScope || undefined));
      return buildStopSchemaFinalPlan(prefixed);
    }

    const effectiveDecision = schemaGate.followup_text
      ? { ...decision, used: schemaUsedBeforeCount, followup_text: schemaGate.followup_text, followupText: schemaGate.followup_text }
      : decision;

    // ── Call native handler result assembler ──
    const stickyKey = persistedLookupPlan.stickyKey || undefined;
    const strictSessionScope = persistedLookupPlan.strictSessionScope || undefined;
    const handlerResult = runStopMessageAutoHandlerWithNative({
      decision: effectiveDecision as any,
      adapterContext: record,
      base: { ...ctx.base } as Record<string, unknown>,
      candidateKeys,
      stickyKey,
      strictSessionScope,
      followupFlowId: followupFlowId || undefined,
    });

    // ── Execute persist I/O (TS writes state files) ──
    const usedAt = Date.now();
    const stateUpdate = handlerResult.stateUpdate || {};
    const shouldCountBudget = schemaGate.count_budget !== false;
    // The schema gate in Rust already enforces the per-path budget
    // (3 rounds for provided schema, 10 rounds for missing schema) via
    // `stop_schema_*_max_repeats`. The TS side must mirror that decision
    // so the persisted `stopMessageMaxRepeats` reflects the *actual* cap
    // the gate used, not a separate hard-coded constant. The gate's
    // `max_repeats` is the source of truth — fall back to the snapshot's
    // `decision.max_repeats` only if the gate didn't report one (e.g.
    // allow_stop path).
    const gateMaxRepeats = typeof schemaGate.max_repeats === 'number' && Number.isFinite(schemaGate.max_repeats)
      ? Math.floor(schemaGate.max_repeats)
      : 0;
    const resolvedMaxRepeats = gateMaxRepeats > 0
      ? gateMaxRepeats
      : (typeof decision.max_repeats === 'number' && Number.isFinite(decision.max_repeats)
          ? Math.floor(decision.max_repeats)
          : 0);
    const schemaBudgetMaxRepeats = Math.max(1, resolvedMaxRepeats);
    // The compare context captures the *actual* gate cap so logs and
    // samples show the real remaining budget (10 for missing schema,
    // 3 for provided schema) instead of the snapshot's prior round value.
    compare.maxRepeats = schemaBudgetMaxRepeats;
    compare.remaining = schemaBudgetMaxRepeats > decision.used
      ? schemaBudgetMaxRepeats - decision.used
      : 0;
    const nextMaxRepeats = shouldCountBudget
      ? schemaBudgetMaxRepeats
      : decision.max_repeats;
    const nextUsed = shouldCountBudget
      ? (typeof stateUpdate.used === 'number' ? stateUpdate.used : schemaUsedBeforeCount + 1)
      : decision.used;
    const snapInput = {
      text: String(stateUpdate.text ?? STOP_MESSAGE_EXECUTION_APPEND),
      maxRepeats: nextMaxRepeats,
      used: nextUsed,
      source: typeof stateUpdate.source === 'string' ? stateUpdate.source : 'default',
      stageMode: typeof stateUpdate.stageMode === 'string' ? stateUpdate.stageMode as any : 'on' as any,
      aiMode: 'off' as any,
      updatedAt: usedAt,
      lastUsedAt: usedAt
    };
    attachStopMessageRuntimeStateToFollowup(handlerResult.followup, snapInput);
    for (const key of handlerResult.persistKeys) {
      const persistedState = loadRoutingInstructionStateSync(key) ?? null;
      const nextState = applyStopMessageSnapshotToState(persistedState, snapInput);
      persistStopMessageState(key, nextState);
    }

    return {
      flowId: FLOW_ID,
      finalize: async () => {
        return {
          chatResponse: ctx.base,
          execution: {
            flowId: FLOW_ID,
            ...(stickyKey ? { stopMessageReservation: { stickyKey, previousState: null } } : {}),
            followup: handlerResult.followup as unknown as ServerToolFollowupPlan,
            context: {
              decision: effectiveDecision as unknown as JsonObject,
              assistantStopText,
              serverToolLoopState: {
                flowId: FLOW_ID,
                repeatCount: nextUsed,
                maxRepeats: nextMaxRepeats
              }
            }
          }
        };
      }
    };
  } finally {
    attachStopMessageCompareContext(ctx.adapterContext, compare);
  }
};

registerServerToolHandler('stop_message_auto', handler, { trigger: 'auto', hook: { phase: 'default', priority: 40 } });
