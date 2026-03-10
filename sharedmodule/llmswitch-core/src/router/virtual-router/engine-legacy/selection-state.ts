import type { RoutingInstructionState } from '../routing-instructions.js';
import type { VirtualRouterEngine } from '../engine-legacy.js';
import { DEFAULT_ROUTE } from '../types.js';
import { extractKeyAlias, extractKeyIndex, extractProviderId, getProviderModelId } from '../engine/provider-key/parse.js';
import { routeHasTargets, sortByPriority, flattenPoolTargets } from './route-utils.js';

export function resolveSelectionPenalty(
  engine: VirtualRouterEngine,
  providerKey: string
): number | undefined {
  if (!engine.quotaView) {
    return undefined;
  }
  try {
    const entry = engine.quotaView(providerKey);
    const raw = entry?.selectionPenalty;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
      return undefined;
    }
    return Math.floor(raw);
  } catch {
    return undefined;
  }
}

export function resolveInstructionProcessModeForSelection(
  engine: VirtualRouterEngine,
  providerKey: string,
  routingState: RoutingInstructionState
): 'chat' | 'passthrough' | undefined {
  const candidates: Array<NonNullable<RoutingInstructionState['forcedTarget']> | undefined> = [
    routingState.forcedTarget,
    routingState.stickyTarget as NonNullable<RoutingInstructionState['forcedTarget']> | undefined,
    routingState.preferTarget as NonNullable<RoutingInstructionState['forcedTarget']> | undefined
  ];

  for (const candidate of candidates) {
    const processMode = candidate?.processMode;
    if (!processMode) {
      continue;
    }
    const resolved = resolveInstructionTarget(engine, candidate);
    if (!resolved) {
      continue;
    }
    if (resolved.keys.includes(providerKey)) {
      return processMode;
    }
  }

  return undefined;
}

export function resolveInstructionTarget(
  engine: VirtualRouterEngine,
  target: NonNullable<RoutingInstructionState['forcedTarget']>
): { mode: 'exact' | 'filter'; keys: string[] } | null {
  if (!target || !target.provider) {
    return null;
  }
  const providerId = target.provider;
  const providerKeys = engine.providerRegistry.listProviderKeys(providerId);
  if (providerKeys.length === 0) {
    return null;
  }

  const alias = typeof target.keyAlias === 'string' ? target.keyAlias.trim() : '';
  const aliasExplicit = alias.length > 0 && target.pathLength === 3;
  if (aliasExplicit) {
    const runtimeKey = engine.providerRegistry.resolveRuntimeKeyByAlias(providerId, alias);
    if (runtimeKey) {
      return { mode: 'exact', keys: [runtimeKey] };
    }
  }

  if (typeof target.keyIndex === 'number' && target.keyIndex > 0) {
    const runtimeKey = engine.providerRegistry.resolveRuntimeKeyByIndex(providerId, target.keyIndex);
    if (runtimeKey) {
      return { mode: 'exact', keys: [runtimeKey] };
    }
  }

  if (target.model && target.model.trim()) {
    const normalizedModel = target.model.trim();
    const matchingKeys = providerKeys.filter((key) => {
      const modelId = getProviderModelId(key, engine.providerRegistry);
      return modelId === normalizedModel;
    });
    if (matchingKeys.length > 0) {
      return { mode: 'filter', keys: matchingKeys };
    }
  }

  if (alias && !aliasExplicit) {
    const legacyKey = engine.providerRegistry.resolveRuntimeKeyByAlias(providerId, alias);
    if (legacyKey) {
      return { mode: 'exact', keys: [legacyKey] };
    }
  }

  return { mode: 'filter', keys: providerKeys };
}

export function filterCandidatesByRoutingState(
  engine: VirtualRouterEngine,
  routes: string[],
  state: RoutingInstructionState
): string[] {
  // console.log('[filter] routes:', routes, 'state:', {
  //   allowed: Array.from(state.allowedProviders),
  //   disabled: Array.from(state.disabledProviders)
  // });
  if (
    state.allowedProviders.size === 0 &&
    state.disabledProviders.size === 0 &&
    state.disabledKeys.size === 0 &&
    state.disabledModels.size === 0
  ) {
    return routes;
  }

  return routes.filter((routeName) => {
    const pools = engine.routing[routeName];
    if (!pools) return false;

    for (const pool of pools) {
      if (!Array.isArray(pool.targets) || pool.targets.length === 0) {
        continue;
      }

      for (const providerKey of pool.targets) {
        const providerId = extractProviderId(providerKey);
        // console.log('[filter] checking', providerKey, 'id=', providerId);
        if (!providerId) continue;

        if (state.allowedProviders.size > 0 && !state.allowedProviders.has(providerId)) {
          // console.log('[filter] dropped by allowed list');
          continue;
        }

        if (state.disabledProviders.has(providerId)) {
          continue;
        }

        const disabledKeys = state.disabledKeys.get(providerId);
        if (disabledKeys && disabledKeys.size > 0) {
          const keyAlias = extractKeyAlias(providerKey);
          const keyIndex = extractKeyIndex(providerKey);

          if (keyAlias && disabledKeys.has(keyAlias)) {
            continue;
          }

          if (keyIndex !== undefined && disabledKeys.has(keyIndex + 1)) {
            continue;
          }
        }

        const disabledModels = state.disabledModels.get(providerId);
        if (disabledModels && disabledModels.size > 0) {
          const modelId = getProviderModelId(providerKey, engine.providerRegistry);
          if (modelId && disabledModels.has(modelId)) {
            continue;
          }
        }

        return true;
      }
    }

    return false;
  });
}

/**
 * 在已有候选路由集合上，筛选出真正挂载了 sticky 池内 providerKey 的路由，
 * 并按 ROUTE_PRIORITY 进行排序；同时显式排除 tools 路由，保证一旦进入
 * sticky 模式，就不会再命中独立的 tools 池（例如 glm/qwen 工具模型）。
 * 若候选集合中完全没有挂载 sticky key 的路由，则尝试在 default 路由上兜底。
 */
export function buildStickyRouteCandidatesFromFiltered(
  engine: VirtualRouterEngine,
  filteredCandidates: string[],
  stickyKeySet: Set<string>
): string[] {
  const routesWithSticky: string[] = [];
  const candidateSet = new Set(filteredCandidates.filter((name) => name && name !== 'tools'));

  for (const routeName of candidateSet) {
    const pools = engine.routing[routeName];
    if (!routeHasTargets(engine, pools)) {
      continue;
    }
    const targets = flattenPoolTargets(engine, pools);
    if (!targets.some((key) => stickyKeySet.has(key))) {
      continue;
    }
    routesWithSticky.push(routeName);
  }

  // 若当前候选路由中没有任何挂载 sticky key 的路由，尝试直接在 default 路由上兜底；
  // 若 default 也不包含 sticky key，则视为 sticky 配置失效，由调用方回落到非 sticky 逻辑。
  if (routesWithSticky.length === 0) {
    const defaultPools = engine.routing[DEFAULT_ROUTE];
    if (routeHasTargets(engine, defaultPools)) {
      const targets = flattenPoolTargets(engine, defaultPools);
      if (targets.some((key) => stickyKeySet.has(key))) {
        return [DEFAULT_ROUTE];
      }
    }
    return [];
  }

  const ordered = sortByPriority(routesWithSticky);
  const result: string[] = [];
  let hasDefault = false;

  for (const routeName of ordered) {
    if (routeName === DEFAULT_ROUTE) {
      hasDefault = true;
      continue;
    }
    if (!result.includes(routeName)) {
      result.push(routeName);
    }
  }

  // default 路由若包含 sticky key，则始终放在候选列表最后，用于 sticky 模式兜底。
  if (hasDefault && !result.includes(DEFAULT_ROUTE)) {
    result.push(DEFAULT_ROUTE);
  }

  return result;
}

// Intentionally no extra exports here; keep this module focused on state filtering.
