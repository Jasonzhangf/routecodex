import type {
  ClassificationResult,
  ModelCapability,
  RoutePoolTier,
  RouterMetadataInput,
  RoutingFeatures
} from '../../types.js';
import type { RoutingInstructionState } from '../../routing-instructions.js';
import { DEFAULT_ROUTE, VirtualRouterError, VirtualRouterErrorCode } from '../../types.js';
import {
  extractExcludedProviderKeySet,
  extractKeyAlias,
  extractKeyIndex,
  extractProviderId,
  getProviderModelId
} from '../../engine-selection/key-parsing.js';
import { providerSupportsMultimodalRequest } from '../../engine-selection/multimodal-capability.js';
import { trySelectFromTier } from '../../engine-selection/tier-selection.js';
import type { SelectionDeps } from '../../engine-selection/selection-deps.js';
import { resolveInstructionTarget } from '../../engine-selection/instruction-target.js';
import { filterCandidatesByRoutingState } from '../../engine-selection/routing-state-filter.js';
import { selectFromStickyPool as selectFromStickyPoolImpl } from '../../engine-selection/sticky-pool.js';
export { selectDirectProviderModel } from '../../engine-selection/direct-provider-model.js';
export { selectFromStickyPool } from '../../engine-selection/sticky-pool.js';
import {
  buildRouteCandidates,
  extendRouteCandidatesForState,
  initializeRouteQueue,
  normalizeRouteAlias,
  routeHasTargets,
  sortRoutePools
} from '../../engine-selection/route-utils.js';

export function selectProviderImpl(
  requestedRoute: string,
  metadata: RouterMetadataInput,
  classification: ClassificationResult,
  features: RoutingFeatures,
  activeState: RoutingInstructionState,
  deps: SelectionDeps,
  options: {
    routingState?: RoutingInstructionState;
  } = {}
): { providerKey: string; routeUsed: string; pool: string[]; poolId?: string } {
  const state = options.routingState ?? activeState;
  const quotaView = deps.quotaView;
  const quotaNow = quotaView ? Date.now() : 0;
  const isAllowedByQuota = (key: string): boolean => {
    if (!quotaView) {
      return true;
    }
    const entry = quotaView(key);
    if (!entry) {
      return true;
    }
    if (!entry.inPool) {
      return false;
    }
    if (entry.cooldownUntil && entry.cooldownUntil > quotaNow) {
      return false;
    }
    if (entry.blacklistUntil && entry.blacklistUntil > quotaNow) {
      return false;
    }
    return true;
  };
  const excludedProviderKeys = extractExcludedProviderKeySet(features.metadata);
  const forcedResolution = state.forcedTarget ? resolveInstructionTarget(state.forcedTarget, deps.providerRegistry) : null;
  if (forcedResolution && forcedResolution.mode === 'exact') {
    const forcedKey = forcedResolution.keys[0];
    if (!excludedProviderKeys.has(forcedKey) && !deps.isProviderCoolingDown(forcedKey) && isAllowedByQuota(forcedKey)) {
      return {
        providerKey: forcedKey,
        routeUsed: requestedRoute,
        pool: [forcedKey],
        poolId: 'forced'
      };
    }
  }

  let stickyResolution: ReturnType<typeof resolveInstructionTarget> = null;
  let stickyKeySet: Set<string> | undefined;
  if (!forcedResolution && state.stickyTarget) {
    stickyResolution = resolveInstructionTarget(state.stickyTarget, deps.providerRegistry);
    if (stickyResolution && stickyResolution.mode === 'exact') {
      const stickyKey = stickyResolution.keys[0];
      if (
        stickyProviderMatchesRequestCapabilities(
          stickyKey,
          requestedRoute,
          classification,
          features,
          deps.routing,
          deps.providerRegistry
        ) &&
        (deps.quotaView ? true : deps.healthManager.isAvailable(stickyKey)) &&
        !excludedProviderKeys.has(stickyKey) &&
        !deps.isProviderCoolingDown(stickyKey) &&
        isAllowedByQuota(stickyKey)
      ) {
        return {
          providerKey: stickyKey,
          routeUsed: requestedRoute,
          pool: [stickyKey],
          poolId: 'sticky'
        };
      }
    }
    if (stickyResolution && stickyResolution.mode === 'filter' && stickyResolution.keys.length > 0) {
      const liveKeys = stickyResolution.keys.filter(
        (key) =>
          stickyProviderMatchesRequestCapabilities(
            key,
            requestedRoute,
            classification,
            features,
            deps.routing,
            deps.providerRegistry
          ) &&
          (deps.quotaView ? true : deps.healthManager.isAvailable(key)) &&
          !excludedProviderKeys.has(key) &&
          !deps.isProviderCoolingDown(key) &&
          isAllowedByQuota(key)
      );
      if (liveKeys.length > 0) {
        stickyKeySet = new Set(liveKeys);
      }
    }
  }

  const allowAliasRotation =
    Boolean(state.stickyTarget) &&
    !state.stickyTarget?.keyAlias &&
    state.stickyTarget?.keyIndex === undefined;

  if (forcedResolution && forcedResolution.mode === 'filter') {
    const forcedKeySet = new Set(forcedResolution.keys);
    if (forcedKeySet.size > 0) {
      for (const key of Array.from(forcedKeySet)) {
        if (excludedProviderKeys.has(key) || deps.isProviderCoolingDown(key)) {
          forcedKeySet.delete(key);
        }
      }
    }
    if (forcedKeySet.size > 0) {
      const candidates = extendRouteCandidatesForState(
        buildRouteCandidates(
        requestedRoute,
        classification.candidates,
        features,
        deps.routing,
        deps.providerRegistry
        ),
        state,
        deps.routing
      );
      const filteredCandidates = filterCandidatesByRoutingState(
        candidates,
        state,
        deps.routing,
        deps.providerRegistry
      );

      if (filteredCandidates.length === 0) {
        const allowedProviders = Array.from(state.allowedProviders);
        const disabledProviders = Array.from(state.disabledProviders);
        const providersInRouting = new Set<string>();
        for (const pools of Object.values(deps.routing)) {
          if (!Array.isArray(pools)) continue;
          for (const pool of pools) {
            if (!pool || !Array.isArray(pool.targets)) continue;
            for (const key of pool.targets) {
              if (typeof key !== 'string' || !key) continue;
              const providerId = extractProviderId(key);
              if (providerId) {
                providersInRouting.add(providerId);
              }
            }
          }
        }
        const missingAllowedProviders =
          allowedProviders.length > 0 ? allowedProviders.filter((provider) => !providersInRouting.has(provider)) : [];
        const hint = (() => {
          if (missingAllowedProviders.length > 0) {
            return `Allowed providers not present in routing pools: ${missingAllowedProviders.join(', ')}`;
          }
          return 'Routing instructions excluded all route candidates';
        })();
        throw new VirtualRouterError(
          `No available providers after applying routing instructions (${hint}). ` +
            `Tip: remove/adjust <**...**> routing instructions (or use <**clear**>), or add providers/models to routing.`,
          VirtualRouterErrorCode.PROVIDER_NOT_AVAILABLE,
          {
            requestedRoute,
            allowedProviders,
            disabledProviders,
            missingAllowedProviders
          }
        );
      }

      return selectFromCandidates(
        filteredCandidates,
        metadata,
        classification,
        features,
        state,
        deps,
        {
          requiredProviderKeys: forcedKeySet,
          allowAliasRotation
        }
      );
    }
  }

  if (stickyKeySet && stickyKeySet.size > 0) {
    const stickySelection = selectFromStickyPoolImpl(
      stickyKeySet,
      metadata,
      features,
      state,
      deps,
      { allowAliasRotation }
    );
    if (stickySelection) {
      return stickySelection;
    }
  }

  const candidates = buildRouteCandidates(
    requestedRoute,
    classification.candidates,
    features,
    deps.routing,
    deps.providerRegistry
  );
  const expandedCandidates = extendRouteCandidatesForState(candidates, state, deps.routing);
  const filteredCandidates = filterCandidatesByRoutingState(
    expandedCandidates,
    state,
    deps.routing,
    deps.providerRegistry
  );

  if (filteredCandidates.length === 0) {
    const allowedProviders = Array.from(state.allowedProviders);
    const disabledProviders = Array.from(state.disabledProviders);
    const providersInRouting = new Set<string>();
    for (const pools of Object.values(deps.routing)) {
      if (!Array.isArray(pools)) continue;
      for (const pool of pools) {
        if (!pool || !Array.isArray(pool.targets)) continue;
        for (const key of pool.targets) {
          if (typeof key !== 'string' || !key) continue;
          const providerId = extractProviderId(key);
          if (providerId) {
            providersInRouting.add(providerId);
          }
        }
      }
    }
    const missingAllowedProviders =
      allowedProviders.length > 0 ? allowedProviders.filter((provider) => !providersInRouting.has(provider)) : [];
    const hint = (() => {
      if (missingAllowedProviders.length > 0) {
        return `Allowed providers not present in routing pools: ${missingAllowedProviders.join(', ')}`;
      }
      return 'Routing instructions excluded all route candidates';
    })();
    throw new VirtualRouterError(
      `No available providers after applying routing instructions (${hint}). ` +
        `Tip: remove/adjust <**...**> routing instructions (or use <**clear**>), or add providers/models to routing.`,
      VirtualRouterErrorCode.PROVIDER_NOT_AVAILABLE,
      {
        requestedRoute,
        allowedProviders,
        disabledProviders,
        missingAllowedProviders
      }
    );
  }

  return selectFromCandidates(filteredCandidates, metadata, classification, features, state, deps, {
    allowAliasRotation
  });
}

function stickyProviderMatchesRequestCapabilities(
  providerKey: string,
  requestedRoute: string,
  classification: ClassificationResult,
  features: RoutingFeatures,
  routing: Record<string, RoutePoolTier[]>,
  providerRegistry: SelectionDeps['providerRegistry']
): boolean {
  if (!providerKey) {
    return false;
  }

  if (features.hasImageAttachment) {
    const supportsImageRoute =
      routeTargetsIncludeProvider(routing, 'multimodal', providerKey);
    if (!supportsImageRoute) {
      return false;
    }
    if (!providerSupportsMultimodalRequest(providerKey, features, providerRegistry)) {
      return false;
    }
  }

  if (requestRequiresSearchRoute(requestedRoute, classification, features)) {
    const explicitWebSearchRouteExists = routeHasTargets(routing.web_search);
    const supportsSearchRoute =
      routeTargetsIncludeProvider(routing, 'web_search', providerKey) ||
      routeTargetsIncludeProvider(routing, 'search', providerKey);
    if (supportsSearchRoute) {
      return true;
    }
    const supportsDefaultWebSearchFallback =
      !explicitWebSearchRouteExists &&
      routeTargetsIncludeProvider(routing, DEFAULT_ROUTE, providerKey) &&
      providerRegistry.hasCapability(providerKey, 'web_search');
    if (!supportsDefaultWebSearchFallback) {
      return false;
    }
  }

  return true;
}

function requestRequiresSearchRoute(
  requestedRoute: string,
  classification: ClassificationResult,
  features: RoutingFeatures
): boolean {
  const normalizedRequestedRoute = normalizeRouteAlias(requestedRoute || DEFAULT_ROUTE);
  const normalizedClassifiedRoute = normalizeRouteAlias(classification.routeName || DEFAULT_ROUTE);
  if (normalizedRequestedRoute === 'web_search' || normalizedRequestedRoute === 'search') {
    return true;
  }
  if (normalizedClassifiedRoute === 'web_search' || normalizedClassifiedRoute === 'search') {
    return true;
  }

  const candidates = Array.isArray(classification.candidates) ? classification.candidates : [];
  if (candidates.some((route) => route === 'web_search' || route === 'search')) {
    return true;
  }

  if (features.hasWebSearchToolDeclared === true) {
    return true;
  }

  return (features.metadata as any)?.serverToolRequired === true;
}

function routeTargetsIncludeProvider(
  routing: Record<string, RoutePoolTier[]>,
  routeName: string,
  providerKey: string
): boolean {
  const pools = routing[routeName];
  if (!Array.isArray(pools)) {
    return false;
  }
  for (const pool of pools) {
    if (!Array.isArray(pool.targets)) {
      continue;
    }
    if (pool.targets.includes(providerKey)) {
      return true;
    }
  }
  return false;
}

type RecoverableCooldownSource = 'quota.cooldown' | 'router.cooldown' | 'health.cooldown';

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}


function selectFromCandidates(
  routes: string[],
  metadata: RouterMetadataInput,
  classification: ClassificationResult,
  features: RoutingFeatures,
  state: RoutingInstructionState,
  deps: SelectionDeps,
  options: {
    requiredProviderKeys?: Set<string>;
    allowAliasRotation?: boolean;
  }
): { providerKey: string; routeUsed: string; pool: string[]; poolId?: string } {
  const allowedProviders = new Set(state.allowedProviders);
  const disabledProviders = new Set(state.disabledProviders);
  const excludedProviderKeys = extractExcludedProviderKeySet(features.metadata);
  const disabledKeysMap = new Map<string, Set<string | number>>(
    Array.from(state.disabledKeys.entries()).map(([provider, keys]) => [
      provider,
      new Set(Array.from(keys).map((k) => (typeof k === 'string' ? k : (k as number) + 1)))
    ])
  );
  const disabledModels = new Map<string, Set<string>>(
    Array.from(state.disabledModels.entries()).map(([provider, models]) => [provider, new Set(models)])
  );

  const stickyKey = options.allowAliasRotation ? undefined : deps.resolveStickyKey(metadata);
  const attempted: string[] = [];
  const visitedRoutes = new Set<string>();
  const routeQueue = initializeRouteQueue(routes);
  const healthSnapshotByProviderKey = new Map(
    deps.healthManager.getSnapshot().map((entry) => [entry.providerKey, entry] as const)
  );
  let minRecoverableCooldownMs: number | undefined;
  const recoverableCooldownHints: Array<{ providerKey: string; waitMs: number; source: RecoverableCooldownSource }> = [];
  const recordRecoverableCooldown = (providerKey: string, waitMsRaw: number, source: RecoverableCooldownSource): void => {
    const waitMs = Math.max(1, Math.floor(waitMsRaw));
    if (!isFinitePositiveNumber(waitMs)) {
      return;
    }
    if (!Number.isFinite(minRecoverableCooldownMs as number) || waitMs < (minRecoverableCooldownMs as number)) {
      minRecoverableCooldownMs = waitMs;
    }
    const existing = recoverableCooldownHints.find((item) => item.providerKey === providerKey && item.source === source);
    if (!existing) {
      recoverableCooldownHints.push({ providerKey, waitMs, source });
      return;
    }
    if (waitMs < existing.waitMs) {
      existing.waitMs = waitMs;
    }
  };
  const collectRecoverableCooldownForKey = (providerKey: string): void => {
    const nowMs = Date.now();
    if (deps.quotaView) {
      const entry = deps.quotaView(providerKey);
      if (!entry) {
        return;
      }
      if (isFinitePositiveNumber(entry.blacklistUntil) && entry.blacklistUntil > nowMs) {
        return;
      }
      if (isFinitePositiveNumber(entry.cooldownUntil) && entry.cooldownUntil > nowMs) {
        recordRecoverableCooldown(providerKey, entry.cooldownUntil - nowMs, 'quota.cooldown');
      }
      return;
    }
    if (typeof deps.getProviderCooldownRemainingMs === 'function') {
      const localCooldownMs = deps.getProviderCooldownRemainingMs(providerKey);
      if (isFinitePositiveNumber(localCooldownMs)) {
        recordRecoverableCooldown(providerKey, localCooldownMs, 'router.cooldown');
      }
    }
    const healthState = healthSnapshotByProviderKey.get(providerKey);
    if (healthState && isFinitePositiveNumber(healthState.cooldownExpiresAt) && healthState.cooldownExpiresAt > nowMs) {
      recordRecoverableCooldown(providerKey, healthState.cooldownExpiresAt - nowMs, 'health.cooldown');
    }
  };
  const isEligibleTargetForCurrentAttempt = (providerKey: string): boolean => {
    if (!providerKey || excludedProviderKeys.has(providerKey)) {
      return false;
    }
    if (options.requiredProviderKeys && options.requiredProviderKeys.size > 0 && !options.requiredProviderKeys.has(providerKey)) {
      return false;
    }
    const providerId = extractProviderId(providerKey);
    if (!providerId) {
      return false;
    }
    if (allowedProviders.size > 0 && !allowedProviders.has(providerId)) {
      return false;
    }
    if (disabledProviders.has(providerId)) {
      return false;
    }
    const disabledKeys = disabledKeysMap.get(providerId);
    if (disabledKeys && disabledKeys.size > 0) {
      const keyAlias = extractKeyAlias(providerKey);
      const keyIndex = extractKeyIndex(providerKey);
      if (keyAlias && disabledKeys.has(keyAlias)) {
        return false;
      }
      if (keyIndex !== undefined && disabledKeys.has(keyIndex + 1)) {
        return false;
      }
    }
    const disabledModelSet = disabledModels.get(providerId);
    if (disabledModelSet && disabledModelSet.size > 0) {
      const modelId = getProviderModelId(providerKey, deps.providerRegistry);
      if (modelId && disabledModelSet.has(modelId)) {
        return false;
      }
    }
    return true;
  };
  const estimatedTokens =
    typeof features.estimatedTokens === 'number' && Number.isFinite(features.estimatedTokens)
      ? Math.max(0, features.estimatedTokens)
      : 0;
  const webSearchRouteRequested = isWebSearchRouteRequested(classification.routeName, classification);
  const multimodalRouteRequested = isMultimodalRouteRequested(classification.routeName, classification, features);
  const defaultWebSearchPools = filterPoolsByCapability(
    deps.routing[DEFAULT_ROUTE],
    ['web_search'],
    deps.providerRegistry
  );
  const defaultMultimodalPools = filterPoolsByCapability(
    deps.routing[DEFAULT_ROUTE],
    ['multimodal', 'vision'],
    deps.providerRegistry
  );
  const hasDefaultWebSearchFallback = routeHasTargets(defaultWebSearchPools);
  const hasDefaultMultimodalFallback = routeHasTargets(defaultMultimodalPools);

  while (routeQueue.length) {
    const routeName = routeQueue.shift()!;
    if (visitedRoutes.has(routeName)) {
      continue;
    }
    let routePools =
      webSearchRouteRequested && routeName === DEFAULT_ROUTE && hasDefaultWebSearchFallback
        ? defaultWebSearchPools
        : multimodalRouteRequested && routeName === DEFAULT_ROUTE && hasDefaultMultimodalFallback
          ? defaultMultimodalPools
        : deps.routing[routeName];
    if (webSearchRouteRequested && (routeName === 'web_search' || routeName === DEFAULT_ROUTE)) {
      const capabilityFiltered = filterPoolsByCapability(
        routePools,
        ['web_search'],
        deps.providerRegistry
      );
      if (routeHasTargets(capabilityFiltered)) {
        routePools = capabilityFiltered;
      }
    }
    if (multimodalRouteRequested && (routeName === 'multimodal' || routeName === 'vision' || routeName === DEFAULT_ROUTE)) {
      const capabilityFiltered = filterPoolsByCapability(
        routePools,
        ['multimodal', 'vision'],
        deps.providerRegistry
      );
      if (routeHasTargets(capabilityFiltered)) {
        routePools = capabilityFiltered;
      }
    }
    if (!routeHasTargets(routePools)) {
      visitedRoutes.add(routeName);
      attempted.push(`${routeName}:empty`);
      continue;
    }

    visitedRoutes.add(routeName);
    const orderedPools = sortRoutePools(routePools);
    for (const poolTier of orderedPools) {
      const { providerKey, poolTargets, tierId, failureHint } = trySelectFromTier(
        routeName,
        poolTier,
        stickyKey,
        estimatedTokens,
        features,
        deps,
        {
          disabledProviders,
          disabledKeysMap,
          allowedProviders,
          disabledModels,
          requiredProviderKeys: options.requiredProviderKeys,
          allowAliasRotation: options.allowAliasRotation
        }
      );
      if (providerKey) {
        return { providerKey, routeUsed: routeName, pool: poolTargets, poolId: tierId };
      }
      if (failureHint) {
        attempted.push(failureHint);
      }
      if (Array.isArray(poolTier.targets) && poolTier.targets.length > 0) {
        for (const providerKey of poolTier.targets) {
          if (!isEligibleTargetForCurrentAttempt(providerKey)) {
            continue;
          }
          collectRecoverableCooldownForKey(providerKey);
        }
      }
    }
  }

  const requestedRoute = normalizeRouteAlias(classification.routeName || DEFAULT_ROUTE);
  const details: Record<string, unknown> = { routeName: requestedRoute, attempted };
  if (isFinitePositiveNumber(minRecoverableCooldownMs)) {
    details.minRecoverableCooldownMs = Math.floor(minRecoverableCooldownMs);
    details.recoverableCooldownHints = recoverableCooldownHints
      .sort((a, b) => a.waitMs - b.waitMs)
      .slice(0, 8);
  }

  throw new VirtualRouterError(
    `All providers unavailable for route ${requestedRoute}`,
    VirtualRouterErrorCode.PROVIDER_NOT_AVAILABLE,
    details
  );
}

function filterPoolsByCapability(
  pools: RoutePoolTier[] | undefined,
  capabilities: Array<ModelCapability | 'vision'>,
  providerRegistry: SelectionDeps['providerRegistry']
): RoutePoolTier[] {
  const expected = Array.from(new Set(capabilities.filter(Boolean)));
  if (expected.length === 0) {
    return [];
  }
  if (!Array.isArray(pools)) {
    return [];
  }
  const filtered: RoutePoolTier[] = [];
  for (const pool of pools) {
    if (!Array.isArray(pool.targets) || pool.targets.length === 0) {
      continue;
    }
    const targets = pool.targets.filter((providerKey) =>
      expected.some((capability) => {
        if (capability === 'vision') {
          return (
            providerRegistry.hasCapability(providerKey, 'multimodal') ||
            providerRegistry.hasCapability(providerKey, capability as unknown as ModelCapability)
          );
        }
        return providerRegistry.hasCapability(providerKey, capability);
      })
    );
    if (!targets.length) {
      continue;
    }
    filtered.push({
      ...pool,
      targets
    });
  }
  return filtered;
}

function isWebSearchRouteRequested(
  requestedRoute: string,
  classification: ClassificationResult
): boolean {
  return (
    normalizeRouteAlias(requestedRoute || DEFAULT_ROUTE) === 'web_search' ||
    normalizeRouteAlias(classification.routeName || DEFAULT_ROUTE) === 'web_search'
  );
}

function isMultimodalRouteRequested(
  requestedRoute: string,
  classification: ClassificationResult,
  features: RoutingFeatures
): boolean {
  if (features.hasImageAttachment !== true) {
    return false;
  }
  const normalizedRequestedRoute = normalizeRouteAlias(requestedRoute || DEFAULT_ROUTE);
  const normalizedClassifiedRoute = normalizeRouteAlias(classification.routeName || DEFAULT_ROUTE);
  if (normalizedRequestedRoute === 'multimodal' || normalizedRequestedRoute === 'vision') {
    return true;
  }
  if (normalizedClassifiedRoute === 'multimodal' || normalizedClassifiedRoute === 'vision') {
    return true;
  }
  const candidates = Array.isArray(classification.candidates) ? classification.candidates : [];
  if (candidates.some((route) => route === 'multimodal' || route === 'vision')) {
    return true;
  }
  return true;
}
