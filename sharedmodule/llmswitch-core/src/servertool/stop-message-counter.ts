import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { readRuntimeMetadata } from '../conversion/runtime-metadata.js';
import { loadRoutingInstructionStateSync, saveRoutingInstructionStateSync } from '../router/virtual-router/sticky-session-store.js';
import {
  resolveStopMessageDefaultEnabled,
  resolveStopMessageDefaultMaxRepeats,
  resolveStopMessageDefaultText
} from './handlers/stop-message-auto/config.js';
import { applyStopMessageSnapshotToState, resolveStopMessageSnapshot } from './handlers/stop-message-auto/routing-state.js';
import { planStopMessagePersistedLookup } from './handlers/stop-message-auto/runtime-utils.js';
import { readStoplessGoalState } from './handlers/stopless-goal-state.js';
import { inspectStopGatewaySignal } from './stop-gateway-context.js';
import { calculateBudgetWithNative, type BudgetSnapshot, type DefaultBudgetConfig } from '../router/virtual-router/engine-selection/native-servertool-core-semantics.js';

// ── Shared helpers (stay in TS due to I/O) ──────────────────────────────────

type StopMessageSnapshot = NonNullable<ReturnType<typeof resolveStopMessageSnapshot>>;

function isPersistentStickyKey(value: unknown): value is string {
  return typeof value === 'string' && (
    value.startsWith('tmux:') || value.startsWith('session:') || value.startsWith('conversation:')
  );
}

function readPersistedStopMessageSnapshot(candidateKeys: string[]): StopMessageSnapshot | null {
  for (const key of candidateKeys) {
    if (!isPersistentStickyKey(key)) continue;
    const snapshot = resolveStopMessageSnapshot(loadRoutingInstructionStateSync(key));
    if (snapshot) return snapshot;
  }
  return null;
}

function persistBudget(args: {
  stickyKey?: string | null;
  text: string;
  maxRepeats: number;
  used: number;
  source: string;
  stageMode?: 'on' | 'off' | 'auto';
  aiMode?: 'on' | 'off';
}): void {
  if (!isPersistentStickyKey(args.stickyKey)) return;
  const now = Date.now();
  const persistedState = loadRoutingInstructionStateSync(args.stickyKey) ?? null;
  const nextState = applyStopMessageSnapshotToState(persistedState, {
    text: args.text,
    maxRepeats: args.maxRepeats,
    used: args.used,
    source: args.source || 'default',
    stageMode: args.stageMode ?? 'on',
    aiMode: args.aiMode ?? 'off',
    updatedAt: now,
    lastUsedAt: args.used > 0 ? now : undefined,
  });
  saveRoutingInstructionStateSync(args.stickyKey, nextState);
}

// ── Pure logic (native) ─────────────────────────────────────────────────────

function tryNativeBudget(args: {
  observed: boolean;
  stopEligible: boolean;
  snapshot: StopMessageSnapshot | null;
  adapterContext: AdapterContext;
}): { observed: boolean; stopEligible: boolean; used?: number; maxRepeats?: number } | undefined {
  try {
    const snap: BudgetSnapshot | undefined = args.snapshot
      ? { text: args.snapshot.text, max_repeats: args.snapshot.maxRepeats, used: args.snapshot.used, source: args.snapshot.source || 'default' }
      : undefined;

    const goal = readStoplessGoalState(args.adapterContext).state;
    const isNonActiveManaged = Boolean(goal && goal.status !== 'idle' && goal.status !== 'active');
    const defaultConfig: DefaultBudgetConfig = {
      enabled: resolveStopMessageDefaultEnabled() !== false,
      text: resolveStopMessageDefaultText()?.trim() || '继续执行',
      max_repeats: resolveStopMessageDefaultMaxRepeats() ?? 3,
      is_non_active_managed_goal: isNonActiveManaged,
    };

    const decision = calculateBudgetWithNative(args.observed, args.stopEligible, snap, defaultConfig);
    return {
      observed: decision.observed,
      stopEligible: decision.stop_eligible,
      used: decision.next_used,
      maxRepeats: decision.max_repeats,
    };
  } catch { return undefined; }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function applyStopMessageFinishReasonBudget(args: {
  payload: JsonObject;
  adapterContext: AdapterContext;
}): { observed: boolean; stopEligible: boolean; used?: number; maxRepeats?: number } {
  const stopSignal = inspectStopGatewaySignal(args.payload);
  if (!stopSignal.observed) {
    return { observed: false, stopEligible: false };
  }

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

  // Try native budget calculation
  const nativeResult = tryNativeBudget({
    observed: true,
    stopEligible: stopSignal.eligible,
    snapshot,
    adapterContext: args.adapterContext,
  });
  if (nativeResult) {
    if (nativeResult.used !== undefined && nativeResult.maxRepeats !== undefined) {
      persistBudget({
        stickyKey: lookup.stickyKey,
        text: snapshot?.text || '继续执行',
        maxRepeats: nativeResult.maxRepeats,
        used: nativeResult.used,
        source: snapshot?.source || 'default',
        stageMode: (snapshot as any)?.stageMode,
        aiMode: (snapshot as any)?.aiMode,
      });
    }
    return nativeResult;
  }

  // Fallback: pure TS
  const fallbackSnapshot = snapshot ?? resolveDefaultSnapshot(stopSignal.eligible, args.adapterContext);
  if (!fallbackSnapshot) {
    return { observed: true, stopEligible: stopSignal.eligible };
  }
  if (!stopSignal.eligible) {
    persistBudget({ stickyKey: lookup.stickyKey, text: fallbackSnapshot.text, maxRepeats: fallbackSnapshot.maxRepeats, used: 0, source: fallbackSnapshot.source });
    return { observed: true, stopEligible: false, used: 0, maxRepeats: fallbackSnapshot.maxRepeats };
  }
  const nextUsed = Math.max(0, Math.floor(fallbackSnapshot.used)) + 1;
  persistBudget({ stickyKey: lookup.stickyKey, text: fallbackSnapshot.text, maxRepeats: fallbackSnapshot.maxRepeats, used: nextUsed, source: fallbackSnapshot.source });
  return { observed: true, stopEligible: true, used: nextUsed, maxRepeats: fallbackSnapshot.maxRepeats };
}

// Keep existing helper for backward compat during migration
function resolveDefaultSnapshot(stopEligible: boolean, adapterContext: AdapterContext): StopMessageSnapshot | null {
  if (!stopEligible) return null;
  if (resolveStopMessageDefaultEnabled() === false) return null;
  const text = resolveStopMessageDefaultText()?.trim() || '继续执行';
  const goal = readStoplessGoalState(adapterContext).state;
  const isNonActiveManaged = Boolean(goal && goal.status !== 'idle' && goal.status !== 'active');
  const configuredMax = isNonActiveManaged ? 1 : resolveStopMessageDefaultMaxRepeats();
  const maxRepeats = Number.isFinite(configuredMax) && Number(configuredMax) > 0 ? Math.floor(Number(configuredMax)) : 3;
  return { text, maxRepeats, used: 0, source: 'default' as const };
}
