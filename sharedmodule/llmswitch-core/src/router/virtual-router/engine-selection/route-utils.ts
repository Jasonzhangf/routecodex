import { DEFAULT_ROUTE, ROUTE_PRIORITY, type RoutePoolTier, type RoutingFeatures, type ModelCapability } from '../types.js';
import type { ProviderRegistry } from '../provider-registry.js';

export function routeSupportsCapability(
  routeName: string,
  capability: ModelCapability,
  routing: Record<string, RoutePoolTier[]>,
  providerRegistry: ProviderRegistry
): boolean {
  const pools = routing[routeName];
  if (!Array.isArray(pools)) {
    return false;
  }
  for (const pool of pools) {
    if (!Array.isArray(pool.targets)) {
      continue;
    }
    for (const providerKey of pool.targets) {
      try {
        if (providerRegistry.hasCapability(providerKey, capability)) {
          return true;
        }
      } catch {
        // ignore unknown providers when probing capabilities
      }
    }
  }
  return false;
}

export function filterRoutesByCapability(
  routeNames: string[],
  capability: ModelCapability,
  routing: Record<string, RoutePoolTier[]>,
  providerRegistry: ProviderRegistry
): string[] {
  return routeNames.filter((routeName) =>
    routeSupportsCapability(routeName, capability, routing, providerRegistry)
  );
}

export function reorderForCapability(
  routeNames: string[],
  capability: ModelCapability,
  routing: Record<string, RoutePoolTier[]>,
  providerRegistry: ProviderRegistry
): string[] {
  const unique = Array.from(new Set(routeNames.filter(Boolean)));
  if (!unique.length) {
    return unique;
  }
  const preferred = filterRoutesByCapability(unique, capability, routing, providerRegistry);
  if (!preferred.length) {
    return unique;
  }
  const remaining = unique.filter((routeName) => !preferred.includes(routeName));
  return [...preferred, ...remaining];
}

export function sortByPriority(routeNames: string[]): string[] {
  return [...routeNames].sort((a, b) => routeWeight(a) - routeWeight(b));
}

export function initializeRouteQueue(candidates: string[]): string[] {
  return Array.from(new Set(candidates));
}

export function normalizeRouteAlias(routeName: string | undefined): string {
  const base = routeName && routeName.trim() ? routeName.trim() : DEFAULT_ROUTE;
  return base;
}

export function routeHasForceFlag(routeName: string, routing: Record<string, RoutePoolTier[]>): boolean {
  const pools = routing[routeName];
  if (!Array.isArray(pools)) {
    return false;
  }
  return pools.some((pool) => pool.force);
}

export function routeHasTargets(pools?: RoutePoolTier[]): boolean {
  if (!Array.isArray(pools)) {
    return false;
  }
  return pools.some((pool) => Array.isArray(pool.targets) && pool.targets.length > 0);
}

export function sortRoutePools(pools?: RoutePoolTier[]): RoutePoolTier[] {
  if (!Array.isArray(pools)) {
    return [];
  }
  return pools
    .filter((pool) => Array.isArray(pool.targets) && pool.targets.length > 0)
    .sort((a, b) => {
      if (a.backup && !b.backup) return 1;
      if (!a.backup && b.backup) return -1;
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return a.id.localeCompare(b.id);
    });
}

export function buildRouteCandidates(
  requestedRoute: string,
  classificationCandidates: string[] | undefined,
  features: RoutingFeatures,
  routing: Record<string, RoutePoolTier[]>,
  providerRegistry: ProviderRegistry
): string[] {
  const hasMultimodalTargets = routeHasTargets(routing.multimodal);
  const hasVideoTargets = routeHasTargets(routing.video);
  const hasRemoteVideoAttachment = features.hasVideoAttachment === true && features.hasRemoteVideoAttachment === true;
  const normalized = normalizeRouteAlias(requestedRoute || DEFAULT_ROUTE);
  const baseList: string[] = [];
  if (classificationCandidates && classificationCandidates.length) {
    for (const candidate of classificationCandidates) {
      baseList.push(normalizeRouteAlias(candidate));
    }
  } else if (normalized) {
    baseList.push(normalized);
  }

  if (hasRemoteVideoAttachment && hasVideoTargets) {
    if (!baseList.includes('video')) {
      baseList.unshift('video');
    }
  }

  if (features.hasImageAttachment) {
    if (hasMultimodalTargets) {
      if (!baseList.includes('multimodal')) {
        baseList.unshift('multimodal');
      }
    }

    if (hasMultimodalTargets) {
      const multimodalAwareRoutes = [DEFAULT_ROUTE, 'thinking'] as const;
      for (const routeName of multimodalAwareRoutes) {
        if (routeHasTargets(routing[routeName])) {
          if (!baseList.includes(routeName)) {
            baseList.push(routeName);
          }
        }
      }
    }
  }

  let ordered = sortByPriority(baseList);

  // Reorder by capability for thinking/web_search routes
  if (baseList.includes('thinking')) {
    ordered = reorderForCapability(ordered, 'thinking', routing, providerRegistry);
  }
  if (baseList.includes('web_search')) {
    ordered = reorderForCapability(ordered, 'web_search', routing, providerRegistry);
  }

  if (features.hasImageAttachment && hasMultimodalTargets) {
    ordered = reorderForPreferredModel(ordered, 'kimi-k2.5', routing, providerRegistry);
  }
  const deduped: string[] = [];
  for (const routeName of ordered) {
    if (routeName && !deduped.includes(routeName)) {
      deduped.push(routeName);
    }
  }
  if (!deduped.includes(DEFAULT_ROUTE)) {
    deduped.push(DEFAULT_ROUTE);
  }
  const filtered = deduped.filter((routeName) => routeHasTargets(routing[routeName]));
  if (!filtered.includes(DEFAULT_ROUTE) && routeHasTargets(routing[DEFAULT_ROUTE])) {
    filtered.push(DEFAULT_ROUTE);
  }
  return filtered.length ? filtered : [DEFAULT_ROUTE];
}

export function extendRouteCandidatesForState(
  candidates: string[],
  state: { allowedProviders?: Set<string> },
  routing: Record<string, RoutePoolTier[]>
): string[] {
  // When provider allowlists are active (e.g. "<**!antigravity**>"),
  // only look at the default pool. This keeps sticky semantics scoped
  // to default routing, as required by RouteCodex.
  if (!state.allowedProviders || state.allowedProviders.size === 0) {
    return candidates;
  }
  if (routeHasTargets(routing[DEFAULT_ROUTE])) {
    return [DEFAULT_ROUTE];
  }
  return candidates;
}

function routeWeight(routeName: string): number {
  const idx = ROUTE_PRIORITY.indexOf(routeName);
  return idx >= 0 ? idx : ROUTE_PRIORITY.length;
}

function reorderForPreferredModel(
  routeNames: string[],
  modelId: string,
  routing: Record<string, RoutePoolTier[]>,
  providerRegistry: ProviderRegistry
): string[] {
  const unique = Array.from(new Set(routeNames.filter(Boolean)));
  if (!unique.length) {
    return unique;
  }
  const preferred = unique.filter((routeName) => routeSupportsModel(routeName, modelId, routing, providerRegistry));
  if (!preferred.length) {
    return unique;
  }
  const remaining = unique.filter((routeName) => !preferred.includes(routeName));
  return [...preferred, ...remaining];
}

function routeSupportsModel(
  routeName: string,
  modelId: string,
  routing: Record<string, RoutePoolTier[]>,
  providerRegistry: ProviderRegistry
): boolean {
  const normalizedModel = modelId.trim().toLowerCase();
  if (!normalizedModel) {
    return false;
  }
  const pools = routing[routeName];
  if (!Array.isArray(pools)) {
    return false;
  }
  for (const pool of pools) {
    if (!Array.isArray(pool.targets)) {
      continue;
    }
    for (const providerKey of pool.targets) {
      try {
        const profile = providerRegistry.get(providerKey);
        const candidate = typeof profile.modelId === 'string' ? profile.modelId.trim().toLowerCase() : '';
        if (candidate === normalizedModel) {
          return true;
        }
      } catch {
        // ignore unknown providers when probing capabilities
      }
    }
  }
  return false;
}
