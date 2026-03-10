import type { HealthWeightedLoadBalancingConfig, ProviderQuotaViewEntry } from './types.js';

export type ResolvedHealthWeightedConfig = Required<{
  enabled: boolean;
  baseWeight: number;
  minMultiplier: number;
  beta: number;
  halfLifeMs: number;
  recoverToBestOnRetry: boolean;
}>;

/**
 * AWRR constant table (defaults).
 *
 * Notes:
 * - `minMultiplier=0.5` is the "50% of baseline share" floor: penalties will not reduce a key below ~half of
 *   its initial (equal) share within the same pool bucket.
 * - `halfLifeMs=10min` means: if no new errors occur, the effect of the last error decays by 50% every 10 minutes.
 * - `beta` controls how quickly errors reduce share; tune carefully.
 */
export const DEFAULT_HEALTH_WEIGHTED_CONFIG: ResolvedHealthWeightedConfig = {
  enabled: false,
  baseWeight: 100,
  minMultiplier: 0.5,
  beta: 0.1,
  halfLifeMs: 10 * 60 * 1000,
  recoverToBestOnRetry: true
};

export function resolveHealthWeightedConfig(
  raw?: HealthWeightedLoadBalancingConfig | null
): ResolvedHealthWeightedConfig {
  const enabled = raw?.enabled ?? DEFAULT_HEALTH_WEIGHTED_CONFIG.enabled;
  const baseWeight =
    typeof raw?.baseWeight === 'number' && Number.isFinite(raw.baseWeight) && raw.baseWeight > 0
      ? Math.floor(raw.baseWeight)
      : DEFAULT_HEALTH_WEIGHTED_CONFIG.baseWeight;
  const minMultiplier =
    typeof raw?.minMultiplier === 'number' && Number.isFinite(raw.minMultiplier) && raw.minMultiplier > 0
      ? Math.min(1, raw.minMultiplier)
      : DEFAULT_HEALTH_WEIGHTED_CONFIG.minMultiplier;
  const beta =
    typeof raw?.beta === 'number' && Number.isFinite(raw.beta) && raw.beta >= 0
      ? raw.beta
      : DEFAULT_HEALTH_WEIGHTED_CONFIG.beta;
  const halfLifeMs =
    typeof raw?.halfLifeMs === 'number' && Number.isFinite(raw.halfLifeMs) && raw.halfLifeMs > 0
      ? Math.floor(raw.halfLifeMs)
      : DEFAULT_HEALTH_WEIGHTED_CONFIG.halfLifeMs;
  const recoverToBestOnRetry = raw?.recoverToBestOnRetry ?? DEFAULT_HEALTH_WEIGHTED_CONFIG.recoverToBestOnRetry;

  return {
    enabled,
    baseWeight,
    minMultiplier,
    beta,
    halfLifeMs,
    recoverToBestOnRetry
  };
}

export function computeHealthMultiplier(entry: ProviderQuotaViewEntry | null, nowMs: number, cfg: ResolvedHealthWeightedConfig): number {
  if (!entry) {
    return 1;
  }
  const lastErrorAtMs = typeof entry.lastErrorAtMs === 'number' && Number.isFinite(entry.lastErrorAtMs) ? entry.lastErrorAtMs : null;
  const consecutiveErrorCount =
    typeof entry.consecutiveErrorCount === 'number' && Number.isFinite(entry.consecutiveErrorCount) && entry.consecutiveErrorCount > 0
      ? Math.floor(entry.consecutiveErrorCount)
      : 0;

  if (!lastErrorAtMs || consecutiveErrorCount <= 0) {
    return 1;
  }
  const elapsedMs = Math.max(0, nowMs - lastErrorAtMs);
  const decay = Math.exp((-Math.log(2) * elapsedMs) / cfg.halfLifeMs);
  const effectiveErrors = consecutiveErrorCount * decay;

  const raw = 1 - cfg.beta * effectiveErrors;
  return Math.max(cfg.minMultiplier, Math.min(1, raw));
}

export function computeHealthWeight(
  entry: ProviderQuotaViewEntry | null,
  nowMs: number,
  cfg: ResolvedHealthWeightedConfig
): { weight: number; multiplier: number } {
  const multiplier = computeHealthMultiplier(entry, nowMs, cfg);
  const weight = Math.max(1, Math.round(cfg.baseWeight * multiplier));
  return { weight, multiplier };
}

