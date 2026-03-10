import { DEFAULT_MODEL_CONTEXT_TOKENS, type ProviderProfile, type VirtualRouterContextRoutingConfig } from './types.js';

export interface ContextUsageSnapshot {
  ratio: number;
  limit: number;
}

export interface ContextAdvisorResult {
  safe: string[];
  risky: string[];
  overflow: string[];
  usage: Record<string, ContextUsageSnapshot>;
  estimatedTokens: number;
  allOverflow: boolean;
}

const DEFAULT_WARN_RATIO = 0.9;

export class ContextAdvisor {
  private warnRatio = DEFAULT_WARN_RATIO;
  private hardLimit = false;

  configure(config?: VirtualRouterContextRoutingConfig | null): void {
    if (config && typeof config.warnRatio === 'number' && Number.isFinite(config.warnRatio)) {
      this.warnRatio = clampWarnRatio(config.warnRatio);
    } else {
      this.warnRatio = DEFAULT_WARN_RATIO;
    }
    this.hardLimit = Boolean(config?.hardLimit);
  }

  classify(
    pool: string[],
    estimatedTokens: number,
    resolveProfile: (key: string) => ProviderProfile
  ): ContextAdvisorResult {
    const normalizedTokens =
      typeof estimatedTokens === 'number' && Number.isFinite(estimatedTokens) && estimatedTokens > 0
        ? estimatedTokens
        : 0;
    const safe: string[] = [];
    const risky: string[] = [];
    const overflow: string[] = [];
    const usage: Record<string, ContextUsageSnapshot> = {};
    for (const providerKey of pool) {
      let limit = DEFAULT_MODEL_CONTEXT_TOKENS;
      try {
        const profile = resolveProfile(providerKey);
        if (profile?.maxContextTokens && Number.isFinite(profile.maxContextTokens)) {
          limit = profile.maxContextTokens;
        }
      } catch {
        limit = DEFAULT_MODEL_CONTEXT_TOKENS;
      }
      if (!limit || limit <= 0) {
        limit = DEFAULT_MODEL_CONTEXT_TOKENS;
      }
      const ratio = limit > 0 ? normalizedTokens / limit : 0;
      usage[providerKey] = { ratio, limit };
      if (normalizedTokens === 0 || ratio < this.warnRatio) {
        safe.push(providerKey);
        continue;
      }
      if (ratio < 1) {
        risky.push(providerKey);
        continue;
      }
      overflow.push(providerKey);
    }
    return {
      safe,
      risky,
      overflow,
      usage,
      estimatedTokens: normalizedTokens,
      allOverflow: safe.length === 0 && risky.length === 0 && overflow.length > 0
    };
  }

  getConfig(): { warnRatio: number; hardLimit: boolean } {
    return { warnRatio: this.warnRatio, hardLimit: this.hardLimit };
  }

}

function clampWarnRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_WARN_RATIO;
  }
  return Math.max(0.1, Math.min(0.99, value));
}
