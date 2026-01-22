import type { QuotaState } from '../../quota/provider-quota-center.js';
import type { ProviderModelBackoffTracker } from './provider-quota-daemon.model-backoff.js';

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
  modelBackoff?: ProviderModelBackoffTracker | null;
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

  const modelCooldownUntil =
    options.modelBackoff ? options.modelBackoff.getActiveCooldownUntil(state.providerKey, nowMs) : null;
  const cooldownUntilRaw = state.cooldownUntil ?? null;
  const cooldownUntil =
    typeof modelCooldownUntil === 'number' && Number.isFinite(modelCooldownUntil)
      ? (typeof cooldownUntilRaw === 'number' && Number.isFinite(cooldownUntilRaw) && cooldownUntilRaw > modelCooldownUntil
          ? cooldownUntilRaw
          : modelCooldownUntil)
      : cooldownUntilRaw;
  const reason =
    typeof modelCooldownUntil === 'number' && Number.isFinite(modelCooldownUntil) && modelCooldownUntil > nowMs
      ? 'cooldown:model-capacity'
      : state.reason;

  return {
    providerKey: state.providerKey,
    inPool: state.inPool,
    reason,
    priorityTier: state.priorityTier,
    selectionPenalty,
    lastErrorAtMs,
    consecutiveErrorCount: typeof state.consecutiveErrorCount === 'number' ? state.consecutiveErrorCount : undefined,
    cooldownUntil,
    blacklistUntil
  };
}
