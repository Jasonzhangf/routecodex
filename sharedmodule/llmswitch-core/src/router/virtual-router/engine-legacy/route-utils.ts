import type { RoutePoolTier } from '../types.js';
import type { VirtualRouterEngine } from '../engine-legacy.js';
import { DEFAULT_ROUTE, ROUTE_PRIORITY } from '../types.js';

export function normalizeRouteAlias(routeName: string | undefined): string {
  const base = routeName && routeName.trim() ? routeName.trim() : DEFAULT_ROUTE;
  return base;
}

export function buildRouteCandidates(
  engine: VirtualRouterEngine,
  requestedRoute: string,
  classificationCandidates: string[] | undefined,
  features: { hasImageAttachment?: boolean; hasVideoAttachment?: boolean; hasLocalVideoAttachment?: boolean }
): string[] {
  const forceVision = routeHasForceFlag(engine, 'vision');
  const hasMultimodalTargets = routeHasTargets(engine, engine.routing.multimodal);
  const hasVisionTargets = routeHasTargets(engine, engine.routing.vision);
  const hasLocalVideoAttachment =
    features.hasVideoAttachment === true && features.hasLocalVideoAttachment === true;
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
        if (routeHasTargets(engine, engine.routing[routeName]) && !baseList.includes(routeName)) {
          baseList.push(routeName);
        }
      }
    }
  }

  let ordered = sortByPriority(baseList);

  if (features.hasImageAttachment && !forceVision && hasMultimodalTargets) {
    ordered = reorderForInlineVision(engine, ordered);
  }
  if (features.hasImageAttachment && hasMultimodalTargets) {
    ordered = reorderForPreferredModel(engine, ordered, 'kimi-k2.5');
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
  const filtered = deduped.filter((routeName) => routeHasTargets(engine, engine.routing[routeName]));
  if (!filtered.includes(DEFAULT_ROUTE) && routeHasTargets(engine, engine.routing[DEFAULT_ROUTE])) {
    filtered.push(DEFAULT_ROUTE);
  }
  return filtered.length ? filtered : [DEFAULT_ROUTE];
}

export function reorderForInlineVision(engine: VirtualRouterEngine, routeNames: string[]): string[] {
  const unique = Array.from(new Set(routeNames.filter(Boolean)));
  if (!unique.length) {
    return unique;
  }

  // 仅当 default/thinking 中存在 Responses/Gemini 提供方时，才将其提前作为「一次完成」优先级。
  const inlinePreferred: string[] = [];
  const inlineRoutes = [DEFAULT_ROUTE, 'thinking'] as const;

  for (const routeName of inlineRoutes) {
    if (routeSupportsInlineVision(engine, routeName) && !inlinePreferred.includes(routeName)) {
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

export function reorderForPreferredModel(
  engine: VirtualRouterEngine,
  routeNames: string[],
  modelId: string
): string[] {
  const unique = Array.from(new Set(routeNames.filter(Boolean)));
  if (!unique.length) {
    return unique;
  }
  const preferred = unique.filter((routeName) => routeSupportsModel(engine, routeName, modelId));
  if (!preferred.length) {
    return unique;
  }
  const remaining = unique.filter((routeName) => !preferred.includes(routeName));
  return [...preferred, ...remaining];
}

export function routeSupportsModel(engine: VirtualRouterEngine, routeName: string, modelId: string): boolean {
  const normalizedModel = modelId.trim().toLowerCase();
  if (!normalizedModel) {
    return false;
  }
  const pools = engine.routing[routeName];
  if (!Array.isArray(pools)) {
    return false;
  }
  for (const pool of pools) {
    if (!Array.isArray(pool.targets)) {
      continue;
    }
    for (const providerKey of pool.targets) {
      try {
        const profile = engine.providerRegistry.get(providerKey);
        const candidate = typeof profile.modelId === 'string' ? profile.modelId.trim().toLowerCase() : '';
        if (candidate === normalizedModel) {
          return true;
        }
      } catch {
        // ignore unknown provider keys during capability probing
      }
    }
  }
  return false;
}

export function routeSupportsInlineVision(engine: VirtualRouterEngine, routeName: string): boolean {
  const pools = engine.routing[routeName];
  if (!Array.isArray(pools)) {
    return false;
  }
  for (const pool of pools) {
    if (!Array.isArray(pool.targets)) {
      continue;
    }
    for (const providerKey of pool.targets) {
      try {
        const profile = engine.providerRegistry.get(providerKey);
        if (profile.providerType === 'responses' || profile.providerType === 'gemini') {
          return true;
        }
      } catch {
        // ignore unknown provider keys during capability probing
      }
    }
  }
  return false;
}

export function sortByPriority(routeNames: string[]): string[] {
  return [...routeNames].sort((a, b) => routeWeight(a) - routeWeight(b));
}

export function routeWeight(routeName: string): number {
  const idx = ROUTE_PRIORITY.indexOf(routeName);
  return idx >= 0 ? idx : ROUTE_PRIORITY.length;
}

export function routeHasForceFlag(engine: VirtualRouterEngine, routeName: string): boolean {
  const pools = engine.routing[routeName];
  if (!Array.isArray(pools)) {
    return false;
  }
  return pools.some((pool) => pool.force);
}

export function routeHasTargets(engine: VirtualRouterEngine, pools?: RoutePoolTier[]): boolean {
  if (!Array.isArray(pools)) {
    return false;
  }
  return pools.some((pool) => Array.isArray(pool.targets) && pool.targets.length > 0);
}

export function hasPrimaryPool(engine: VirtualRouterEngine, pools?: RoutePoolTier[]): boolean {
  if (!Array.isArray(pools)) {
    return false;
  }
  return pools.some((pool) => !pool.backup && Array.isArray(pool.targets) && pool.targets.length > 0);
}

export function sortRoutePools(_engine: VirtualRouterEngine, pools?: RoutePoolTier[]): RoutePoolTier[] {
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

export function flattenPoolTargets(_engine: VirtualRouterEngine, pools?: RoutePoolTier[]): string[] {
  const flattened: string[] = [];
  if (!Array.isArray(pools)) {
    return flattened;
  }
  for (const pool of pools) {
    if (!Array.isArray(pool.targets)) {
      continue;
    }
    for (const target of pool.targets) {
      if (typeof target === 'string' && target && !flattened.includes(target)) {
        flattened.push(target);
      }
    }
  }
  return flattened;
}
