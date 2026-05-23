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

type StopMessageSnapshot = NonNullable<ReturnType<typeof resolveStopMessageSnapshot>>;

function isPersistentStickyKey(value: unknown): value is string {
  return typeof value === 'string' && (
    value.startsWith('tmux:') || value.startsWith('session:') || value.startsWith('conversation:')
  );
}

function readPersistedStopMessageSnapshot(candidateKeys: string[]): StopMessageSnapshot | null {
  for (const key of candidateKeys) {
    if (!isPersistentStickyKey(key)) {
      continue;
    }
    const snapshot = resolveStopMessageSnapshot(loadRoutingInstructionStateSync(key));
    if (snapshot) {
      return snapshot;
    }
  }
  return null;
}

function isNonActiveManagedGoal(adapterContext: AdapterContext): boolean {
  const goal = readStoplessGoalState(adapterContext).state;
  return Boolean(goal && goal.status !== 'idle' && goal.status !== 'active');
}

function resolveDefaultSnapshot(stopEligible: boolean, adapterContext: AdapterContext): StopMessageSnapshot | null {
  if (!stopEligible) {
    return null;
  }
  if (resolveStopMessageDefaultEnabled() === false) {
    return null;
  }
  const text = resolveStopMessageDefaultText()?.trim() || '继续执行';
  const configuredMax = isNonActiveManagedGoal(adapterContext) ? 1 : resolveStopMessageDefaultMaxRepeats();
  const maxRepeats = Number.isFinite(configuredMax) && Number(configuredMax) > 0
    ? Math.floor(Number(configuredMax))
    : 3;
  return {
    text,
    maxRepeats,
    used: 0,
    source: 'default'
  };
}

function persistDefaultBudget(args: {
  stickyKey?: string | null;
  snapshot: StopMessageSnapshot;
  used: number;
}): void {
  if (!isPersistentStickyKey(args.stickyKey)) {
    return;
  }
  const now = Date.now();
  const persistedState = loadRoutingInstructionStateSync(args.stickyKey) ?? null;
  const nextState = applyStopMessageSnapshotToState(persistedState, {
    text: args.snapshot.text,
    maxRepeats: args.snapshot.maxRepeats,
    used: args.used,
    source: args.snapshot.source,
    stageMode: args.snapshot.stageMode ?? 'on',
    aiMode: args.snapshot.aiMode ?? 'off',
    updatedAt: now,
    lastUsedAt: args.used > 0 ? now : undefined
  });
  saveRoutingInstructionStateSync(args.stickyKey, nextState);
}

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
  ) ?? resolveDefaultSnapshot(stopSignal.eligible, args.adapterContext);
  if (!snapshot) {
    return { observed: true, stopEligible: stopSignal.eligible };
  }

  if (!stopSignal.eligible) {
    persistDefaultBudget({
      stickyKey: lookup.stickyKey,
      snapshot,
      used: 0
    });
    return { observed: true, stopEligible: false, used: 0, maxRepeats: snapshot.maxRepeats };
  }

  const nextUsed = Math.max(0, Math.floor(snapshot.used)) + 1;
  persistDefaultBudget({
    stickyKey: lookup.stickyKey,
    snapshot,
    used: nextUsed
  });
  return { observed: true, stopEligible: true, used: nextUsed, maxRepeats: snapshot.maxRepeats };
}
