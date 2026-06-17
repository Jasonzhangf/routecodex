import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { readRuntimeMetadata } from '../conversion/runtime-metadata.js';
import { loadRoutingInstructionStateSync, saveRoutingInstructionStateSync } from '../native/router-hotpath/native-virtual-router-routing-state.js';
import {
  resolveStopMessageDefaultEnabled,
  resolveStopMessageDefaultMaxRepeats,
  resolveStopMessageDefaultText
} from './handlers/stop-message-auto/config.js';
import { resolveStopMessageSnapshot } from './handlers/stop-message-auto/routing-state.js';
import { planStopMessagePersistedLookup } from './handlers/stop-message-auto/runtime-utils.js';
import { readStoplessGoalState } from './handlers/stopless-goal-state.js';
import { inspectStopGatewaySignal } from './stop-gateway-context.js';
import {
  planBudgetStateUpdateWithNative,
  planStopMessageDefaultConfigWithNative,
  type BudgetSnapshot,
  type DefaultBudgetConfig
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  deserializeRoutingInstructionState,
  serializeRoutingInstructionState,
  type RoutingInstructionState
} from '../native/router-hotpath/native-virtual-router-routing-state.js';

// ── Shared helpers (stay in TS due to I/O) ──────────────────────────────────

type StopMessageSnapshot = NonNullable<ReturnType<typeof resolveStopMessageSnapshot>>;

function isPersistentStickyKey(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('session:');
}

function readPersistedStopMessageSnapshot(candidateKeys: string[]): StopMessageSnapshot | null {
  for (const key of candidateKeys) {
    if (!isPersistentStickyKey(key)) continue;
    const snapshot = resolveStopMessageSnapshot(loadRoutingInstructionStateSync(key));
    if (snapshot) return snapshot;
  }
  return null;
}

// ── Pure logic (native) ─────────────────────────────────────────────────────

function buildDefaultBudgetConfig(adapterContext: AdapterContext): DefaultBudgetConfig {
  const goal = readStoplessGoalState(adapterContext).state;
  const isNonActiveManaged = Boolean(goal && goal.status !== 'idle' && goal.status !== 'active');
  const plan = planStopMessageDefaultConfigWithNative({
    configEnabled: resolveStopMessageDefaultEnabled(),
    configText: resolveStopMessageDefaultText(),
    configMaxRepeats: resolveStopMessageDefaultMaxRepeats(),
    envText: process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_TEXT,
    envMaxRepeats: process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_MAX_REPEATS
  });
  return {
    enabled: plan.enabled,
    text: plan.text,
    max_repeats: plan.maxRepeats,
    is_non_active_managed_goal: isNonActiveManaged,
  };
}

function toBudgetSnapshot(snapshot: StopMessageSnapshot | null): BudgetSnapshot | undefined {
  return snapshot
    ? {
        text: snapshot.text,
        max_repeats: snapshot.maxRepeats,
        used: snapshot.used,
        source: snapshot.source || 'default',
        ...(snapshot.stageMode ? { stage_mode: snapshot.stageMode } : {}),
        ...(snapshot.aiMode ? { ai_mode: snapshot.aiMode } : {}),
      }
    : undefined;
}

function serializeStateForNative(state: RoutingInstructionState | null): Record<string, unknown> | null {
  return state ? serializeRoutingInstructionState(state) : null;
}

function hydrateStateFromNative(raw: Record<string, unknown> | null | undefined): RoutingInstructionState | null {
  return raw ? deserializeRoutingInstructionState(raw) : null;
}

function applyNativeBudgetPlan(args: {
  stopSignal: { observed: boolean; eligible: boolean; reason: string };
  snapshot: StopMessageSnapshot | null;
  existingState: RoutingInstructionState | null;
  adapterContext: AdapterContext;
  stickyKey?: string | null;
}): { observed: boolean; stopEligible: boolean; used?: number; maxRepeats?: number } {
  try {
    const decision = planBudgetStateUpdateWithNative({
      stopSignal: args.stopSignal,
      existingState: serializeStateForNative(args.existingState),
      snapshot: toBudgetSnapshot(args.snapshot) ?? null,
      defaultConfig: buildDefaultBudgetConfig(args.adapterContext),
      nowMs: Date.now(),
    });
    if (decision.shouldPersist && isPersistentStickyKey(args.stickyKey)) {
      saveRoutingInstructionStateSync(args.stickyKey, hydrateStateFromNative(decision.nextState ?? null));
    }
    return {
      observed: decision.observed,
      stopEligible: decision.stopEligible,
      ...(typeof decision.used === 'number' ? { used: decision.used } : {}),
      ...(typeof decision.maxRepeats === 'number' ? { maxRepeats: decision.maxRepeats } : {}),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`SERVERTOOL_NATIVE_BUDGET_FAILED: ${msg}`);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function applyStopMessageFinishReasonBudget(args: {
  payload: JsonObject;
  adapterContext: AdapterContext;
}): { observed: boolean; stopEligible: boolean; used?: number; maxRepeats?: number } {
  const stopSignal = inspectStopGatewaySignal(args.payload);
  const record = args.adapterContext as unknown as Record<string, unknown>;
  const rt = readRuntimeMetadata(record) ?? {};
  const lookup = planStopMessagePersistedLookup(record, rt, {
    includeSnapshotLookup: true,
    includeTombstoneLookup: false
  });
  const snapshot = (
    lookup.readStopMessageSnapshot
      ? readPersistedStopMessageSnapshot(lookup.candidateKeys)
      : null
  );
  const existingState = isPersistentStickyKey(lookup.stickyKey)
    ? loadRoutingInstructionStateSync(lookup.stickyKey)
    : null;

  return applyNativeBudgetPlan({
    stopSignal: {
      observed: stopSignal.observed,
      eligible: stopSignal.eligible,
      reason: stopSignal.reason,
    },
    snapshot,
    adapterContext: args.adapterContext,
    existingState,
    stickyKey: lookup.stickyKey,
  });
}

export function incrementStopMessageErrorBudget(args: {
  adapterContext: AdapterContext;
}): { observed: boolean; stopEligible: boolean; used?: number; maxRepeats?: number } {
  const record = args.adapterContext as unknown as Record<string, unknown>;
  const rt = readRuntimeMetadata(record) ?? {};
  const lookup = planStopMessagePersistedLookup(record, rt, {
    includeSnapshotLookup: true,
    includeTombstoneLookup: false
  });
  const snapshot = (
    lookup.readStopMessageSnapshot
      ? readPersistedStopMessageSnapshot(lookup.candidateKeys)
      : null
  );
  const existingState = isPersistentStickyKey(lookup.stickyKey)
    ? loadRoutingInstructionStateSync(lookup.stickyKey)
    : null;

  return applyNativeBudgetPlan({
    stopSignal: {
      observed: true,
      eligible: true,
      reason: 'servertool_error',
    },
    snapshot,
    adapterContext: args.adapterContext,
    existingState,
    stickyKey: lookup.stickyKey,
  });
}
