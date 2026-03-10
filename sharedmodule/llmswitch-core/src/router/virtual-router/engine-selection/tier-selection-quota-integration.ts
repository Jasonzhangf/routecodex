import type { ContextAdvisorResult } from '../context-advisor.js';
import { computeContextMultiplier, type ResolvedContextWeightedConfig } from '../context-weighted.js';
import { computeHealthWeight, type ResolvedHealthWeightedConfig } from '../health-weighted.js';
import type { RoutePoolTier } from '../types.js';
import { buildQuotaBuckets, type QuotaBucketInputEntry } from './native-router-hotpath.js';
import { computeContextWeightMultipliers } from './context-weight-multipliers.js';
import type { SelectionDeps, TrySelectFromTierOptions } from './selection-deps.js';
import {
  buildCandidateWeights,
  buildGroupWeights,
  hasNonUniformWeights,
  type ResolvedTierLoadBalancing
} from './tier-load-balancing.js';
import { pickPriorityGroup } from './tier-priority.js';
import { extractProviderId, getProviderModelId } from './key-parsing.js';

function buildPrimaryTargetGroups(
  candidates: string[],
  deps: SelectionDeps
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const key of candidates) {
    const providerId = extractProviderId(key) ?? '';
    if (!providerId) {
      continue;
    }
    let modelId: string | undefined;
    try {
      modelId = getProviderModelId(key, deps.providerRegistry) ?? undefined;
    } catch {
      modelId = undefined;
    }
    const groupId = modelId ? `${providerId}.${modelId}` : providerId;
    const entry = groups.get(groupId) ?? [];
    entry.push(key);
    groups.set(groupId, entry);
  }
  return groups;
}

export function selectProviderKeyWithQuotaBuckets(opts: {
  routeName: string;
  tier: RoutePoolTier;
  stickyKey: string | undefined;
  candidates: string[];
  isSafePool: boolean;
  deps: SelectionDeps;
  options: TrySelectFromTierOptions;
  contextResult: ContextAdvisorResult;
  warnRatio: number;
  excludedKeys: Set<string>;
  isRecoveryAttempt: boolean;
  now: number;
  nowForWeights: number;
  healthWeightedCfg: ResolvedHealthWeightedConfig;
  contextWeightedCfg: ResolvedContextWeightedConfig;
  tierLoadBalancing: ResolvedTierLoadBalancing;
  quotaView: NonNullable<SelectionDeps['quotaView']>;
  isAvailable: (key: string) => boolean;
  selectFirstAvailable: (keys: string[]) => string | null;
  applyAliasStickyQueuePinning: (candidates: string[]) => string[];
  preferAntigravityAliasesOnRetry: (candidates: string[]) => string[];
}): string | null {
  const {
    routeName,
    tier,
    stickyKey,
    candidates,
    isSafePool,
    deps,
    options,
    contextResult,
    warnRatio,
    isRecoveryAttempt,
    now,
    nowForWeights,
    healthWeightedCfg,
    contextWeightedCfg,
    tierLoadBalancing,
    quotaView,
    isAvailable,
    selectFirstAvailable,
    applyAliasStickyQueuePinning,
    preferAntigravityAliasesOnRetry
  } = opts;

  const bucketInputs: QuotaBucketInputEntry[] = candidates.map((key, order) => {
    const entry = quotaView(key);
    const penaltyRaw = (entry as { selectionPenalty?: unknown } | undefined)?.selectionPenalty;
    return {
      key,
      order,
      hasQuota: Boolean(entry),
      inPool: entry ? entry.inPool !== false : true,
      ...(entry && typeof entry.cooldownUntil === 'number' ? { cooldownUntil: entry.cooldownUntil } : {}),
      ...(entry && typeof entry.blacklistUntil === 'number' ? { blacklistUntil: entry.blacklistUntil } : {}),
      ...(entry && typeof entry.priorityTier === 'number' ? { priorityTier: entry.priorityTier } : {}),
      ...(typeof penaltyRaw === 'number' ? { selectionPenalty: penaltyRaw } : {})
    };
  });

  const { priorities: sortedPriorities, buckets } = buildQuotaBuckets(bucketInputs, now);
  for (const priority of sortedPriorities) {
    const bucket = buckets.get(priority) ?? [];
    if (!bucket.length) {
      continue;
    }

    bucket.sort((a, b) => a.order - b.order);
    let bucketCandidates = bucket.map((item) => item.key);
    if (bucketCandidates.length === 1) {
      return bucketCandidates[0] ?? null;
    }

    if (isRecoveryAttempt) {
      bucketCandidates = preferAntigravityAliasesOnRetry(bucketCandidates);
    }

    bucketCandidates = applyAliasStickyQueuePinning(bucketCandidates);

    const quotaWeights: Record<string, number> = {};
    for (const item of bucket) {
      if (healthWeightedCfg.enabled) {
        const entry = quotaView(item.key);
        const { weight } = computeHealthWeight(entry, nowForWeights, healthWeightedCfg);
        quotaWeights[item.key] = weight;
      } else {
        quotaWeights[item.key] = Math.max(1, Math.floor(100 / (1 + Math.max(0, item.penalty))));
      }
    }

    const contextWeights: Record<string, number> | undefined = (() => {
      if (!isSafePool || !contextWeightedCfg.enabled) {
        return undefined;
      }
      const ctx = computeContextWeightMultipliers({
        candidates: bucketCandidates,
        usage: contextResult.usage,
        warnRatio,
        cfg: contextWeightedCfg
      });
      if (!ctx) {
        return undefined;
      }
      const out: Record<string, number> = {};
      for (const key of bucketCandidates) {
        const m = computeContextMultiplier({
          effectiveSafeRefTokens: ctx.ref,
          effectiveSafeTokens: ctx.eff[key] ?? 1,
          cfg: contextWeightedCfg
        });
        out[key] = Math.max(1, Math.round(100 * m));
      }
      return out;
    })();

    const bucketWeights = buildCandidateWeights({
      candidates: bucketCandidates,
      providerRegistry: deps.providerRegistry,
      staticWeights: tierLoadBalancing.weights,
      dynamicWeights: Object.keys(quotaWeights).length || contextWeights
        ? Object.fromEntries(
            bucketCandidates.map((key) => {
              const quotaWeight = quotaWeights[key];
              const contextWeight = contextWeights?.[key];
              const combined = typeof contextWeight === 'number'
                ? Math.max(1, Math.round((quotaWeight ?? 1) * contextWeight))
                : quotaWeight;
              return [key, combined ?? 1];
            })
          )
        : undefined
    });

    if (tier.mode === 'priority') {
      if (!isRecoveryAttempt) {
        const group = pickPriorityGroup({
          candidates: bucketCandidates,
          orderedTargets: tier.targets,
          providerRegistry: deps.providerRegistry,
          availabilityCheck: isAvailable
        });
        if (!group) {
          continue;
        }

        const groupWeights: Record<string, number> = {};
        for (const key of group.groupCandidates) {
          groupWeights[key] = bucketWeights?.[key] ?? 1;
        }

        const allowGrouped = !hasNonUniformWeights(group.groupCandidates, bucketWeights);
        if (allowGrouped && tierLoadBalancing.strategy !== 'sticky') {
          const groups = buildPrimaryTargetGroups(group.groupCandidates, deps);
          if (groups.size > 0) {
            const groupWeightMap = buildGroupWeights(groups, tierLoadBalancing.weights);
            const selected = deps.loadBalancer.selectGrouped(
              {
                routeName: `${routeName}:${tier.id}:priority:${priority}:group:${group.groupId}`,
                groups,
                stickyKey: options.allowAliasRotation ? undefined : stickyKey,
                weights: groupWeightMap,
                availabilityCheck: isAvailable
              },
              'round-robin'
            );
            if (selected) {
              return selected;
            }
          }
        }

        const selected = deps.loadBalancer.select(
          {
            routeName: `${routeName}:${tier.id}:priority:${priority}:group:${group.groupId}`,
            candidates: group.groupCandidates,
            stickyKey: options.allowAliasRotation ? undefined : stickyKey,
            weights: groupWeights,
            availabilityCheck: isAvailable
          },
          'round-robin'
        );
        if (selected) {
          return selected;
        }
        continue;
      }

      const recovered = selectFirstAvailable(bucketCandidates);
      if (recovered) return recovered;
      continue;
    }

    if (isRecoveryAttempt) {
      const recovered = selectFirstAvailable(bucketCandidates);
      if (recovered) return recovered;
      continue;
    }

    const allowGrouped = !hasNonUniformWeights(bucketCandidates, bucketWeights);
    if (allowGrouped && tierLoadBalancing.strategy !== 'sticky') {
      const groups = buildPrimaryTargetGroups(bucketCandidates, deps);
      if (groups.size > 0) {
        const groupWeightMap = buildGroupWeights(groups, tierLoadBalancing.weights);
        const selected = deps.loadBalancer.selectGrouped(
          {
            routeName: `${routeName}:${tier.id}:${priority}`,
            groups,
            stickyKey: options.allowAliasRotation ? undefined : stickyKey,
            weights: groupWeightMap,
            availabilityCheck: isAvailable
          },
          tier.mode === 'round-robin' ? 'round-robin' : tierLoadBalancing.strategy
        );
        if (selected) {
          return selected;
        }
      }
    }

    const selected = deps.loadBalancer.select(
      {
        routeName: `${routeName}:${tier.id}`,
        candidates: bucketCandidates,
        stickyKey: options.allowAliasRotation ? undefined : stickyKey,
        weights: bucketWeights,
        availabilityCheck: isAvailable
      },
      tier.mode === 'round-robin' ? 'round-robin' : tierLoadBalancing.strategy
    );
    if (selected) {
      return selected;
    }
  }

  return null;
}
