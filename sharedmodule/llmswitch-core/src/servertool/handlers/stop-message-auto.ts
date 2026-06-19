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
import { attachStopMessageCompareContext, readStopMessageCompareContext, type StopMessageCompareContext } from '../stop-message-compare-context.js';
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
  readServerToolFollowupFlowId,
  resolveClientConnectionState,
  resolveDefaultStopMessageSnapshot,
  resolveImplicitGeminiStopMessageSnapshot,
  resolveRuntimeStopMessageStateFromAdapterContext,
  planStopMessageDefaultConfig,
  planStopMessagePersistSnapshot,
  planStoplessDecisionContextGoalStatus,
  planStoplessDecisionContextSignals,
  readRuntimeStopMessageStageMode,
  resolveAdapterContextProviderKey,
} from './stop-message-auto/runtime-utils.js';
import { readStoplessGoalState } from './stopless-goal-state.js';
import type {
  StopMessageDecisionContext,
  StopMessageDecision
} from '../../native/router-hotpath/native-stop-message-auto-semantics.js';
import {
  evaluateGoalActiveStopLoopGuardWithNative,
  evaluateStopSchemaGateWithNative,
  runStopMessageAutoHandlerWithNative
} from '../../native/router-hotpath/native-stop-message-auto-semantics.js';
import { writeStoplessLearnedNoteEntry } from './memory/cache-writer.js';
import {
  buildStopMessageTerminalVisiblePayloadWithNative,
  extractCurrentAssistantStopTextWithNative,
  planStoplessLearnedNoteWriteWithNative
} from '../../native/router-hotpath/native-servertool-core-semantics.js';
import {
  readRuntimeControlFromBoundMetadataCenter,
  writeRuntimeControlToBoundMetadataCenter,
  writeStoplessRuntimeControlToBoundMetadataCenter
} from '../stopless-metadata-carrier.js';

export { extractBlockedReportFromMessagesForTests } from './stop-message-auto/blocked-report.js';

const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');

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

function buildStopSchemaFeedback(args: {
  schemaGate: { reason_code?: string; missing_fields?: string[] };
}): JsonObject | undefined {
  const reasonCode = typeof args.schemaGate.reason_code === 'string'
    ? args.schemaGate.reason_code.trim()
    : '';
  if (!reasonCode) {
    return undefined;
  }
  const missingFields = Array.isArray(args.schemaGate.missing_fields)
    ? [...args.schemaGate.missing_fields]
      .map((value) => String(value).trim())
      .filter(Boolean)
    : [];
  return {
    reasonCode,
    missingFields
  };
}

function writeStoplessLearnedNoteFromRustPlan(args: {
  adapterContext: Record<string, unknown>;
  requestId: string;
  parsed?: Record<string, unknown>;
}): void {
  const plan = planStoplessLearnedNoteWriteWithNative({
    adapterContext: args.adapterContext,
    requestId: args.requestId,
    parsed: args.parsed,
    timestampMs: Date.now()
  });
  if (!plan.shouldWrite) {
    return;
  }
  writeStoplessLearnedNoteEntry({
    workingDirectory: plan.workingDirectory,
    requestId: plan.requestId,
    sessionId: plan.sessionId,
    timestampMs: plan.timestampMs,
    learned: plan.learned,
    reason: plan.reason,
    evidence: plan.evidence
  });
}

function attachStopMessageRuntimeStateToMetadata(metadata: Record<string, unknown>, state: {
  text: string;
  providerKey?: string;
  maxRepeats: number;
  used: number;
  stageMode: string;
}): void {
  const writer = {
    module: 'sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts',
    symbol: 'attachStopMessageRuntimeStateToMetadata',
    stage: 'stop_message_auto_runtime_control_writer'
  };
  writeRuntimeControlToBoundMetadataCenter({
    metadata,
    key: 'stopMessageState',
    value: {
      stopMessageText: state.text,
      ...(state.providerKey ? { stopMessageProviderKey: state.providerKey } : {}),
      stopMessageMaxRepeats: state.maxRepeats,
      stopMessageUsed: state.used,
      stopMessageStageMode: state.stageMode
    },
    writer,
    reason: 'stop-message-runtime-state',
    required: true
  });
  writeRuntimeControlToBoundMetadataCenter({
    metadata,
    key: 'serverToolLoopState',
    value: {
      flowId: FLOW_ID,
      repeatCount: state.used,
      maxRepeats: state.maxRepeats
    },
    writer,
    reason: 'stop-message-loop-state',
    required: true
  });
}

function attachStoplessRuntimeControlToMetadata(metadata: Record<string, unknown>, args: {
  sessionId?: string;
  flowId: string;
  repeatCount: number;
  maxRepeats: number;
  triggerHint?: string;
  continuationPrompt?: string;
  schemaFeedback?: JsonObject;
  active: boolean;
}): void {
  writeStoplessRuntimeControlToBoundMetadataCenter({
    metadata,
    value: {
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      flowId: args.flowId,
      repeatCount: args.repeatCount,
      maxRepeats: args.maxRepeats,
      ...(args.triggerHint ? { triggerHint: args.triggerHint } : {}),
      ...(args.continuationPrompt ? { continuationPrompt: args.continuationPrompt } : {}),
      ...(args.schemaFeedback ? { schemaFeedback: args.schemaFeedback } : {}),
      active: args.active,
      updatedAt: Date.now()
    },
    writer: {
      module: 'sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts',
      symbol: 'attachStoplessRuntimeControlToMetadata',
      stage: 'stop_message_auto_runtime_control_writer'
    },
    reason: 'stopless-runtime-state',
    required: true
  });
}

function bindMetadataCenterFromRecordToMetadata(
  record: Record<string, unknown>,
  metadata: Record<string, unknown>
): void {
  if (Reflect.has(metadata, METADATA_CENTER_SYMBOL)) {
    return;
  }
  const center = Reflect.get(record, METADATA_CENTER_SYMBOL);
  if (center) {
    Reflect.set(metadata, METADATA_CENTER_SYMBOL, center);
  }
}

function attachStopMessageRuntimeStateToFollowup(followup: unknown, state: {
  text: string;
  providerKey?: string;
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
  const runtimeControl = readRuntimeControlFromBoundMetadataCenter(record);
  const previousCompare = readStopMessageCompareContext(ctx.adapterContext);

  // ── Build native decision context ──
  const runtimeLoopState =
    runtimeControl?.serverToolLoopState && typeof runtimeControl.serverToolLoopState === 'object' && !Array.isArray(runtimeControl.serverToolLoopState)
      ? runtimeControl.serverToolLoopState as Record<string, unknown>
      : undefined;
  const followupFlowId = readServerToolFollowupFlowId(runtimeLoopState)
    || (runtimeControl?.serverToolFollowup === true ? '__servertool_followup__' : '');
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
  const runtimeSnap = resolveRuntimeStopMessageStateFromAdapterContext(ctx.adapterContext);
  const persistedGoalRead = readStoplessGoalState(ctx.adapterContext);
  const goalStatusPlan = planStoplessDecisionContextGoalStatus({
    adapterContext: ctx.adapterContext,
    persistedGoalState: persistedGoalRead.state
  });
  const tombstone = { exhaustedDefault: false, cleared: false };
  const explicitMode = readRuntimeStopMessageStageMode(rt);
  const stopGateway = resolveStopGatewayContext(ctx.base, ctx.adapterContext);
  const captured = getCapturedRequest(ctx.adapterContext);
  const decisionSignals = planStoplessDecisionContextSignals({
    adapterContext: ctx.adapterContext,
    runtimeMetadata: rt,
    capturedRequest: captured
  });
  const defaultConfig = planStopMessageDefaultConfig({
    tombstoneCleared: tombstone.cleared,
    configEnabled: resolveStopMessageDefaultEnabled(),
    configText: resolveStopMessageDefaultText(),
    configMaxRepeats: resolveStopMessageDefaultMaxRepeats(),
    envText: process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_TEXT,
    envMaxRepeats: process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_MAX_REPEATS
  });
  const assistantStopText = extractCurrentAssistantStopTextWithNative(ctx.base);
  const goalLoopContext = captured
    ? await evaluateGoalActiveStopLoopGuard({
        capturedRequest: captured as Record<string, unknown>,
        assistantText: assistantStopText,
        threshold: 3
      })
    : undefined;
  const currentProviderKey = resolveAdapterContextProviderKey(ctx.adapterContext);

  const decisionCtx: StopMessageDecisionContext = {
    port_stop_message_disabled: decisionSignals.portStopMessageDisabled,
    followup_flow_id: followupFlowId || undefined,
    stop_eligible: stopGateway.eligible,
    has_responses_submit_tool_outputs_resume: decisionSignals.hasResponsesSubmitToolOutputsResume,
    persisted_snapshot: undefined,
    runtime_snapshot: runtimeSnap ? {
      text: runtimeSnap.text,
      ...(runtimeSnap.providerKey ? { provider_key: runtimeSnap.providerKey } : {}),
      max_repeats: runtimeSnap.maxRepeats,
      used: runtimeSnap.used,
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
    goal_status: goalStatusPlan.goalStatus as any,
    plan_mode_active: decisionSignals.planModeActive,
    default_enabled: defaultConfig.enabled,
    default_max_repeats: defaultConfig.maxRepeats,
    default_text: defaultConfig.text,
    provider_pin: currentProviderKey
      ? { provider_key: currentProviderKey }
      : undefined,
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
      compare.reason = 'stop_schema_budget_exhausted';
      return buildStopSchemaFinalPlan(prefixed);
    }
    if (decision.action !== 'trigger') {
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

    // Rust owns no_change_count + observation_hash + fail_fast detection.
    // TS only forwards prev state from compare context and writes back Rust-returned values.
    const prevObservationHash = typeof previousCompare?.observationHash === 'string'
      ? previousCompare.observationHash.trim()
      : '';
    const prevNoChangeCount = typeof previousCompare?.observationStableCount === 'number'
      ? Math.max(0, Math.floor(previousCompare.observationStableCount))
      : 0;
    const schemaGate = evaluateStopSchemaGateWithNative({
      assistantText: extractCurrentAssistantStopTextWithNative(ctx.base),
      used: decision.used,
      maxRepeats: decision.max_repeats,
      prevObservationHash,
      prevNoChangeCount
    });
    const schemaUsedBeforeCount = decision.used;
    compare.reason = schemaGate.reason_code || compare.reason;
    compare.observationHash = typeof schemaGate.observation_hash === 'string' ? schemaGate.observation_hash : '';
    compare.observationStableCount = typeof schemaGate.no_change_count === 'number' ? schemaGate.no_change_count : 0;
    if (schemaGate.action === 'fail_fast') {
      const prefixed = applyStopSummaryPrefix(ctx.base, '');
      return buildStopSchemaFinalPlan(prefixed);
    }

    if (schemaGate.action === 'allow_stop') {
      const prefixed = schemaGate.reason_code === 'stop_schema_needs_user_input'
        ? replaceStopSummaryContent(ctx.base, schemaGate.summary_prefix)
        : applyStopSummaryPrefix(ctx.base, schemaGate.summary_prefix);
      writeStoplessLearnedNoteFromRustPlan({
        adapterContext: ctx.adapterContext as unknown as Record<string, unknown>,
        requestId: ctx.requestId,
        parsed: schemaGate.parsed
      });
      return buildStopSchemaFinalPlan(prefixed);
    }

    const effectiveDecision = schemaGate.followup_text
      ? { ...decision, used: schemaUsedBeforeCount, followup_text: schemaGate.followup_text, followupText: schemaGate.followup_text, stopSchemaTriggerHint: schemaGate.reason_code }
      : { ...decision, stopSchemaTriggerHint: schemaGate.reason_code };

    // ── Call native handler result assembler ──
    const handlerResult = runStopMessageAutoHandlerWithNative({
      decision: effectiveDecision as any,
      adapterContext: record,
      base: { ...ctx.base } as Record<string, unknown>,
      candidateKeys: [],
      stickyKey: undefined,
      strictSessionScope: undefined,
      followupFlowId: followupFlowId || undefined,
    });

    const usedAt = Date.now();
    const stateUpdate = handlerResult.stateUpdate || {};
    const schemaFeedback = buildStopSchemaFeedback({ schemaGate });
    const persistPlan = planStopMessagePersistSnapshot({
      schemaGate,
      decision,
      stateUpdate,
      defaultText: defaultConfig.text,
      schemaUsedBeforeCount,
      currentProviderKey
    });
    compare.maxRepeats = persistPlan.compareMaxRepeats;
    compare.remaining = persistPlan.compareRemaining;
    const snapInput = {
      text: persistPlan.snapshot.text,
      ...(persistPlan.snapshot.providerKey ? { providerKey: persistPlan.snapshot.providerKey } : {}),
      maxRepeats: persistPlan.snapshot.maxRepeats,
      used: persistPlan.snapshot.used,
      source: persistPlan.snapshot.source,
      stageMode: persistPlan.snapshot.stageMode as any,
      aiMode: persistPlan.snapshot.aiMode,
      updatedAt: usedAt,
      lastUsedAt: usedAt
    };
    attachStopMessageRuntimeStateToFollowup(handlerResult.followup, snapInput);

    return {
      flowId: FLOW_ID,
      finalize: async () => {
        const metadata =
          record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
            ? record.metadata as Record<string, unknown>
            : {};
        if (metadata !== record.metadata) {
          record.metadata = metadata;
        }
        bindMetadataCenterFromRecordToMetadata(record, metadata);
        attachStoplessRuntimeControlToMetadata(metadata, {
          sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
          flowId: FLOW_ID,
          repeatCount: persistPlan.nextUsed,
          maxRepeats: persistPlan.nextMaxRepeats,
          ...(schemaGate.reason_code ? { triggerHint: schemaGate.reason_code } : {}),
          ...(typeof effectiveDecision.followup_text === 'string' ? { continuationPrompt: effectiveDecision.followup_text } : {}),
          ...(schemaFeedback ? { schemaFeedback } : {}),
          active: true
        });
        return {
          chatResponse: ctx.base,
          execution: {
            flowId: FLOW_ID,
            followup: handlerResult.followup as unknown as ServerToolFollowupPlan,
          context: {
            decision: effectiveDecision as unknown as JsonObject,
            assistantStopText,
            stopSchemaTriggerHint: schemaGate.reason_code,
            ...(schemaFeedback ? { stopSchemaFeedback: schemaFeedback } : {}),
            serverToolLoopState: {
              flowId: FLOW_ID,
              repeatCount: persistPlan.nextUsed,
              maxRepeats: persistPlan.nextMaxRepeats,
              triggerHint: schemaGate.reason_code,
              ...(schemaFeedback ? { schemaFeedback } : {})
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
