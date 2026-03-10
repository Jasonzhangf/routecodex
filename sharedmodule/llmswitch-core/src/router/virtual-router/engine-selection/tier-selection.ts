import type { RoutePoolTier, RoutingFeatures } from '../types.js';
import { DEFAULT_ROUTE } from '../types.js';
import type { ContextAdvisorResult } from '../context-advisor.js';
import { resolveContextWeightedConfig } from '../context-weighted.js';
import { resolveHealthWeightedConfig } from '../health-weighted.js';
import { pinCandidatesByAliasQueue, resolveAliasSelectionStrategy } from './alias-selection.js';
import { extractKeyAlias, extractKeyIndex, extractProviderId, getProviderModelId } from './key-parsing.js';
import { providerSupportsMultimodalRequest } from './multimodal-capability.js';
import type { SelectionDeps, TrySelectFromTierOptions, SelectionResult } from './selection-deps.js';
import { selectProviderKeyFromCandidatePool } from './tier-selection-select.js';
import {
  applyAntigravityAliasSessionLeases,
  extractLeaseRuntimeKey,
  isAntigravityGeminiModelKey,
} from './tier-selection-antigravity-session-lease.js';
import {
  extractNonAntigravityTargets,
  preferNonAntigravityWhenPossible,
  shouldAvoidAllAntigravityOnRetry,
  shouldAvoidAntigravityAfterRepeatedError
} from './tier-selection-antigravity-target-split.js';

export function trySelectFromTier(
  routeName: string,
  tier: RoutePoolTier,
  stickyKey: string | undefined,
  estimatedTokens: number,
  features: RoutingFeatures,
  deps: SelectionDeps,
  options: TrySelectFromTierOptions
): SelectionResult {
  const { disabledProviders, disabledKeysMap, allowedProviders, disabledModels, requiredProviderKeys } = options;
  let targets = Array.isArray(tier.targets) ? tier.targets : [];
  let preLeaseTargets: string[] | null = null;

  const excludedRaw: string[] = Array.isArray((features.metadata as any)?.excludedProviderKeys)
    ? ((features.metadata as any).excludedProviderKeys as unknown[])
        .filter((val): val is string => typeof val === 'string')
        .map((val) => val.trim())
        .filter((val) => val.length > 0)
    : [];
  const excludedKeys = new Set<string>(excludedRaw);
  if (excludedKeys.size > 0) {
    recordAliasQueueFailuresFromExcludedKeys(excludedKeys, tier.targets, deps);
  }
  if (excludedKeys.size > 0) {
    targets = targets.filter((key) => !excludedKeys.has(key));
  }
  const isRecoveryAttempt = excludedKeys.size > 0;

  // Antigravity safety: for certain retry signals (e.g. account verification required),
  // avoid hitting *any* Antigravity alias on retries to prevent cross-account risk cascades.
  if (isRecoveryAttempt && shouldAvoidAllAntigravityOnRetry(features.metadata)) {
    targets = targets.filter((key) => (extractProviderId(key) ?? '') !== 'antigravity');
  }

  const singleCandidateFallback = targets.length === 1 ? targets[0] : undefined;

  if (targets.length > 0) {
    // When quotaView is present, cooldown is expressed via quotaView.{cooldownUntil,blacklistUntil,inPool}.
    // Do not apply router-local cooldown filters in that mode.
    if (!deps.quotaView) {
      // Always respect cooldown signals. If a route/tier is depleted due to cooldown,
      // routing is expected to fall back to other tiers/routes (e.g. longcontext → default),
      // rather than repeatedly selecting the cooled-down provider.
      targets = targets.filter((key) => !deps.isProviderCoolingDown(key));
    }
  }

  if (allowedProviders && allowedProviders.size > 0) {
    targets = targets.filter((key) => {
      const providerId = extractProviderId(key);
      return providerId && allowedProviders.has(providerId);
    });
  }

  if (disabledProviders && disabledProviders.size > 0) {
    targets = targets.filter((key) => {
      const providerId = extractProviderId(key);
      return providerId && !disabledProviders.has(providerId);
    });
  }

  if (disabledKeysMap && disabledKeysMap.size > 0) {
    targets = targets.filter((key) => {
      const providerId = extractProviderId(key);
      if (!providerId) return true;

      const disabledKeys = disabledKeysMap.get(providerId);
      if (!disabledKeys || disabledKeys.size === 0) return true;

      const keyAlias = extractKeyAlias(key);
      const keyIndex = extractKeyIndex(key);

      if (keyAlias && disabledKeys.has(keyAlias)) {
        return false;
      }

      if (keyIndex !== undefined && disabledKeys.has(keyIndex + 1)) {
        return false;
      }

      return true;
    });
  }

  if (disabledModels && disabledModels.size > 0) {
    targets = targets.filter((key) => {
      const providerId = extractProviderId(key);
      if (!providerId) {
        return true;
      }
      const disabled = disabledModels.get(providerId);
      if (!disabled || disabled.size === 0) {
        return true;
      }
      const modelId = getProviderModelId(key, deps.providerRegistry);
      if (!modelId) {
        return true;
      }
      return !disabled.has(modelId);
    });
  }

  if (requiredProviderKeys && requiredProviderKeys.size > 0) {
    targets = targets.filter((key) => requiredProviderKeys.has(key));
  }

  // Antigravity session isolation:
  // - One alias (auth key) must not be shared across different sessions within the cooldown window,
  //   otherwise upstream may respond with 429 due to cross-session contamination.
  // - If the current session already has a leased alias, pin it when possible.
  preLeaseTargets = targets;
  const leaseResult = applyAntigravityAliasSessionLeases(targets, deps, features.metadata);
  targets = leaseResult.targets;
  // Default route must not fail purely due to Antigravity alias leasing.
  // If *all* candidates are blocked by lease, fall back to the pre-lease pool and let upstream decide.
  if (
    !targets.length &&
    routeName === DEFAULT_ROUTE &&
    preLeaseTargets &&
    preLeaseTargets.length > 0 &&
    leaseResult.blocked > 0 &&
    !leaseResult.pinnedStrict
  ) {
    targets = preLeaseTargets;
  }

  const serverToolRequired = (features.metadata as any)?.serverToolRequired === true;
  if (serverToolRequired) {
    const filtered: string[] = [];
    for (const key of targets) {
      try {
        const profile = deps.providerRegistry.get(key);
        if (!profile.serverToolsDisabled) {
          filtered.push(key);
        }
      } catch {
        // ignore unknown providers when filtering for servertools
      }
    }
    targets = filtered;
  }

  if (features.hasImageAttachment && routeName === 'multimodal') {
    targets = targets.filter((key) => providerSupportsMultimodalRequest(key, features, deps.providerRegistry));
    const kimiTargets = targets.filter((key) => {
      const modelId = getProviderModelId(key, deps.providerRegistry) ?? '';
      return modelId.trim().toLowerCase() === 'kimi-k2.5';
    });
    if (kimiTargets.length) {
      targets = kimiTargets;
    } else {
      const prioritized: string[] = [];
      const fallthrough: string[] = [];
      for (const key of targets) {
        try {
          const profile = deps.providerRegistry.get(key);
          if (profile.providerType === 'responses') {
            prioritized.push(key);
          } else if (profile.providerType === 'gemini') {
            prioritized.push(key);
          } else {
            fallthrough.push(key);
          }
        } catch {
          fallthrough.push(key);
        }
      }
      if (prioritized.length) {
        targets = prioritized;
      }
    }
  }

  if (!targets.length) {
    const leaseHint =
      leaseResult.blocked > 0
        ? `${routeName}:${tier.id}:antigravity_alias_session_busy(${leaseResult.blocked})`
        : `${routeName}:${tier.id}:empty`;
    return { providerKey: null, poolTargets: [], tierId: tier.id, failureHint: leaseHint };
  }
  const contextResult = deps.contextAdvisor.classify(
    targets,
    estimatedTokens,
    (key) => deps.providerRegistry.get(key)
  );
  let prioritizedPools = buildContextCandidatePools(contextResult);
  // ContextAdvisor overflow (ratio >= 1) is not always a hard stop: token estimation is approximate.
  // For the default route, treat overflow as a last-resort candidate pool when hardLimit=false,
  // to avoid route exhaustion when no other providers are available.
  const hardLimit = deps.contextAdvisor.getConfig().hardLimit;
  if (!hardLimit && routeName === DEFAULT_ROUTE && contextResult.overflow.length > 0) {
    prioritizedPools = [...prioritizedPools, contextResult.overflow];
  }
  const avoidAntigravityOnRetry = isRecoveryAttempt && shouldAvoidAntigravityAfterRepeatedError(features.metadata);
  const nonAntigravityTargets = avoidAntigravityOnRetry ? extractNonAntigravityTargets(targets) : [];
  const poolsToTry =
    avoidAntigravityOnRetry && nonAntigravityTargets.length > 0
      ? [nonAntigravityTargets, ...prioritizedPools]
      : prioritizedPools;

  const quotaView = deps.quotaView;
  const now = quotaView ? Date.now() : 0;
  const healthWeightedCfg = resolveHealthWeightedConfig(deps.loadBalancer.getPolicy().healthWeighted);
  const contextWeightedCfg = resolveContextWeightedConfig(deps.loadBalancer.getPolicy().contextWeighted);
  const warnRatio = deps.contextAdvisor.getConfig().warnRatio;
  const nowForWeights = Date.now();

  for (const candidatePool of poolsToTry) {
    const isSafePool = candidatePool === contextResult.safe;
    const candidatesForSelect = avoidAntigravityOnRetry
      ? preferNonAntigravityWhenPossible(candidatePool)
      : candidatePool;
    if (leaseResult.preferredRuntimeKey && !leaseResult.pinnedStrict) {
      const preferredCandidates = candidatesForSelect.filter(
        (key) => isAntigravityGeminiModelKey(key, deps) && extractLeaseRuntimeKey(key, deps) === leaseResult.preferredRuntimeKey
      );
      if (preferredCandidates.length > 0) {
        const preferredProviderKey = selectProviderKeyFromCandidatePool({
          routeName,
          tier,
          stickyKey,
          candidates: preferredCandidates,
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
        });
        if (preferredProviderKey) {
          return { providerKey: preferredProviderKey, poolTargets: tier.targets, tierId: tier.id };
        }
      }
    }
    const providerKey = selectProviderKeyFromCandidatePool({
      routeName,
      tier,
      stickyKey,
      candidates: candidatesForSelect,
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
    });
    if (providerKey) {
      return { providerKey, poolTargets: tier.targets, tierId: tier.id };
    }
  }

  return {
    providerKey: null,
    poolTargets: tier.targets,
    tierId: tier.id,
    failureHint: describeAttempt(routeName, tier.id, contextResult)
  };
}

function recordAliasQueueFailuresFromExcludedKeys(
  excludedKeys: Set<string>,
  orderedTargets: string[],
  deps: SelectionDeps
): void {
  const store = deps.aliasQueueStore;
  if (!store || !excludedKeys || excludedKeys.size === 0) {
    return;
  }
  if (!Array.isArray(orderedTargets) || orderedTargets.length === 0) {
    return;
  }

  for (const ex of excludedKeys) {
    if (!ex || typeof ex !== 'string') continue;
    const providerId = extractProviderId(ex) ?? '';
    if (!providerId) continue;

    const strategy = resolveAliasSelectionStrategy(providerId, deps.loadBalancer.getPolicy().aliasSelection);
    if (strategy !== 'sticky-queue') continue;

    const modelId = getProviderModelId(ex, deps.providerRegistry) ?? '';
    if (!modelId) continue;

    const groupCandidates = orderedTargets.filter(
      (key) => (extractProviderId(key) ?? '') === providerId && (getProviderModelId(key, deps.providerRegistry) ?? '') === modelId
    );
    if (groupCandidates.length < 2) continue;

    try {
      pinCandidatesByAliasQueue({
        queueStore: store,
        providerId,
        modelId,
        candidates: groupCandidates,
        orderedTargets,
        excludedProviderKeys: new Set([ex]),
        aliasOfKey: extractKeyAlias,
        modelIdOfKey: (key) => getProviderModelId(key, deps.providerRegistry),
        availabilityCheck: () => true
      });
    } catch {
      // best-effort: alias queue rotation must not block selection
    }
  }
}


function buildContextCandidatePools(result: ContextAdvisorResult): string[][] {
  const ordered: string[][] = [];
  if (result.safe.length) {
    ordered.push(result.safe);
  }
  if (result.risky.length) {
    ordered.push(result.risky);
  }
  return ordered;
}

function describeAttempt(routeName: string, poolId: string | undefined, result: ContextAdvisorResult): string {
  const prefix = poolId ? `${routeName}:${poolId}` : routeName;
  if (result.safe.length > 0) {
    return `${prefix}:health`;
  }
  if (result.risky.length > 0) {
    return `${prefix}:context_risky`;
  }
  if (result.overflow.length > 0) {
    return `${prefix}:max_context_window`;
  }
  return prefix;
}
