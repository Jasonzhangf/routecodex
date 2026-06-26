// stop-message-auto handler — thin TS shell that orchestrates Rust logic.
//
// All planning logic lives in Rust
// (servertool-core/stop_message_auto_handler.rs + stopless_auto_handler_bridge).
// This file only:
//   1. Reads MetadataCenter runtime_control + previous compare context
//   2. Builds StopMessageAutoHandlerInput
//   3. Calls the Rust plan via NAPI (planStoplessAutoHandlerJson)
//   4. Applies the Rust-built metadata center write plan via the new
//      `applyStoplessMetadataCenterWritePlan` helper (replaces inline Reflect.set
//      calls against Symbol.for('routecodex.metadataCenter'))
//   5. Triggers learned-note file writes via the Rust NAPI function
//   6. Dispatches the plan action (return_null / terminal / handler plan / throw)
//
// Feature: hub.servertool_stopless_cli_continuation

import type { ServerToolHandler, ServerToolHandlerResult } from '../types.js';
import type { JsonObject } from '../../conversion/hub/types/json.js';
import {
  type StopMessageDecision,
  type StopMessageDecisionContext
} from '../../native/router-hotpath/native-stop-message-auto-semantics.js';
import {
  extractCurrentAssistantStopTextWithNative,
  extractStopMessageAutoCliResultSnapshotFromRequestWithNative,
  normalizeStoplessTriggerHintForMetadataWithNative
} from '../../native/router-hotpath/native-servertool-core-semantics.js';
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
  type StoplessRuntimeControlValue
} from '../stopless-metadata-carrier.js';
import {
  applyStoplessMetadataCenterWritePlan,
  buildStoplessMetadataCenterWritePlan
} from '../stopless-metadata-center-writer.js';
import {
  writeRuntimeControlToBoundMetadataCenter,
} from '../stopless-metadata-carrier.js';
import { readNativeFunction } from '../../native/router-hotpath/native-shared-conversion-semantics-core.js';
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

// ── Handler plan shape (from Rust) ─────────────────────────────────────────

type HandlerPlan = {
  action:
    | 'return_null'
    | 'return_terminal_final'
    | 'throw_stopless_loop'
  | 'return_schema_fail_fast'
  | 'return_schema_allow_stop'
  | 'return_handler_plan';
  compareContext: Record<string, unknown>;
  terminalChatResponse?: Record<string, unknown>;
  shouldWriteLearnedNote?: boolean;
  learnedNote?: Record<string, unknown>;
  stoplessLoopErrorMessage?: string;
  stoplessLoopErrorCode?: string;
  stoplessLoopRepeatCount?: number;
  stoplessLoopThreshold?: number;
  stoplessLoopGoalContextCount?: number;
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

/**
 * Read the Rust-built MetadataCenter snapshot (from `metadataCenterSnapshot` carrier).
 * This is the JSON shape the Rust side uses for strongly-typed reads.
 */
function readMetadataCenterSnapshot(record: Record<string, unknown>): Record<string, unknown> {
  const direct = record.metadataCenterSnapshot;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  const nested = (record.metadata as Record<string, unknown> | undefined)?.metadataCenterSnapshot;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return {};
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
      })()
    // If the loop state has not been seeded yet, default to (used=1, maxRepeats=3)
    // so the Rust handler treats the request as the first continuation round.
    ?? { continuationPrompt: '', repeatCount: 1, maxRepeats: 3, active: true };

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
  const handlerInput: Record<string, unknown> = {
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

  // 5. Hand off to Rust plan (NAPI direct call, no TS round-trip)
  const plan = await planStoplessAutoHandlerNapi({
    ...handlerInput,
    decision,
    assistantStopText: extractCurrentAssistantStopTextWithNative(ctx.base)
  });

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

// ── Rust NAPI direct call (replaces planStopMessageAutoHandlerWithNative) ──

async function planStoplessAutoHandlerNapi(input: Record<string, unknown>): Promise<HandlerPlan> {
  const fn = readNativeFunction('planStoplessAutoHandlerJson');
  if (!fn) {
    throw new Error('planStoplessAutoHandlerJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planStoplessAutoHandlerJson native returned non-string: ${typeof resultJson}`);
  }
  return JSON.parse(resultJson) as HandlerPlan;
}

// ── Plan dispatch (lightweight — writes via Rust-built plan) ───────────────

type ServerToolExecution = ServerToolHandlerResult['execution'];

function dispatchPlan(
  plan: HandlerPlan,
  ctx: { base: JsonObject; requestId: string; adapterContext: unknown },
  record: Record<string, unknown>,
): null | { flowId: string; finalize: () => Promise<ServerToolHandlerResult> } {
  switch (plan.action) {
    case 'return_null':
      return null;

    case 'return_terminal_final':
    case 'return_schema_fail_fast':
    case 'return_schema_allow_stop': {
      if (plan.shouldWriteLearnedNote && plan.learnedNote) {
        const parsed = (plan.learnedNote.parsed as Record<string, unknown> | undefined) ?? plan.learnedNote;
        // Rust writes the file via NAPI; replaces TS writeStoplessLearnedNoteEntry
        const fn = readNativeFunction('writeStoplessLearnedNoteJson');
        if (fn) {
          fn(JSON.stringify({
            adapterContext: record,
            requestId: ctx.requestId,
            parsed,
            timestampMs: Date.now()
          }));
        }
      }
      const chatResponse = (plan.terminalChatResponse ?? ctx.base) as JsonObject;
      return {
        flowId: FLOW_ID,
        finalize: async (): Promise<ServerToolHandlerResult> => ({
          chatResponse,
          execution: {
            flowId: FLOW_ID,
            context: { stopMessageTerminalFinal: true }
          }
        })
      };
    }

    case 'throw_stopless_loop': {
      const msg = plan.stoplessLoopErrorMessage ?? '[servertool] stopless stop loop detected';
      const err: Error & {
        code?: string;
        status?: number;
        repeatCount?: number;
        threshold?: number;
        goalContextCount?: number;
      } = Object.assign(new Error(msg), {
        code: plan.stoplessLoopErrorCode ?? 'STOPLESS_STOP_LOOP_DETECTED',
        status: 500,
        repeatCount: plan.stoplessLoopRepeatCount,
        threshold: plan.stoplessLoopThreshold,
        goalContextCount: plan.stoplessLoopGoalContextCount
      });
      throw err;
    }

    case 'return_handler_plan': {
      const persistPlan = plan.persistPlan ?? { nextUsed: 0, nextMaxRepeats: 0 };
      const effectiveDecision = plan.effectiveDecision ?? {};
      const stoplessTriggerHint = plan.stoplessTriggerHint;
      const schemaFeedback = plan.schemaFeedback;

      return {
        flowId: FLOW_ID,
        finalize: async (): Promise<ServerToolHandlerResult> => {
          // Apply the Rust-built write plan. The center snapshot is read
          // from either the adapter root or the nested metadata bag.
          const centerSnapshot = readMetadataCenterSnapshot(record);
          const writePlan = buildStoplessMetadataCenterWritePlan({
            handlerPlan: plan as Record<string, unknown>,
            center: centerSnapshot,
            requestId: ctx.requestId,
            timestampMs: Date.now()
          });
          if (writePlan) {
            applyStoplessMetadataCenterWritePlan({
              adapterContext: record,
              plan: writePlan,
              reason: 'stopless-runtime-state'
            });
          }

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

// ── Stopless loop guard re-export for tests ─────────────────────────────────

export async function evaluateStoplessLoopGuard(args: {
  capturedRequest: Record<string, unknown>;
  assistantText: string;
  threshold: number;
}) {
  const { evaluateStoplessLoopGuardWithNative } = await import(
    '../../native/router-hotpath/native-stop-message-auto-semantics.js'
  );
  return evaluateStoplessLoopGuardWithNative(args);
}
