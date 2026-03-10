import type { ClassificationResult, RouterMetadataInput, RoutingFeatures } from '../types.js';
import type { RoutingInstructionState } from '../routing-instructions.js';
import type { VirtualRouterEngine } from '../engine-legacy.js';
import { DEFAULT_ROUTE } from '../types.js';
import { getRoutingInstructionState } from '../engine/routing-state/store.js';
import { selectProviderImpl } from '../engine/routing-pools/index.js';
import { extractKeyAlias, extractKeyIndex, extractProviderId, getProviderModelId } from '../engine/provider-key/parse.js';

export function selectProvider(
  engine: VirtualRouterEngine,
  requestedRoute: string,
  metadata: RouterMetadataInput,
  classification: ClassificationResult,
  features: RoutingFeatures,
  routingState?: RoutingInstructionState
): { providerKey: string; routeUsed: string; pool: string[]; poolId?: string } {
  const activeState =
    routingState ||
    getRoutingInstructionState(
      engine.resolveStickyKey(metadata),
      engine.routingInstructionState,
      engine.routingStateStore
    );
  return selectProviderImpl(
    requestedRoute,
    metadata,
    classification,
    features,
    activeState as RoutingInstructionState,
    {
      routing: engine.routing,
      providerRegistry: engine.providerRegistry,
      healthManager: engine.healthManager,
      contextAdvisor: engine.contextAdvisor,
      loadBalancer: engine.loadBalancer,
      isProviderCoolingDown: (key) => engine.isProviderCoolingDown(key),
      getProviderCooldownRemainingMs: (key) => engine.getProviderCooldownRemainingMs(key),
      resolveStickyKey: (m) => engine.resolveStickyKey(m),
      quotaView: engine.quotaView,
      aliasQueueStore: engine.stickySessionManager.getAllStores().aliasQueueStore,
      antigravityAliasLeaseStore: engine.stickySessionManager.getAllStores().aliasLeaseStore,
      antigravitySessionAliasStore: engine.stickySessionManager.getAllStores().sessionAliasStore,
      antigravityAliasReuseCooldownMs: engine.stickySessionManager.getAliasReuseCooldownMs()
    },
    { routingState }
  );
}

export function selectFromCandidates(
  engine: VirtualRouterEngine,
  routes: string[],
  metadata: RouterMetadataInput,
  classification: ClassificationResult,
  features: RoutingFeatures,
  state: RoutingInstructionState,
  requiredProviderKeys?: Set<string>,
  allowAliasRotation?: boolean
): { providerKey: string; routeUsed: string; pool: string[]; poolId?: string } {
  // legacy helper kept for backward compatibility; selection logic moved to engine-selection.ts
  return selectProviderImpl(
    engine.normalizeRouteAlias(classification.routeName || DEFAULT_ROUTE),
    metadata,
    classification,
    features,
    state,
    {
      routing: engine.routing,
      providerRegistry: engine.providerRegistry,
      healthManager: engine.healthManager,
      contextAdvisor: engine.contextAdvisor,
      loadBalancer: engine.loadBalancer,
      isProviderCoolingDown: (key) => engine.isProviderCoolingDown(key),
      getProviderCooldownRemainingMs: (key) => engine.getProviderCooldownRemainingMs(key),
      resolveStickyKey: (m) => engine.resolveStickyKey(m),
      quotaView: engine.quotaView,
      aliasQueueStore: engine.stickySessionManager.getAllStores().aliasQueueStore
    },
    { routingState: state }
  );
}

/**
 * 在 sticky 模式下，仅在 sticky 池内选择 Provider：
 * - stickyKeySet 表示已经解析并通过健康检查的 providerKey 集合；
 * - 不再依赖 routing[*].targets 中是否挂载这些 key，避免「未初始化路由池」导致 sticky 池为空；
 * - 仍然尊重 allowed/disabledProviders、disabledKeys、disabledModels 以及上下文长度。
 */
export function selectFromStickyPool(
  engine: VirtualRouterEngine,
  stickyKeySet: Set<string>,
  metadata: RouterMetadataInput,
  features: RoutingFeatures,
  state: RoutingInstructionState,
  allowAliasRotation?: boolean
): { providerKey: string; routeUsed: string; pool: string[]; poolId?: string } | null {
  if (!stickyKeySet || stickyKeySet.size === 0) {
    return null;
  }

  const allowedProviders = new Set(state.allowedProviders);
  const disabledProviders = new Set(state.disabledProviders);
  const disabledKeysMap = new Map(
    Array.from(state.disabledKeys.entries()).map(([provider, keys]) => [
      provider,
      new Set(Array.from(keys).map((k) => (typeof k === 'string' ? k : (k as number) + 1)))
    ])
  );
  const disabledModels = new Map(
    Array.from(state.disabledModels.entries()).map(([provider, models]) => [provider, new Set(models)])
  );

  // 初始候选集合：sticky 池中的所有 key
  // In quota routing mode, cooldown is controlled by quotaView only.
  let candidates = Array.from(stickyKeySet).filter((key) => (engine.quotaView ? true : !engine.isProviderCoolingDown(key)));

  // 应用 provider 白名单 / 黑名单
  if (allowedProviders.size > 0) {
    candidates = candidates.filter((key) => {
      const providerId = extractProviderId(key);
      return providerId && allowedProviders.has(providerId);
    });
  }
  if (disabledProviders.size > 0) {
    candidates = candidates.filter((key) => {
      const providerId = extractProviderId(key);
      return providerId && !disabledProviders.has(providerId);
    });
  }

  // 应用 key / model 级别黑名单
  if (disabledKeysMap.size > 0 || disabledModels.size > 0) {
    candidates = candidates.filter((key) => {
      const providerId = extractProviderId(key);
      if (!providerId) {
        return true;
      }

      const disabledKeys = disabledKeysMap.get(providerId);
      if (disabledKeys && disabledKeys.size > 0) {
        const keyAlias = extractKeyAlias(key);
        const keyIndex = extractKeyIndex(key);

        if (keyAlias && disabledKeys.has(keyAlias)) {
          return false;
        }
        if (keyIndex !== undefined && disabledKeys.has(keyIndex + 1)) {
          return false;
        }
      }

      const disabledModelSet = disabledModels.get(providerId);
      if (disabledModelSet && disabledModelSet.size > 0) {
        const modelId = getProviderModelId(key, engine.providerRegistry);
        if (modelId && disabledModelSet.has(modelId)) {
          return false;
        }
      }

      return true;
    });
  }

  if (!candidates.length) {
    return null;
  }

  const stickyKey = allowAliasRotation ? undefined : engine.resolveStickyKey(metadata);
  const estimatedTokens =
    typeof features.estimatedTokens === 'number' && Number.isFinite(features.estimatedTokens)
      ? Math.max(0, features.estimatedTokens)
      : 0;

  // delegate to selection module
  return null;
}

export function extractExcludedProviderKeySet(engine: VirtualRouterEngine, metadata: RouterMetadataInput | undefined): Set<string> {
  return engine.routeAnalytics.extractExcludedProviderKeySet(metadata);
}
