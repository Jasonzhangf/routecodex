import type { ContextWeightedLoadBalancingConfig } from './types.js';

export type ResolvedContextWeightedConfig = Required<{
  enabled: boolean;
  clientCapTokens: number;
  gamma: number;
  maxMultiplier: number;
}>;

/**
 * Context-weighted constant table (defaults).
 *
 * Intended behavior:
 * - Prefer smaller effective safe context windows early, so that larger windows remain available later.
 * - Compensation is proportional by default (`gamma=1`), but capped by `maxMultiplier`.
 *
 * Notes:
 * - `clientCapTokens` is the maximum effective context the client can consume, even if the model supports more.
 * - The effective safe window is computed using ContextAdvisor's `warnRatio` and model "slack" above the client cap.
 *   - If a model has slack >= the reserved margin, it effectively gets the full client cap as safe window.
 */
export const DEFAULT_CONTEXT_WEIGHTED_CONFIG: ResolvedContextWeightedConfig = {
  enabled: false,
  clientCapTokens: 200_000,
  gamma: 1,
  maxMultiplier: 2
};

export function resolveContextWeightedConfig(raw?: ContextWeightedLoadBalancingConfig | null): ResolvedContextWeightedConfig {
  const enabled = raw?.enabled ?? DEFAULT_CONTEXT_WEIGHTED_CONFIG.enabled;
  const clientCapTokens =
    typeof raw?.clientCapTokens === 'number' && Number.isFinite(raw.clientCapTokens) && raw.clientCapTokens > 0
      ? Math.floor(raw.clientCapTokens)
      : DEFAULT_CONTEXT_WEIGHTED_CONFIG.clientCapTokens;
  const gamma =
    typeof raw?.gamma === 'number' && Number.isFinite(raw.gamma) && raw.gamma > 0
      ? raw.gamma
      : DEFAULT_CONTEXT_WEIGHTED_CONFIG.gamma;
  const maxMultiplier =
    typeof raw?.maxMultiplier === 'number' && Number.isFinite(raw.maxMultiplier) && raw.maxMultiplier >= 1
      ? raw.maxMultiplier
      : DEFAULT_CONTEXT_WEIGHTED_CONFIG.maxMultiplier;
  return { enabled, clientCapTokens, gamma, maxMultiplier };
}

export function computeEffectiveSafeWindowTokens(options: {
  modelMaxTokens: number;
  warnRatio: number;
  clientCapTokens: number;
}): number {
  const modelMaxTokens =
    typeof options.modelMaxTokens === 'number' && Number.isFinite(options.modelMaxTokens) && options.modelMaxTokens > 0
      ? Math.floor(options.modelMaxTokens)
      : 1;
  const clientCapTokens =
    typeof options.clientCapTokens === 'number' && Number.isFinite(options.clientCapTokens) && options.clientCapTokens > 0
      ? Math.floor(options.clientCapTokens)
      : DEFAULT_CONTEXT_WEIGHTED_CONFIG.clientCapTokens;
  const warnRatio =
    typeof options.warnRatio === 'number' && Number.isFinite(options.warnRatio) && options.warnRatio > 0 && options.warnRatio < 1
      ? options.warnRatio
      : 0.9;

  const effectiveMax = Math.min(modelMaxTokens, clientCapTokens);
  const reserve = Math.ceil(effectiveMax * (1 - warnRatio));
  const slack = Math.max(0, modelMaxTokens - clientCapTokens);
  const reserveEff = Math.max(0, reserve - slack);
  return Math.max(1, effectiveMax - reserveEff);
}

export function computeContextMultiplier(options: {
  effectiveSafeRefTokens: number;
  effectiveSafeTokens: number;
  cfg: ResolvedContextWeightedConfig;
}): number {
  const ref = Math.max(1, Math.floor(options.effectiveSafeRefTokens));
  const cur = Math.max(1, Math.floor(options.effectiveSafeTokens));
  const ratio = ref / cur;
  const raw = Math.pow(Math.max(1, ratio), options.cfg.gamma);
  return Math.min(options.cfg.maxMultiplier, raw);
}

