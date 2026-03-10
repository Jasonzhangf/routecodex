import type { LoadBalancingPolicy, RoutePoolLoadBalancingPolicy, RoutePoolTier } from '../types.js';
import type { ProviderRegistry } from '../provider-registry.js';
import { extractProviderId, getProviderModelId } from './key-parsing.js';

export type ResolvedTierLoadBalancing = {
  strategy: LoadBalancingPolicy['strategy'];
  weights?: Record<string, number>;
};

export function resolveTierLoadBalancing(
  tier: RoutePoolTier,
  globalPolicy?: LoadBalancingPolicy
): ResolvedTierLoadBalancing {
  const tierPolicy = tier.loadBalancing;
  return {
    strategy: tierPolicy?.strategy ?? globalPolicy?.strategy ?? 'round-robin',
    weights: tierPolicy?.weights ?? globalPolicy?.weights
  };
}

export function resolveGroupWeight(groupId: string, weights?: Record<string, number>): number {
  if (!weights) {
    return 1;
  }
  const direct = weights[groupId];
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) {
    return direct;
  }
  const providerId = groupId.split('.')[0] ?? groupId;
  const providerOnly = weights[providerId];
  if (typeof providerOnly === 'number' && Number.isFinite(providerOnly) && providerOnly > 0) {
    return providerOnly;
  }
  return 1;
}

export function buildGroupWeights(
  groups: Map<string, string[]>,
  weights?: Record<string, number>
): Record<string, number> | undefined {
  if (!groups.size || !weights) {
    return undefined;
  }
  const out: Record<string, number> = {};
  let hasExplicit = false;
  for (const [groupId] of groups.entries()) {
    const resolved = resolveGroupWeight(groupId, weights);
    out[groupId] = resolved;
    if (resolved !== 1) {
      hasExplicit = true;
    }
  }
  return hasExplicit ? out : undefined;
}

export function hasNonUniformWeights(candidates: string[], weights?: Record<string, number>): boolean {
  if (!weights || candidates.length < 2) {
    return false;
  }
  let ref: number | undefined;
  for (const key of candidates) {
    const raw = weights[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      continue;
    }
    if (ref === undefined) {
      ref = raw;
    } else if (Math.abs(raw - ref) > 1e-6) {
      return true;
    }
  }
  return false;
}

export function buildCandidateWeights(opts: {
  candidates: string[];
  providerRegistry: ProviderRegistry;
  staticWeights?: Record<string, number>;
  dynamicWeights?: Record<string, number>;
}): Record<string, number> | undefined {
  const { candidates, providerRegistry, staticWeights, dynamicWeights } = opts;
  if ((!staticWeights || Object.keys(staticWeights).length === 0) && (!dynamicWeights || Object.keys(dynamicWeights).length === 0)) {
    return undefined;
  }

  const out: Record<string, number> = {};
  let hasExplicit = false;

  for (const key of candidates) {
    const dynamic = dynamicWeights?.[key];
    const staticWeight = resolveCandidateWeight(key, staticWeights, providerRegistry);
    const resolved = multiplyPositiveWeights(dynamic, staticWeight);
    if (resolved !== undefined) {
      out[key] = resolved;
      if (resolved !== 1) {
        hasExplicit = true;
      }
    }
  }

  if (!hasExplicit) {
    return undefined;
  }
  return out;
}

function resolveCandidateWeight(
  key: string,
  weights: Record<string, number> | undefined,
  providerRegistry: ProviderRegistry
): number | undefined {
  if (!weights) {
    return undefined;
  }
  const direct = normalizePositiveWeight(weights[key]);
  if (direct !== undefined) {
    return direct;
  }
  const providerId = extractProviderId(key) ?? '';
  if (!providerId) {
    return undefined;
  }
  try {
    const modelId = getProviderModelId(key, providerRegistry) ?? '';
    if (modelId) {
      const grouped = normalizePositiveWeight(weights[`${providerId}.${modelId}`]);
      if (grouped !== undefined) {
        return grouped;
      }
    }
  } catch {
    // Ignore registry misses and fall back to provider-only weight.
  }
  return normalizePositiveWeight(weights[providerId]);
}

function normalizePositiveWeight(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function multiplyPositiveWeights(...values: Array<number | undefined>): number | undefined {
  let resolved: number | undefined;
  for (const value of values) {
    const normalized = normalizePositiveWeight(value);
    if (normalized === undefined) {
      continue;
    }
    resolved = resolved === undefined ? normalized : Math.max(1, Math.round(resolved * normalized));
  }
  return resolved;
}
