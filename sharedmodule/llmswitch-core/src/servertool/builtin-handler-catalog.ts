import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ServerToolHandlerContext, ServerToolHandlerResult } from './types.js';
import type { ServerToolHandlerEntry } from './registry-types.js';
import type { ServerToolHandlerRegistrationSpec } from './skeleton-config.js';
import { getServertoolToolSpec, listServertoolToolSpecs } from './skeleton-config.js';
import { readRuntimeControlFromBoundMetadataCenter, writeRuntimeControlToBoundMetadataCenter } from './stopless-metadata-carrier.js';
import { readStopMessageCompareContext, attachStopMessageCompareContext } from './stop-message-compare-context.js';
import {
} from '../native/router-hotpath/native-stop-message-auto-semantics.js';
import {
  extractCurrentAssistantStopTextWithNative,
  extractStopMessageAutoCliResultSnapshotFromRequestWithNative,
  normalizeStoplessTriggerHintForMetadataWithNative,
  planStopMessageAutoHandlerWithNative,
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  getCapturedRequest,
  planStopMessageDefaultConfig,
  planStoplessDecisionContextSignals,
  resolveAdapterContextProviderKey,
  resolveRuntimeStopMessageStateFromAdapterContext,
} from './handlers/stop-message-auto/runtime-utils.js';

type StoplessRuntimeControlValue = {
  flowId: string;
  repeatCount: number;
  maxRepeats: number;
  triggerHint?: string;
  continuationPrompt?: string;
  schemaFeedback?: Record<string, unknown>;
  active: boolean;
  updatedAt?: number;
};

type StopMessageHandlerPlan = {
  action:
    | 'return_null'
    | 'return_terminal_final'
    | 'throw_stopless_loop'
    | 'return_schema_fail_fast'
    | 'return_schema_allow_stop'
    | 'return_handler_plan';
  compareContext?: Record<string, unknown>;
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
} & Record<string, unknown>;

function isBuiltinRuntimeSupported(name: string): boolean {
  switch (name.trim().toLowerCase()) {
    case 'stop_message_auto':
      return true;
    default:
      return false;
  }
}

function buildStoplessRuntimeStateFromPlan(
  plan: StopMessageHandlerPlan,
): StoplessRuntimeControlValue | null {
  if (plan.action !== 'return_handler_plan') {
    return null;
  }
  const persistPlan = plan.persistPlan;
  if (!persistPlan) {
    return null;
  }
  const continuationPrompt =
    typeof plan.effectiveDecision?.followup_text === 'string'
      ? String(plan.effectiveDecision.followup_text)
      : undefined;
  return {
    flowId: plan.flowId || 'stop_message_flow',
    repeatCount: persistPlan.nextUsed,
    maxRepeats: persistPlan.nextMaxRepeats,
    ...(typeof plan.stoplessTriggerHint === 'string' && plan.stoplessTriggerHint.trim()
      ? { triggerHint: normalizeStoplessTriggerHintForMetadataWithNative(plan.stoplessTriggerHint) }
      : {}),
    ...(continuationPrompt ? { continuationPrompt } : {}),
    ...(plan.schemaFeedback ? { schemaFeedback: plan.schemaFeedback as unknown as Record<string, unknown> } : {}),
    active: true,
    updatedAt: Date.now(),
  };
}

function buildStopMessageHandlerInput(
  ctx: ServerToolHandlerContext,
  record: Record<string, unknown>,
  runtimeControl: Record<string, unknown> | undefined,
  previousCompare: Record<string, unknown> | undefined
): Record<string, unknown> {
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
    ?? { continuationPrompt: '', repeatCount: 1, maxRepeats: 3, active: true };

  const decisionSignals = planStoplessDecisionContextSignals({
    adapterContext: ctx.adapterContext,
    capturedRequest: captured
  }) as {
    portStopMessageDisabled: boolean;
    hasResponsesSubmitToolOutputsResume: boolean;
    planModeActive: boolean;
  };
  const defaultConfig = planStopMessageDefaultConfig({
    envText: process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_TEXT,
    envMaxRepeats: process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_MAX_REPEATS
  });

  return {
    captured,
    previousCompare,
    effectiveRuntimeLoopState,
    defaultConfig,
    decisionSignals,
  };
}

async function runBuiltinStopMessageAutoHandler(
  ctx: ServerToolHandlerContext
): Promise<{ flowId: string; finalize: () => Promise<ServerToolHandlerResult> } | null> {
  const record = ctx.adapterContext as Record<string, unknown>;
  const runtimeControl = readRuntimeControlFromBoundMetadataCenter(record);
  const previousCompare = readStopMessageCompareContext(ctx.adapterContext);
  const handlerInputContext = buildStopMessageHandlerInput(
    ctx,
    record,
    runtimeControl,
    previousCompare as unknown as Record<string, unknown> | undefined
  ) as {
    captured?: unknown;
    previousCompare?: Record<string, unknown>;
    effectiveRuntimeLoopState?: Record<string, unknown>;
    defaultConfig: Record<string, unknown>;
    decisionSignals: Record<string, unknown>;
  };
  const assistantStopText = extractCurrentAssistantStopTextWithNative(ctx.base as Record<string, unknown>);
  const plan = planStopMessageAutoHandlerWithNative<StopMessageHandlerPlan>({
    adapterContext: record,
    base: ctx.base,
    requestId: ctx.requestId,
    followupFlowId: runtimeControl?.serverToolFollowup === true ? '__servertool_followup__' : '',
    shouldRunVisionFlow: false,
    shouldBypassStopMessageForMedia: false,
    metadataRuntimeControl: runtimeControl,
    metadataPreviousCompare: handlerInputContext.previousCompare,
    defaultConfig: handlerInputContext.defaultConfig,
    decisionSignals: handlerInputContext.decisionSignals,
    capturedRequest: handlerInputContext.captured as Record<string, unknown> | undefined,
    effectiveRuntimeLoopState: handlerInputContext.effectiveRuntimeLoopState,
    providerKey: resolveAdapterContextProviderKey(ctx.adapterContext) || undefined,
    assistantStopText,
  });

  if (plan.compareContext && typeof plan.compareContext === 'object' && !Array.isArray(plan.compareContext)) {
    attachStopMessageCompareContext(ctx.adapterContext, plan.compareContext as any);
    writeRuntimeControlToBoundMetadataCenter({
      metadata: record,
      key: 'stopMessageCompareContext',
      value: plan.compareContext as unknown as JsonObject,
      writer: {
        module: 'sharedmodule/llmswitch-core/src/servertool/builtin-handler-catalog.ts',
        symbol: 'runBuiltinStopMessageAutoHandler',
        stage: 'stop_message_compare_context_writer'
      },
      reason: 'stop-message-compare-context'
    });
  } else if (previousCompare) {
    attachStopMessageCompareContext(ctx.adapterContext, previousCompare);
  }

  const stoplessRuntimeState = buildStoplessRuntimeStateFromPlan(plan);
  if (stoplessRuntimeState) {
    writeRuntimeControlToBoundMetadataCenter({
      metadata: record,
      key: 'stopless',
      value: stoplessRuntimeState as unknown as JsonObject,
      writer: {
        module: 'sharedmodule/llmswitch-core/src/servertool/builtin-handler-catalog.ts',
        symbol: 'runBuiltinStopMessageAutoHandler',
        stage: 'stopless_runtime_control_writer'
      },
      reason: 'stopless-runtime-state'
    });
  }

  switch (plan.action) {
    case 'return_null':
      return null;
    case 'throw_stopless_loop': {
      const err: Error & {
        code?: string;
        status?: number;
        repeatCount?: number;
        threshold?: number;
        goalContextCount?: number;
      } = Object.assign(
        new Error(plan.stoplessLoopErrorMessage ?? '[servertool] stopless stop loop detected'),
        {
          code: plan.stoplessLoopErrorCode ?? 'STOPLESS_STOP_LOOP_DETECTED',
          status: 500,
          repeatCount: plan.stoplessLoopRepeatCount,
          threshold: plan.stoplessLoopThreshold,
          goalContextCount: plan.stoplessLoopGoalContextCount
        }
      );
      throw err;
    }
    case 'return_terminal_final':
    case 'return_schema_fail_fast':
    case 'return_schema_allow_stop':
      return {
        flowId: plan.flowId || 'stop_message_flow',
        finalize: async (): Promise<ServerToolHandlerResult> => ({
          chatResponse: (plan.terminalChatResponse ?? ctx.base) as JsonObject,
          execution: {
            flowId: plan.flowId || 'stop_message_flow',
            context: { stopMessageTerminalFinal: true }
          }
        })
      };
    case 'return_handler_plan':
      return {
        flowId: plan.flowId || 'stop_message_flow',
        finalize: async (): Promise<ServerToolHandlerResult> => ({
          chatResponse: ctx.base as JsonObject,
          execution: {
            flowId: plan.flowId || 'stop_message_flow',
            context: {
              decision: (plan.effectiveDecision ?? {}) as JsonObject,
              assistantStopText: plan.assistantStopText ?? '',
              ...(stoplessRuntimeState ? { stopless: stoplessRuntimeState as unknown as JsonObject } : {}),
              ...(typeof plan.stoplessTriggerHint === 'string' && plan.stoplessTriggerHint.trim()
                ? { stopSchemaTriggerHint: normalizeStoplessTriggerHintForMetadataWithNative(plan.stoplessTriggerHint) }
                : {}),
              ...(plan.schemaFeedback ? { stopSchemaFeedback: plan.schemaFeedback } : {})
            }
          }
        })
      };
    default:
      return null;
  }
}

async function runBuiltinHandler(
  name: string,
  ctx: ServerToolHandlerContext
): Promise<{ flowId: string; finalize: () => Promise<ServerToolHandlerResult> } | null> {
  switch (name) {
    case 'stop_message_auto':
      return runBuiltinStopMessageAutoHandler(ctx);
    default:
      throw new Error(`[servertool] unsupported builtin handler runtime: ${name}`);
  }
}

export async function __executeBuiltinHandlerForRuntime(
  name: string,
  ctx: ServerToolHandlerContext
): Promise<{ flowId: string; finalize: () => Promise<ServerToolHandlerResult> } | null> {
  return runBuiltinHandler(name, ctx);
}

function readSkeletonOwnedRegistration(name: string): ServerToolHandlerRegistrationSpec | null {
  const spec = getServertoolToolSpec(name);
  if (!spec || spec.enabled === false) {
    return null;
  }
  const autoHook =
    spec.trigger.type === 'auto'
      ? {
          id: spec.name,
          phase: spec.trigger.phase ?? 'default',
          priority: spec.trigger.priority ?? 100
        }
      : undefined;
  return {
    name: spec.name,
    enabled: true,
    trigger: spec.trigger.type,
    executionMode: spec.execution.mode,
    stripAfterExecute: spec.execution.stripAfterExecute,
    ...(autoHook ? { autoHook } : {})
  };
}

export function getBuiltinHandlerEntry(name: string): ServerToolHandlerEntry | undefined {
  const registration = readSkeletonOwnedRegistration(name);
  if (!registration) {
    return undefined;
  }
  if (!isBuiltinRuntimeSupported(registration.name)) {
    return undefined;
  }
  const entry: ServerToolHandlerEntry = {
    name: registration.name,
    trigger: registration.trigger,
    execution: {
      kind: 'builtin',
      builtinName: registration.name
    },
    registration
  };
  if (registration.trigger === 'auto' && registration.autoHook) {
    entry.autoHook = {
      id: registration.autoHook.id,
      phase: registration.autoHook.phase,
      priority: registration.autoHook.priority,
      order: -1
    };
  }
  return entry;
}

export function listBuiltinHandlerNames(): string[] {
  return listServertoolToolSpecs()
    .filter((spec) => spec.enabled !== false)
    .map((spec) => spec.name.trim().toLowerCase())
    .filter((name) => isBuiltinRuntimeSupported(name))
    .sort();
}

export function listBuiltinAutoHandlerEntries(): ServerToolHandlerEntry[] {
  return listBuiltinHandlerNames()
    .map((name) => getBuiltinHandlerEntry(name))
    .filter((entry): entry is ServerToolHandlerEntry => Boolean(entry?.autoHook));
}
