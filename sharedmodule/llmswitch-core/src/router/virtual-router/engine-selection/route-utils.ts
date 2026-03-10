import { DEFAULT_ROUTE, ROUTE_PRIORITY, type RoutePoolTier, type RoutingFeatures } from '../types.js';
import type { ProviderRegistry } from '../provider-registry.js';

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
  const forceVision = routeHasForceFlag('vision', routing);
  const hasMultimodalTargets = routeHasTargets(routing.multimodal);
  const hasVisionTargets = routeHasTargets(routing.vision);
  const hasLocalVideoAttachment = features.hasVideoAttachment === true && features.hasLocalVideoAttachment === true;
  if (features.hasImageAttachment && hasLocalVideoAttachment && hasVisionTargets) {
    return ['vision'];
  }
  const normalized = normalizeRouteAlias(requestedRoute || DEFAULT_ROUTE);
  const baseList: string[] = [];
  if (classificationCandidates && classificationCandidates.length) {
    for (const candidate of classificationCandidates) {
      baseList.push(normalizeRouteAlias(candidate));
    }
  } else if (normalized) {
    baseList.push(normalized);
  }

  if (features.hasImageAttachment) {
    if (hasMultimodalTargets) {
      if (!baseList.includes('multimodal')) {
        baseList.unshift('multimodal');
      }
    }

    if (hasVisionTargets && (!hasMultimodalTargets || forceVision)) {
      if (!baseList.includes('vision')) {
        baseList.push('vision');
      }
    }

    if (!forceVision && hasMultimodalTargets) {
      const visionAwareRoutes = [DEFAULT_ROUTE, 'thinking'] as const;
      for (const routeName of visionAwareRoutes) {
        if (routeHasTargets(routing[routeName])) {
          if (!baseList.includes(routeName)) {
            baseList.push(routeName);
          }
        }
      }
    }
  }

  let ordered = sortByPriority(baseList);

  if (features.hasImageAttachment && !forceVision && hasMultimodalTargets) {
    ordered = reorderForInlineVision(ordered, routing, providerRegistry);
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

function reorderForInlineVision(
  routeNames: string[],
  routing: Record<string, RoutePoolTier[]>,
  providerRegistry: ProviderRegistry
): string[] {
  const unique = Array.from(new Set(routeNames.filter(Boolean)));
  if (!unique.length) {
    return unique;
  }

  const inlinePreferred: string[] = [];
  const inlineRoutes = [DEFAULT_ROUTE, 'thinking'] as const;

  for (const routeName of inlineRoutes) {
    if (routeSupportsInlineVision(routeName, routing, providerRegistry) && !inlinePreferred.includes(routeName)) {
      inlinePreferred.push(routeName);
    }
  }

  if (!inlinePreferred.length) {
    return unique;
  }

  const remaining: string[] = [];
  for (const routeName of unique) {
    if (!inlinePreferred.includes(routeName)) {
      remaining.push(routeName);
    }
  }
  return [...inlinePreferred, ...remaining];
}

function routeSupportsInlineVision(
  routeName: string,
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
        const profile = providerRegistry.get(providerKey);
        if (profile.providerType === 'responses' || profile.providerType === 'gemini') {
          return true;
        }
      } catch {
        // ignore unknown providers when probing capabilities
      }
    }
  }
  return false;
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
