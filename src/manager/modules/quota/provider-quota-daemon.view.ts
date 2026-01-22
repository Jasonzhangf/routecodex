import type { QuotaState } from '../../quota/provider-quota-center.js';

export type QuotaViewEntry = {
  providerKey: string;
  inPool: boolean;
  reason?: string;
  priorityTier?: number;
  selectionPenalty?: number;
  lastErrorAtMs?: number | null;
  consecutiveErrorCount?: number;
  cooldownUntil?: number | null;
  blacklistUntil?: number | null;
};

export function buildQuotaViewEntry(options: {
  state: QuotaState;
  nowMs: number;
  modelBackoff: null;
  errorPriorityWindowMs: number;
}): QuotaViewEntry {
  const { state, nowMs, errorPriorityWindowMs } = options;

  const blacklistUntil = state.blacklistUntil ?? null;
  const withinBlacklist = blacklistUntil !== null && nowMs < blacklistUntil;

  const lastErrorAtMs =
    typeof (state as unknown as { lastErrorAtMs?: unknown }).lastErrorAtMs === 'number'
      ? ((state as unknown as { lastErrorAtMs?: number }).lastErrorAtMs as number)
      : null;
  const hasRecentError =
    typeof lastErrorAtMs === 'number' &&
    Number.isFinite(lastErrorAtMs) &&
    nowMs - lastErrorAtMs >= 0 &&
    nowMs - lastErrorAtMs <= errorPriorityWindowMs;
  const selectionPenalty =
    hasRecentError && typeof state.consecutiveErrorCount === 'number' && state.consecutiveErrorCount > 0
      ? Math.max(0, Math.floor(state.consecutiveErrorCount))
      : 0;

  const cooldownUntil = state.cooldownUntil ?? null;

  return {
    providerKey: state.providerKey,
    inPool: state.inPool,
    reason: state.reason,
    priorityTier: state.priorityTier,
    selectionPenalty,
    lastErrorAtMs,
    consecutiveErrorCount: typeof state.consecutiveErrorCount === 'number' ? state.consecutiveErrorCount : undefined,
    cooldownUntil,
    blacklistUntil
  };
}
