import type { ContextAdvisorResult } from '../context-advisor.js';
import { computeContextMultiplier } from '../context-weighted.js';
import type { ResolvedHealthWeightedConfig } from '../health-weighted.js';
import type { RoutePoolTier } from '../types.js';
import type { ResolvedContextWeightedConfig } from '../context-weighted.js';
import { pinCandidatesByAliasQueue, resolveAliasSelectionStrategy } from './alias-selection.js';
import { computeContextWeightMultipliers } from './context-weight-multipliers.js';
import { extractKeyAlias, extractProviderId, getProviderModelId } from './key-parsing.js';
import type { SelectionDeps, TrySelectFromTierOptions } from './selection-deps.js';
import {
  buildCandidateWeights,
  buildGroupWeights,
  hasNonUniformWeights,
  resolveTierLoadBalancing
} from './tier-load-balancing.js';
import { pickPriorityGroup } from './tier-priority.js';
import { selectProviderKeyWithQuotaBuckets } from './tier-selection-quota-integration.js';

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

function applyAliasStickyQueuePinning(opts: {
  candidates: string[];
  orderedTargets: string[];
  deps: SelectionDeps;
  excludedKeys: Set<string>;
}): string[] {
  const { candidates, orderedTargets, deps, excludedKeys } = opts;
  if (!Array.isArray(candidates) || candidates.length < 2) {
    return candidates;
  }
  const store = deps.aliasQueueStore;
  if (!store) {
    return candidates;
  }

  // Candidates may include multiple providers. Apply sticky-queue pinning per (providerId, modelId) group
  // while preserving cross-provider competition.
  const groups = new Map<string, { providerId: string; modelId: string; keys: string[] }>();
  const keyToGroup = new Map<string, string>();
  for (const key of candidates) {
    if (!key || typeof key !== 'string') {
      continue;
    }
    const providerId = extractProviderId(key) ?? '';
    if (!providerId) {
      continue;
    }
    const strategy = resolveAliasSelectionStrategy(providerId, deps.loadBalancer.getPolicy().aliasSelection);
    if (strategy !== 'sticky-queue') {
      continue;
    }
    const modelId = getProviderModelId(key, deps.providerRegistry) ?? '';
    if (!modelId) {
      continue;
    }
    const groupId = `${providerId}::${modelId}`;
    const entry = groups.get(groupId) ?? { providerId, modelId, keys: [] };
    entry.keys.push(key);
    groups.set(groupId, entry);
    keyToGroup.set(key, groupId);
  }
  if (groups.size === 0) {
    return candidates;
  }

  const pinnedByGroup = new Map<string, Set<string>>();
  for (const [groupId, group] of groups.entries()) {
    if (group.keys.length < 2) {
      continue;
    }
    // Only pin when we have multiple aliases for the same provider+model.
    const aliases = new Set<string>();
    for (const key of group.keys) {
      const alias = extractKeyAlias(key);
      if (alias) {
        aliases.add(alias);
      }
    }
    if (aliases.size < 2) {
      continue;
    }
    const pinned = pinCandidatesByAliasQueue({
      queueStore: store,
      providerId: group.providerId,
      modelId: group.modelId,
      candidates: group.keys,
      orderedTargets,
      excludedProviderKeys: excludedKeys,
      aliasOfKey: extractKeyAlias,
      modelIdOfKey: (key) => getProviderModelId(key, deps.providerRegistry),
      availabilityCheck: (key) => deps.healthManager.isAvailable(key) || Boolean(deps.quotaView?.(key))
    });
    if (pinned && pinned.length) {
      pinnedByGroup.set(groupId, new Set(pinned));
    }
  }
  if (pinnedByGroup.size === 0) {
    return candidates;
  }

  return candidates.filter((key) => {
    const groupId = keyToGroup.get(key);
    if (!groupId) {
      return true;
    }
    const pinned = pinnedByGroup.get(groupId);
    return pinned ? pinned.has(key) : true;
  });
}

function preferAntigravityAliasesOnRetry(opts: {
  candidates: string[];
  excludedKeys: Set<string>;
  deps: SelectionDeps;
}): string[] {
  const { candidates, excludedKeys, deps } = opts;
  if (!Array.isArray(candidates) || candidates.length < 2) {
    return candidates;
  }
  if (!excludedKeys || excludedKeys.size === 0) {
    return candidates;
  }
  // Only apply this stronger retry preference for Antigravity.
  const strategy = resolveAliasSelectionStrategy('antigravity', deps.loadBalancer.getPolicy().aliasSelection);
  if (strategy !== 'sticky-queue') {
    return candidates;
  }

  const excludedModels = new Set<string>();
  for (const ex of excludedKeys) {
    if (!ex || typeof ex !== 'string') continue;
    if ((extractProviderId(ex) ?? '') !== 'antigravity') continue;
    try {
      const modelId = getProviderModelId(ex, deps.providerRegistry) ?? '';
      if (modelId) {
        excludedModels.add(modelId);
      }
    } catch {
      // ignore unknown model ids
    }
  }
  if (excludedModels.size === 0) {
    return candidates;
  }

  const preferred = candidates.filter((key) => {
    if (!key || typeof key !== 'string') return false;
    if ((extractProviderId(key) ?? '') !== 'antigravity') return false;
    try {
      const modelId = getProviderModelId(key, deps.providerRegistry) ?? '';
      return modelId && excludedModels.has(modelId);
    } catch {
      return false;
    }
  });

  // If we still have any Antigravity candidates for the failing model, keep retrying within Antigravity
  // (rotate aliases) before falling back to other pool targets.
  return preferred.length > 0 ? preferred : candidates;
}

export function selectProviderKeyFromCandidatePool(opts: {
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
    excludedKeys,
    isRecoveryAttempt,
    now,
    nowForWeights,
    healthWeightedCfg,
    contextWeightedCfg
  } = opts;
  const selectableCandidates =
    excludedKeys.size > 0
      ? candidates.filter((key) => !excludedKeys.has(key))
      : candidates;
  if (selectableCandidates.length === 0) {
    return null;
  }

  const quotaView = deps.quotaView;
  const tierLoadBalancing = resolveTierLoadBalancing(tier, deps.loadBalancer.getPolicy());

  const isAvailable = (key: string): boolean => {
    if (!quotaView) {
      return deps.healthManager.isAvailable(key);
    }
    const entry = quotaView(key);
    if (!entry) {
      // When quotaView is present, quota is the source of truth for availability.
      // Treat unknown entries as "in pool" so routing does not depend on router-local health.
      return true;
    }
    if (entry.inPool === false) {
      return false;
    }
    if (entry.cooldownUntil && entry.cooldownUntil > now) {
      return false;
    }
    if (entry.blacklistUntil && entry.blacklistUntil > now) {
      return false;
    }
    // When quotaView is injected, quota is the source of truth for availability.
    // Do not let router-local health snapshots (which may be stale or intentionally disabled)
    // prevent selection for in-pool targets.
    return true;
  };

  const selectFirstAvailable = (keys: string[]): string | null => {
    for (const key of keys) {
      if (isAvailable(key)) {
        return key;
      }
    }
    return null;
  };

  if (!quotaView) {
    // Single-provider pool should never be "emptied" by health/cooldown.
    // If there's only one possible target, we must return it even if it's currently unhealthy,
    // otherwise context routing can incorrectly fall back to a smaller-context route.
    if (selectableCandidates.length === 1) {
      return selectableCandidates[0] ?? null;
    }

    const retryPreferredCandidates =
      isRecoveryAttempt
        ? preferAntigravityAliasesOnRetry({ candidates: selectableCandidates, excludedKeys, deps })
        : selectableCandidates;

    // Alias-level selection strategy (config-driven).
    // Apply sticky-queue pinning per provider/model group (candidates can be mixed providers).
    const pinnedCandidates = applyAliasStickyQueuePinning({
      candidates: retryPreferredCandidates,
      orderedTargets: tier.targets,
      deps,
      excludedKeys
    });

    if (tier.mode === 'priority') {
      if (isRecoveryAttempt) {
        return selectFirstAvailable(pinnedCandidates);
      }
      const group = pickPriorityGroup({
        candidates: pinnedCandidates,
        orderedTargets: tier.targets,
        providerRegistry: deps.providerRegistry,
        availabilityCheck: isAvailable
      });
      if (!group) {
        return null;
      }
      const weights: Record<string, number> | undefined = buildCandidateWeights({
        candidates: group.groupCandidates,
        providerRegistry: deps.providerRegistry,
        staticWeights: tierLoadBalancing.weights,
        dynamicWeights: (() => {
          if (!isSafePool) return undefined;
          const ctx = computeContextWeightMultipliers({ candidates: group.groupCandidates, usage: contextResult.usage, warnRatio, cfg: contextWeightedCfg });
          if (!ctx) return undefined;
          const out: Record<string, number> = {};
          for (const key of group.groupCandidates) {
            const m = computeContextMultiplier({
              effectiveSafeRefTokens: ctx.ref,
              effectiveSafeTokens: ctx.eff[key] ?? 1,
              cfg: contextWeightedCfg
            });
            out[key] = Math.max(1, Math.round(100 * m));
          }
          return out;
        })()
      });
      const allowGrouped = !hasNonUniformWeights(group.groupCandidates, weights);
      if (allowGrouped && tierLoadBalancing.strategy !== 'sticky') {
        const groups = buildPrimaryTargetGroups(group.groupCandidates, deps);
        if (groups.size > 0) {
          const groupWeights = buildGroupWeights(groups, tierLoadBalancing.weights);
          const selected = deps.loadBalancer.selectGrouped(
            {
              routeName: `${routeName}:${tier.id}:priority:group:${group.groupId}`,
              groups,
              stickyKey: options.allowAliasRotation ? undefined : stickyKey,
              weights: groupWeights,
              availabilityCheck: isAvailable
            },
            'round-robin'
          );
          if (selected) {
            return selected;
          }
        }
      }
      return deps.loadBalancer.select(
        {
          routeName: `${routeName}:${tier.id}:priority:group:${group.groupId}`,
          candidates: group.groupCandidates,
          stickyKey: options.allowAliasRotation ? undefined : stickyKey,
          weights,
          availabilityCheck: isAvailable
        },
        'round-robin'
      );
    }

    const weights: Record<string, number> | undefined = buildCandidateWeights({
      candidates: pinnedCandidates,
      providerRegistry: deps.providerRegistry,
      staticWeights: tierLoadBalancing.weights,
      dynamicWeights: (() => {
        if (!isSafePool || !contextWeightedCfg.enabled) return undefined;
        const ctx = computeContextWeightMultipliers({ candidates: pinnedCandidates, usage: contextResult.usage, warnRatio, cfg: contextWeightedCfg });
        if (!ctx) return undefined;
        const out: Record<string, number> = {};
        for (const key of pinnedCandidates) {
          const m = computeContextMultiplier({
            effectiveSafeRefTokens: ctx.ref,
            effectiveSafeTokens: ctx.eff[key] ?? 1,
            cfg: contextWeightedCfg
          });
          out[key] = Math.max(1, Math.round(100 * m));
        }
        return out;
      })()
    });

    const allowGrouped = !hasNonUniformWeights(pinnedCandidates, weights);
    if (allowGrouped && tierLoadBalancing.strategy !== 'sticky') {
      const groups = buildPrimaryTargetGroups(pinnedCandidates, deps);
      if (groups.size > 0) {
        const groupWeights = buildGroupWeights(groups, tierLoadBalancing.weights);
        const selected = deps.loadBalancer.selectGrouped(
          {
            routeName: `${routeName}:${tier.id}`,
            groups,
            stickyKey: options.allowAliasRotation ? undefined : stickyKey,
            weights: groupWeights,
            availabilityCheck: isAvailable
          },
          tier.mode === 'round-robin' ? 'round-robin' : tierLoadBalancing.strategy
        );
        if (selected) {
          return selected;
        }
      }
    }

    return deps.loadBalancer.select(
      {
        routeName: `${routeName}:${tier.id}`,
        candidates: pinnedCandidates,
        stickyKey: options.allowAliasRotation ? undefined : stickyKey,
        weights,
        availabilityCheck: isAvailable
      },
      tier.mode === 'round-robin' ? 'round-robin' : tierLoadBalancing.strategy
    );
  }

  return selectProviderKeyWithQuotaBuckets({
    routeName,
    tier,
    stickyKey,
    candidates: selectableCandidates,
    isSafePool,
    deps,
    options,
    contextResult,
    warnRatio,
    excludedKeys,
    isRecoveryAttempt,
    now,
    nowForWeights,
    healthWeightedCfg,
    contextWeightedCfg,
    tierLoadBalancing,
    quotaView,
    isAvailable,
    selectFirstAvailable,
    applyAliasStickyQueuePinning: (quotaCandidates) =>
      applyAliasStickyQueuePinning({
        candidates: quotaCandidates,
        orderedTargets: tier.targets,
        deps,
        excludedKeys
      }),
    preferAntigravityAliasesOnRetry: (quotaCandidates) =>
      preferAntigravityAliasesOnRetry({
        candidates: quotaCandidates,
        excludedKeys,
        deps
      })
  });
}
