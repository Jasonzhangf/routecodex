import { computeEffectiveSafeWindowTokens, type ResolvedContextWeightedConfig } from '../context-weighted.js';
import type { ContextAdvisorResult } from '../context-advisor.js';

export function computeContextWeightMultipliers(opts: {
  candidates: string[];
  usage: ContextAdvisorResult['usage'] | undefined;
  warnRatio: number;
  cfg: ResolvedContextWeightedConfig;
}): { ref: number; eff: Record<string, number> } | null {
  const { candidates, usage, warnRatio, cfg } = opts;
  if (!cfg.enabled) {
    return null;
  }
  const eff: Record<string, number> = {};
  let ref = 1;
  for (const key of candidates) {
    const entry = usage?.[key];
    const limit = entry && typeof entry.limit === 'number' && Number.isFinite(entry.limit) ? Math.floor(entry.limit) : 0;
    const safeEff = computeEffectiveSafeWindowTokens({
      modelMaxTokens: Math.max(1, limit),
      warnRatio,
      clientCapTokens: cfg.clientCapTokens
    });
    eff[key] = safeEff;
    if (safeEff > ref) {
      ref = safeEff;
    }
  }
  return { ref, eff };
}
