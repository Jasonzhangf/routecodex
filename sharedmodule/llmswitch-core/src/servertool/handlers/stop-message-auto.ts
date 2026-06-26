// stop-message-auto handler — TS thin shell.
//
// All orchestration logic lives in Rust
// (servertool-core/stop_message_auto_handler.rs). This file only:
//   - Reads MetadataCenter runtime_control + previous compare context
//   - Builds StopMessageAutoHandlerInput
//   - Calls planStopMessageAutoHandlerWithNative
//   - Dispatches the plan action (null / terminal / handler plan / goal-loop throw)
//   - Writes back MetadataCenter runtime_control.stopless + compare context
//   - Writes stopless learned note entries
//
// Feature: hub.servertool_stopless_cli_continuation

import type { ServerToolHandler, ServerToolHandlerResult } from '../types.js';
import type { JsonObject } from '../../conversion/hub/types/json.js';
import {
  evaluateGoalActiveStopLoopGuardWithNative,
  type StopMessageDecision,
  type StopMessageDecisionContext
} from '../../native/router-hotpath/native-stop-message-auto-semantics.js';
import {
  extractCurrentAssistantStopTextWithNative,
  extractStopMessageAutoCliResultSnapshotFromRequestWithNative,
  normalizeStoplessTriggerHintForMetadataWithNative,
  planStoplessLearnedNoteWriteWithNative
} from '../../native/router-hotpath/native-servertool-core-semantics.js';
import { writeStoplessLearnedNoteEntry } from './memory/cache-writer.js';
import { resolveStopMessageDebugEnabled } from './stop-message-auto/config.js';
import {
  getCapturedRequest,
  planStoplessDecisionContextSignals,
  planStopMessageDefaultConfig,
  resolveAdapterContextProviderKey,
  resolveRuntimeStopMessageStateFromAdapterContext
} from './stop-message-auto/runtime-utils.js';
import { attachStopMessageCompareContext, readStopMessageCompareContext, type StopMessageCompareContext } from '../stop-message-compare-context.js';
import {
  readRuntimeControlFromBoundMetadataCenter,
  writeRuntimeControlToBoundMetadataCenter,
  writeStoplessRuntimeControlToBoundMetadataCenter,
  type StoplessRuntimeControlValue
} from '../stopless-metadata-carrier.js';
import { shouldBypassStopMessageForMediaContext, shouldRunVisionFlowForAdapterContext } from './vision-eligibility.js';

export { extractBlockedReportFromMessagesForTests } from './stop-message-auto/blocked-report.js';

// ── Test hook ───────────────────────────────────────────────────────────────

let decideOverride: ((ctx: StopMessageDecisionContext) => StopMessageDecision) | null = null;

export function __setDecideOverrideForTests(
  fn: ((ctx: StopMessageDecisionContext) => StopMessageDecision) | null
): void {
  decideOverride = fn;
}

async function decideStopMessageAction(ctx: StopMessageDecisionContext): Promise<StopMessageDecision> {
  if (decideOverride) {
    return decideOverride(ctx);
  }
  const { decideStopMessageActionWithNative: nativeFn } = await import(
    '../../native/router-hotpath/native-stop-message-auto-semantics.js'
  );
  return nativeFn(ctx);
}

// ── Public re-exports (legacy API surface preserved) ────────────────────────

export function normalizeStoplessTriggerHintForMetadata(triggerHint: unknown): string | undefined {
  return typeof triggerHint === 'string' && triggerHint.trim()
    ? normalizeStoplessTriggerHintForMetadataWithNative(triggerHint)
    : undefined;
}

// ── Native plan input/plan types (mirrored from Rust) ───────────────────────

type HandlerPlanInput = Record<string, unknown>;

type HandlerPlan = {
  action:
    | 'return_null'
    | 'return_terminal_final'
    | 'throw_goal_active_loop'
    | 'return_schema_fail_fast'
    | 'return_schema_allow_stop'
    | 'return_handler_plan';
  compareContext: Record<string, unknown>;
  terminalChatResponse?: Record<string, unknown>;
  shouldWriteLearnedNote?: boolean;
  learnedNote?: Record<string, unknown>;
  goalLoopErrorMessage?: string;
  goalLoopErrorCode?: string;
  goalLoopRepeatCount?: number;
  goalLoopThreshold?: number;
  goalLoopGoalContextCount?: number;
  flowId?: string;
  effectiveDecision?: Record<string, unknown>;
  persistPlan?: { nextUsed: number; nextMaxRepeats: number };
  stoplessTriggerHint?: string;
  schemaFeedback?: { reasonCode: string; missingFields: string[] };
  assistantStopText?: string;
  nativeHandlerResult?: { followup?: unknown; chatResponse?: unknown };
} & Record<string, unknown>;

// ── Main handler ────────────────────────────────────────────────────────────

const FLOW_ID = 'stop_message_flow';
const STOPMESSAGE_DEBUG =
  resolveStopMessageDebugEnabled() ?? (process.env.ROUTECODEX_STOPMESSAGE_DEBUG || '').trim() === '1';

function debugLog(message: string, extra?: unknown): void {
  if (!STOPMESSAGE_DEBUG) return;
  try {
    // eslint-disable-next-line no-console
    console.log(
      `\x1b[38;5;33m[stopMessage][debug] ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}\x1b[0m`
    );
  } catch {
    /* ignore */
  }
}

export const stopMessageAutoServerToolHandler: ServerToolHandler = async (ctx) => {
  const record = ctx.adapterContext as Record<string, unknown>;
  const base = ctx.base as Record<string, unknown>;

  // 1. Read MetadataCenter IO + resolve effective loop state
  const runtimeControl = readRuntimeControlFromBoundMetadataCenter(record);
  const previousCompare = readStopMessageCompareContext(ctx.adapterContext);
  const captured = getCapturedRequest(ctx.adapterContext);
  const metadataCenterStoplessState =
    runtimeControl?.stopless && typeof runtimeControl.stopless === 'object' && !Array.isArray(runtimeControl.stopless)
      ? runtimeControl.stopless as Partial<StoplessRuntimeControlValue>
      : undefined;
  const cliLoopState = extractStopMessageAutoCliResultSnapshotFromRequestWithNative({
    adapterContext: record
  });
  const effectiveRuntimeLoopState =
    (cliLoopState && typeof cliLoopState.repeatCount === 'number' ? cliLoopState : undefined)
    ?? metadataCenterStoplessState
    ?? (() => {
        const legacy = resolveRuntimeStopMessageStateFromAdapterContext(ctx.adapterContext);
        return legacy
          ? {
              continuationPrompt: legacy.text,
              repeatCount: legacy.used,
              maxRepeats: legacy.maxRepeats,
              active: true
            }
          : undefined;
      })();

  // 2. Resolve signals + default config
  const decisionSignalsRaw = planStoplessDecisionContextSignals({
    adapterContext: ctx.adapterContext,
    capturedRequest: captured
  }) as unknown as Record<string, unknown>;
  const decisionSignals = {
    portStopMessageDisabled: Boolean(decisionSignalsRaw.portStopMessageDisabled),
    hasResponsesSubmitToolOutputsResume: Boolean(decisionSignalsRaw.hasResponsesSubmitToolOutputsResume),
    planModeActive: Boolean(decisionSignalsRaw.planModeActive)
  };
  const defaultConfig = planStopMessageDefaultConfig({
    envText: process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_TEXT,
    envMaxRepeats: process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_MAX_REPEATS
  });

  // 3. Build Rust handler plan input
  const handlerInput: HandlerPlanInput = {
    adapterContext: record,
    base,
    requestId: ctx.requestId,
    followupFlowId: runtimeControl?.serverToolFollowup === true ? '__servertool_followup__' : '',
    shouldRunVisionFlow: shouldRunVisionFlowForAdapterContext(ctx.adapterContext),
    shouldBypassStopMessageForMedia: shouldBypassStopMessageForMediaContext(ctx.adapterContext),
    metadataRuntimeControl: runtimeControl as Record<string, unknown> | undefined,
    metadataPreviousCompare: previousCompare as unknown as Record<string, unknown> | undefined,
    defaultConfig,
    decisionSignals: {
      portStopMessageDisabled: decisionSignals.portStopMessageDisabled,
      hasResponsesSubmitToolOutputsResume: decisionSignals.hasResponsesSubmitToolOutputsResume,
      planModeActive: decisionSignals.planModeActive
    } as unknown as Record<string, unknown>,
    capturedRequest: (captured ?? undefined) as Record<string, unknown> | undefined,
    effectiveRuntimeLoopState: (effectiveRuntimeLoopState ?? undefined) as Record<string, unknown> | undefined,
    providerKey: resolveAdapterContextProviderKey(ctx.adapterContext) ?? undefined
  };

  // 4. Decide (TS owns the override hook; calls Rust core)
  const ds = handlerInput.decisionSignals as unknown as Record<string, unknown>;
  const decisionCtx: StopMessageDecisionContext = {
    port_stop_message_disabled: Boolean(ds.portStopMessageDisabled),
    followup_flow_id: (handlerInput.followupFlowId || undefined) as string | undefined,
    stop_eligible: true,
    has_responses_submit_tool_outputs_resume: Boolean(ds.hasResponsesSubmitToolOutputsResume),
    persisted_snapshot: undefined,
    runtime_snapshot: handlerInput.effectiveRuntimeLoopState
      ? {
          text: typeof (handlerInput.effectiveRuntimeLoopState as Record<string, unknown>).continuationPrompt === 'string'
            ? (handlerInput.effectiveRuntimeLoopState as Record<string, unknown>).continuationPrompt as string
            : '',
          max_repeats: typeof (handlerInput.effectiveRuntimeLoopState as Record<string, unknown>).maxRepeats === 'number'
            ? (handlerInput.effectiveRuntimeLoopState as Record<string, unknown>).maxRepeats as number
            : 0,
          used: typeof (handlerInput.effectiveRuntimeLoopState as Record<string, unknown>).repeatCount === 'number'
            ? (handlerInput.effectiveRuntimeLoopState as Record<string, unknown>).repeatCount as number
            : 0,
          source: 'default',
          stage_mode: 'on'
        }
      : undefined,
    persisted_default_exhausted: false,
    explicit_mode: metadataCenterStoplessState?.active === true ? 'on' : undefined,
    plan_mode_active: Boolean(ds.planModeActive),
    default_enabled: defaultConfig.enabled,
    default_max_repeats: defaultConfig.maxRepeats,
    default_text: defaultConfig.text,
    provider_pin: handlerInput.providerKey ? { provider_key: String(handlerInput.providerKey) } : undefined
  };
  const decision = await decideStopMessageAction(decisionCtx);

  // 5. Hand off to Rust plan: build plan input with the decided action
  const planInput = {
    ...handlerInput,
    decision,
    assistantStopText: extractCurrentAssistantStopTextWithNative(ctx.base)
  };
  const plan = await planStopMessageAutoHandler(planInput as Record<string, unknown>);

  // 6. Dispatch plan
  try {
    return dispatchPlan(plan, ctx, record);
  } finally {
    attachStopMessageCompareContext(
            ctx.adapterContext,
            plan.compareContext as unknown as StopMessageCompareContext
          );
    debugLog('stop_message_auto compare_context', plan.compareContext);
  }
};

// ── Plan dispatch ───────────────────────────────────────────────────────────

async function planStopMessageAutoHandler(input: Record<string, unknown>): Promise<HandlerPlan> {
  const { planStopMessageAutoHandlerWithNative } = await import(
    '../../native/router-hotpath/native-servertool-core-semantics.js'
  );
  return planStopMessageAutoHandlerWithNative<HandlerPlan>(input);
}

type ServerToolHandlerResultLike = ServerToolHandlerResult;
type ServerToolExecution = ServerToolHandlerResult['execution'];

type StopMessageHandlerFinalize = () => Promise<ServerToolHandlerResultLike>;

function dispatchPlan(
  plan: HandlerPlan,
  ctx: { base: JsonObject; requestId: string; adapterContext: unknown },
  record: Record<string, unknown>,
): null | { flowId: string; finalize: StopMessageHandlerFinalize } {
  switch (plan.action) {
    case 'return_null':
      return null;

    case 'return_terminal_final':
    case 'return_schema_fail_fast':
    case 'return_schema_allow_stop': {
      // Optional learned note write
      if (plan.shouldWriteLearnedNote && plan.learnedNote) {
        const ln = planStoplessLearnedNoteWriteWithNative({
          adapterContext: record,
          requestId: ctx.requestId,
          parsed: (plan.learnedNote.parsed as Record<string, unknown> | undefined) ?? plan.learnedNote,
          timestampMs: Date.now()
        });
        if (ln.shouldWrite) {
          writeStoplessLearnedNoteEntry({
            workingDirectory: ln.workingDirectory,
            requestId: ln.requestId,
            sessionId: ln.sessionId,
            timestampMs: ln.timestampMs,
            learned: ln.learned,
            reason: ln.reason,
            evidence: ln.evidence
          });
        }
      }
      const chatResponse = (plan.terminalChatResponse ?? ctx.base) as JsonObject;
      return {
        flowId: FLOW_ID,
        finalize: async (): Promise<ServerToolHandlerResultLike> => ({
          chatResponse,
          execution: {
            flowId: FLOW_ID,
            context: { stopMessageTerminalFinal: true }
          }
        })
      };
    }

    case 'throw_goal_active_loop': {
      const msg = plan.goalLoopErrorMessage ?? '[servertool] goal active stop loop detected';
      const err: Error & {
        code?: string;
        status?: number;
        repeatCount?: number;
        threshold?: number;
        goalContextCount?: number;
      } = Object.assign(new Error(msg), {
        code: plan.goalLoopErrorCode ?? 'GOAL_ACTIVE_STOP_LOOP_DETECTED',
        status: 500,
        repeatCount: plan.goalLoopRepeatCount,
        threshold: plan.goalLoopThreshold,
        goalContextCount: plan.goalLoopGoalContextCount
      });
      throw err;
    }

    case 'return_handler_plan': {
      const persistPlan = plan.persistPlan ?? { nextUsed: 0, nextMaxRepeats: 0 };
      const effectiveDecision = plan.effectiveDecision ?? {};
      const handlerResult = plan.nativeHandlerResult ?? {};
      const stoplessTriggerHint = plan.stoplessTriggerHint;
      const schemaFeedback = plan.schemaFeedback;

      return {
        flowId: FLOW_ID,
        finalize: async (): Promise<ServerToolHandlerResultLike> => {
          // Write stopless runtime control
          writeStoplessRuntimeControlToBoundMetadataCenter({
            metadata: record,
            value: {
              flowId: FLOW_ID,
              repeatCount: persistPlan.nextUsed,
              maxRepeats: persistPlan.nextMaxRepeats,
              ...(stoplessTriggerHint ? { triggerHint: stoplessTriggerHint } : {}),
              ...(typeof effectiveDecision.followup_text === 'string'
                ? { continuationPrompt: effectiveDecision.followup_text }
                : {}),
              ...(schemaFeedback ? { schemaFeedback } : {}),
              active: true,
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
          // Compare context writeback is in finally block above; this is the per-turn write
          writeRuntimeControlToBoundMetadataCenter({
            metadata: record,
            key: 'stopMessageCompareContext',
            value: plan.compareContext,
            writer: {
              module: 'sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts',
              symbol: 'stopMessageAutoServerToolHandler',
              stage: 'stop_message_auto_runtime_control_writer'
            },
            reason: 'stop-message-compare-context',
            required: true
          });

          const execution: ServerToolExecution = {
            flowId: FLOW_ID,
            context: {
              decision: effectiveDecision as unknown as JsonObject,
              assistantStopText: plan.assistantStopText ?? '',
              ...(stoplessTriggerHint ? { stopSchemaTriggerHint: stoplessTriggerHint } : {}),
              ...(schemaFeedback ? { stopSchemaFeedback: schemaFeedback } : {}),
              stopless: {
                flowId: FLOW_ID,
                repeatCount: persistPlan.nextUsed,
                maxRepeats: persistPlan.nextMaxRepeats,
                ...(stoplessTriggerHint ? { triggerHint: stoplessTriggerHint } : {}),
                ...(schemaFeedback ? { schemaFeedback } : {})
              }
            }
          };
          return {
            chatResponse: ctx.base,
            execution
          };
        }
      };
    }

    default:
      return null;
  }
}

// ── Goal loop guard re-export for tests ─────────────────────────────────────

export async function evaluateGoalActiveStopLoopGuard(args: {
  capturedRequest: Record<string, unknown>;
  assistantText: string;
  threshold: number;
}) {
  return evaluateGoalActiveStopLoopGuardWithNative(args);
}