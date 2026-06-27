import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ServerToolHandlerContext, ServerToolHandlerResult } from './types.js';
import type { ServerToolHandlerEntry } from './registry-types.js';
import type { ServerToolHandlerRegistrationSpec } from './skeleton-config.js';
import { getServertoolToolSpec, listServertoolToolSpecs } from './skeleton-config.js';
import { readNativeFunction } from '../native/router-hotpath/native-shared-conversion-semantics-core.js';
import {
  extractStopMessageAutoCliResultSnapshotFromRequestWithNative,
  getCapturedRequestWithNative,
  planStopMessageDefaultConfigWithNative,
  planStoplessDecisionContextSignalsWithNative,
  resolveRuntimeStopMessageStateFromAdapterContextWithNative,
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  applyStoplessMetadataCenterWritePlan,
  buildStoplessMetadataCenterWritePlan
} from './stopless-metadata-center-writer.js';
import { readRuntimeControlFromAnyBoundMetadataCenter } from './metadata-center-carrier.js';
import { MetadataCenter } from '../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';

type StopMessageHandlerPlan = {
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
  nativeHandlerResult?: {
    followup?: unknown;
    chatResponse?: unknown;
    stoplessRuntimeState?: unknown;
  };
  finalizeStopless?: Record<string, unknown>;
} & Record<string, unknown>;

function isBuiltinRuntimeSupported(name: string): boolean {
  switch (name.trim().toLowerCase()) {
    case 'stop_message_auto':
      return true;
    default:
      return false;
  }
}

/**
 * Read the Rust-built MetadataCenter snapshot (from `metadataCenterSnapshot` carrier).
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

function buildRuntimeMetadataCarrier(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const center = MetadataCenter.read(record)
    ?? MetadataCenter.read((record.metadata as Record<string, unknown> | undefined));
  if (!center) {
    return undefined;
  }
  const continuationContext = center.readContinuationContext();
  const runtimeControl = center.readRuntimeControl();
  const carrier: Record<string, unknown> = {};
  if (Object.keys(continuationContext).length > 0) {
    if (continuationContext.responsesResume) {
      carrier.responsesResume = continuationContext.responsesResume;
    }
  }
  if (Object.keys(runtimeControl).length > 0) {
    carrier.metadataCenterSnapshot = {
      runtimeControl,
    };
  }
  return Object.keys(carrier).length > 0 ? carrier : undefined;
}

function readStopMessageCompareContextFromRuntimeControl(
  record: Record<string, unknown>
): Record<string, unknown> | undefined {
  const runtimeControl = readRuntimeControlFromAnyBoundMetadataCenter(record);
  const compare = runtimeControl?.stopMessageCompareContext;
  return compare && typeof compare === 'object' && !Array.isArray(compare)
    ? compare as Record<string, unknown>
    : undefined;
}

function normalizeStoplessRuntimeLoopState(
  snapshot: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!snapshot) {
    return undefined;
  }

  const repeatCount =
    typeof snapshot.repeatCount === 'number' && Number.isFinite(snapshot.repeatCount)
      ? Math.max(1, Math.floor(snapshot.repeatCount))
      : undefined;
  const maxRepeats =
    typeof snapshot.maxRepeats === 'number' && Number.isFinite(snapshot.maxRepeats)
      ? Math.max(1, Math.floor(snapshot.maxRepeats))
      : undefined;
  const continuationPrompt =
    typeof snapshot.continuationPrompt === 'string' && snapshot.continuationPrompt.trim()
      ? snapshot.continuationPrompt.trim()
      : undefined;
  const triggerHint =
    typeof snapshot.triggerHint === 'string' && snapshot.triggerHint.trim()
      ? snapshot.triggerHint.trim()
      : undefined;
  const schemaFeedback =
    snapshot.schemaFeedback && typeof snapshot.schemaFeedback === 'object' && !Array.isArray(snapshot.schemaFeedback)
      ? snapshot.schemaFeedback
      : undefined;

  if (repeatCount === undefined && maxRepeats === undefined && !continuationPrompt && !triggerHint && !schemaFeedback) {
    return snapshot;
  }

  return {
    ...(typeof snapshot === 'object' ? snapshot : {}),
    ...(repeatCount !== undefined ? { used: repeatCount } : {}),
    ...(maxRepeats !== undefined ? { maxRepeats } : {}),
    ...(continuationPrompt ? { continuationPrompt } : {}),
    ...(triggerHint ? { triggerHint } : {}),
    ...(schemaFeedback ? { schemaFeedback } : {})
  };
}

function normalizePersistedStoplessControlState(
  snapshot: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!snapshot) {
    return undefined;
  }

  const repeatCount =
    typeof snapshot.repeatCount === 'number' && Number.isFinite(snapshot.repeatCount)
      ? Math.max(0, Math.floor(snapshot.repeatCount))
      : undefined;
  const maxRepeats =
    typeof snapshot.maxRepeats === 'number' && Number.isFinite(snapshot.maxRepeats)
      ? Math.max(1, Math.floor(snapshot.maxRepeats))
      : undefined;
  const continuationPrompt =
    typeof snapshot.continuationPrompt === 'string' && snapshot.continuationPrompt.trim()
      ? snapshot.continuationPrompt.trim()
      : undefined;
  const triggerHint =
    typeof snapshot.triggerHint === 'string' && snapshot.triggerHint.trim()
      ? snapshot.triggerHint.trim()
      : undefined;
  const schemaFeedback =
    snapshot.schemaFeedback && typeof snapshot.schemaFeedback === 'object' && !Array.isArray(snapshot.schemaFeedback)
      ? snapshot.schemaFeedback
      : undefined;

  if (repeatCount === undefined && maxRepeats === undefined && !continuationPrompt && !triggerHint && !schemaFeedback) {
    return snapshot;
  }

  return {
    ...(typeof snapshot === 'object' ? snapshot : {}),
    ...(repeatCount !== undefined ? { used: repeatCount } : {}),
    ...(maxRepeats !== undefined ? { maxRepeats } : {}),
    ...(continuationPrompt ? { continuationPrompt } : {}),
    ...(triggerHint ? { triggerHint } : {}),
    ...(schemaFeedback ? { schemaFeedback } : {})
  };
}

function buildStoplessAutoHandlerInput(ctx: ServerToolHandlerContext): Record<string, unknown> {
  const adapterContext = ctx.adapterContext as Record<string, unknown>;
  const runtimeControl = readRuntimeControlFromAnyBoundMetadataCenter(adapterContext);
  const runtimeMetadataCarrier = buildRuntimeMetadataCarrier(adapterContext);
  const capturedRequest = getCapturedRequestWithNative(adapterContext);
  const currentToolOutputSnapshot = extractStopMessageAutoCliResultSnapshotFromRequestWithNative({
    adapterContext,
    runtimeMetadata: runtimeMetadataCarrier,
  });
  const defaultConfig = planStopMessageDefaultConfigWithNative({
    tombstoneCleared: false,
    configEnabled: true,
    configText: undefined,
    configMaxRepeats: undefined,
    envText: undefined,
    envMaxRepeats: undefined,
  });
  const decisionSignals = planStoplessDecisionContextSignalsWithNative({
    adapterContext,
    runtimeMetadata: runtimeControl,
    capturedRequest,
  });
  const normalizedCurrentToolOutputSnapshot = normalizeStoplessRuntimeLoopState(currentToolOutputSnapshot);
  const resolvedRuntimeLoopState = resolveRuntimeStopMessageStateFromAdapterContextWithNative({
    adapterContext,
    runtimeMetadata: runtimeMetadataCarrier,
  });
  const effectiveRuntimeLoopState =
    normalizedCurrentToolOutputSnapshot
    ?? normalizePersistedStoplessControlState(resolvedRuntimeLoopState);
  return {
    adapterContext,
    base: ctx.base,
    requestId: ctx.requestId,
    followupFlowId: undefined,
    shouldRunVisionFlow: false,
    shouldBypassStopMessageForMedia: false,
    metadataRuntimeControl: runtimeControl ?? null,
    metadataPreviousCompare: readStopMessageCompareContextFromRuntimeControl(adapterContext) ?? null,
    defaultConfig,
    decisionSignals,
    capturedRequest,
    effectiveRuntimeLoopState,
    providerKey: undefined,
  };
}

function buildStoplessRuntimeExecutionContext(
  plan: StopMessageHandlerPlan
): JsonObject | undefined {
  if (plan.action !== 'return_handler_plan') return undefined;
  const runtimeContext: JsonObject = {};
  const effectiveDecision =
    plan.effectiveDecision && typeof plan.effectiveDecision === 'object' && !Array.isArray(plan.effectiveDecision)
      ? plan.effectiveDecision as JsonObject
      : undefined;
  const stoplessRuntimeState =
    plan.nativeHandlerResult?.stoplessRuntimeState
    && typeof plan.nativeHandlerResult.stoplessRuntimeState === 'object'
    && !Array.isArray(plan.nativeHandlerResult.stoplessRuntimeState)
      ? plan.nativeHandlerResult.stoplessRuntimeState as JsonObject
      : undefined;
  const finalizeStopless =
    plan.finalizeStopless
    && typeof plan.finalizeStopless === 'object'
    && !Array.isArray(plan.finalizeStopless)
      ? plan.finalizeStopless as JsonObject
      : undefined;

  const currentRepeatCount =
    typeof finalizeStopless?.repeatCount === 'number'
      ? Math.max(1, Math.floor(finalizeStopless.repeatCount))
      : typeof effectiveDecision?.used === 'number'
        ? Math.max(1, Math.floor(effectiveDecision.used) + 1)
        : undefined;
  const currentMaxRepeats =
    typeof finalizeStopless?.maxRepeats === 'number'
      ? Math.max(1, Math.floor(finalizeStopless.maxRepeats))
      : typeof effectiveDecision?.maxRepeats === 'number'
        ? Math.max(1, Math.floor(effectiveDecision.maxRepeats))
        : typeof effectiveDecision?.max_repeats === 'number'
          ? Math.max(1, Math.floor(effectiveDecision.max_repeats))
          : undefined;
  if (currentRepeatCount !== undefined && currentMaxRepeats !== undefined) {
    runtimeContext.stopless = {
      flowId: plan.flowId ?? 'stop_message_flow',
      repeatCount: currentRepeatCount,
      maxRepeats: currentMaxRepeats,
      ...(typeof plan.stoplessTriggerHint === 'string' ? { triggerHint: plan.stoplessTriggerHint } : {}),
      ...(plan.schemaFeedback ? { schemaFeedback: plan.schemaFeedback } : {}),
    } as JsonObject;
  }
  if (stoplessRuntimeState) {
    runtimeContext.stoplessRuntimeState = stoplessRuntimeState;
  }

  return Object.keys(runtimeContext).length > 0 ? runtimeContext : undefined;
}

async function planStoplessAutoHandlerNapi(input: Record<string, unknown>): Promise<StopMessageHandlerPlan> {
  const fn = readNativeFunction('planStoplessAutoHandlerJson');
  if (!fn) {
    throw new Error('planStoplessAutoHandlerJson native unavailable');
  }
  const raw = fn(JSON.stringify(input));
  if (typeof raw === 'string') {
    return JSON.parse(raw) as StopMessageHandlerPlan;
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as StopMessageHandlerPlan;
  }
  throw new Error(`planStoplessAutoHandlerJson native returned unsupported payload: ${typeof raw}`);
}

async function writeStoplessLearnedNoteNapi(args: {
  adapterContext: Record<string, unknown>;
  requestId: string;
  parsed: Record<string, unknown>;
  timestampMs: number;
}): Promise<void> {
  const fn = readNativeFunction('writeStoplessLearnedNoteJson');
  if (!fn) return;
  fn(JSON.stringify(args));
}

async function runBuiltinStopMessageAutoHandler(
  ctx: ServerToolHandlerContext
): Promise<{ flowId: string; finalize: () => Promise<ServerToolHandlerResult> } | null> {
  const record = ctx.adapterContext as Record<string, unknown>;
  const plan = await planStoplessAutoHandlerNapi(buildStoplessAutoHandlerInput(ctx));

  if (plan.compareContext) {
    const centerSnapshot = readMetadataCenterSnapshot(record);
    const writePlan = buildStoplessMetadataCenterWritePlan({
      handlerPlan: plan as unknown as Record<string, unknown>,
      center: centerSnapshot,
      requestId: ctx.requestId,
      timestampMs: Date.now()
    });
    if (writePlan) {
      applyStoplessMetadataCenterWritePlan({
        adapterContext: record,
        plan: writePlan,
        reason: 'stop-message-compare-context'
      });
    }
  }

  if (plan.shouldWriteLearnedNote && plan.learnedNote) {
    const parsed = (plan.learnedNote.parsed as Record<string, unknown> | undefined) ?? plan.learnedNote;
    await writeStoplessLearnedNoteNapi({
      adapterContext: record,
      requestId: ctx.requestId,
      parsed,
      timestampMs: Date.now()
    });
  }

  switch (plan.action) {
    case 'return_null':
      return null;
    case 'throw_goal_active_loop': {
      const err: Error & {
        code?: string;
        status?: number;
        repeatCount?: number;
        threshold?: number;
        goalContextCount?: number;
      } = Object.assign(
        new Error(plan.goalLoopErrorMessage ?? '[servertool] goal active stop loop detected'),
        {
          code: plan.goalLoopErrorCode ?? 'GOAL_ACTIVE_STOP_LOOP_DETECTED',
          status: 500,
          repeatCount: plan.goalLoopRepeatCount,
          threshold: plan.goalLoopThreshold,
          goalContextCount: plan.goalLoopGoalContextCount
        }
      );
      throw err;
    }
    case 'return_terminal_final':
    case 'return_schema_fail_fast':
    case 'return_schema_allow_stop':
      return {
        flowId: plan.flowId ?? 'stop_message_flow',
        finalize: async (): Promise<ServerToolHandlerResult> => ({
          chatResponse: (plan.terminalChatResponse ?? ctx.base) as JsonObject,
          execution: {
            flowId: plan.flowId ?? 'stop_message_flow',
            context: { stopMessageTerminalFinal: true }
          }
        })
      };
    case 'return_handler_plan':
      return {
        flowId: plan.flowId ?? 'stop_message_flow',
        finalize: async (): Promise<ServerToolHandlerResult> => ({
          chatResponse: ctx.base as JsonObject,
          execution: {
            flowId: plan.flowId ?? 'stop_message_flow',
            context: {
              decision: (plan.effectiveDecision ?? {}) as JsonObject,
              assistantStopText: plan.assistantStopText ?? '',
              ...(typeof plan.stoplessTriggerHint === 'string'
                ? { stopSchemaTriggerHint: plan.stoplessTriggerHint }
                : {}),
              ...(plan.schemaFeedback ? { stopSchemaFeedback: plan.schemaFeedback } : {}),
              ...(buildStoplessRuntimeExecutionContext(plan) ?? {})
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
    }
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
