import type { QuotaState } from '../../quota/provider-quota-center.js';
import type { ProviderModelBackoffTracker } from './provider-quota-daemon.model-backoff.js';

export type QuotaViewEntry = {
  providerKey: string;
  inPool: boolean;
  reason?: string;
  priorityTier?: number;
  cooldownUntil?: number | null;
  blacklistUntil?: number | null;
};

export function buildQuotaViewEntry(options: {
  state: QuotaState;
  nowMs: number;
  modelBackoff: ProviderModelBackoffTracker;
  errorPriorityWindowMs: number;
  errorPriorityBase: number;
}): QuotaViewEntry {
  const { state, nowMs, modelBackoff, errorPriorityWindowMs, errorPriorityBase } = options;
  const modelCooldownUntil = modelBackoff.getActiveCooldownUntil(state.providerKey, nowMs);

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
  const priorityPenalty =
    hasRecentError && typeof state.consecutiveErrorCount === 'number' && state.consecutiveErrorCount > 0
      ? Math.max(0, Math.floor(state.consecutiveErrorCount))
      : 0;
  const effectivePriority =
    priorityPenalty > 0
      ? Math.max(state.priorityTier, errorPriorityBase) + priorityPenalty
      : state.priorityTier;

  const hasModelCooldown = Boolean(modelCooldownUntil) && !withinBlacklist;
  const cooldownUntil = hasModelCooldown
    ? Math.max(state.cooldownUntil ?? 0, modelCooldownUntil ?? 0) || null
    : (state.cooldownUntil ?? null);

  return {
    providerKey: state.providerKey,
    inPool: hasModelCooldown ? false : state.inPool,
    reason: hasModelCooldown ? 'cooldown' : state.reason,
    priorityTier: effectivePriority,
    cooldownUntil,
    blacklistUntil
  };
}

