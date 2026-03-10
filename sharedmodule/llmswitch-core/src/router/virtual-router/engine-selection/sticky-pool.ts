import type { RoutePoolTier, RouterMetadataInput, RoutingFeatures } from '../types.js';
import type { RoutingInstructionState } from '../routing-instructions.js';
import type { SelectionDeps } from './selection-deps.js';
import { trySelectFromTier } from './tier-selection.js';
import { extractKeyAlias, extractKeyIndex, extractProviderId, getProviderModelId } from './key-parsing.js';

export function selectFromStickyPool(
  stickyKeySet: Set<string>,
  metadata: RouterMetadataInput,
  features: RoutingFeatures,
  state: RoutingInstructionState,
  deps: SelectionDeps,
  options: {
    allowAliasRotation?: boolean;
  }
): { providerKey: string; routeUsed: string; pool: string[]; poolId?: string } | null {
  if (!stickyKeySet || stickyKeySet.size === 0) {
    return null;
  }

  const allowedProviders = new Set(state.allowedProviders);
  const disabledProviders = new Set(state.disabledProviders);
  const disabledKeysMap = new Map<string, Set<string | number>>(
    Array.from(state.disabledKeys.entries()).map(([provider, keys]) => [
      provider,
      new Set(Array.from(keys).map((k) => (typeof k === 'string' ? k : (k as number) + 1)))
    ])
  );
  const disabledModels = new Map<string, Set<string>>(
    Array.from(state.disabledModels.entries()).map(([provider, models]) => [provider, new Set(models)])
  );

  let candidates = Array.from(stickyKeySet).filter((key) => !deps.isProviderCoolingDown(key));
  if (!candidates.length && stickyKeySet.size === 1) {
    candidates = Array.from(stickyKeySet);
  }

  const quotaView = deps.quotaView;
  const now = quotaView ? Date.now() : 0;
  if (quotaView) {
    const filtered = candidates.filter((key) => {
      const entry = quotaView(key);
      if (!entry) {
        return true;
      }
      if (!entry.inPool) {
        return false;
      }
      if (entry.cooldownUntil && entry.cooldownUntil > now) {
        return false;
      }
      if (entry.blacklistUntil && entry.blacklistUntil > now) {
        return false;
      }
      return true;
    });
    if (filtered.length > 0 || candidates.length !== 1) {
      candidates = filtered;
    }
  }

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
        const modelId = getProviderModelId(key, deps.providerRegistry);
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

  const stickyKey = options.allowAliasRotation ? undefined : deps.resolveStickyKey(metadata);
  const estimatedTokens =
    typeof features.estimatedTokens === 'number' && Number.isFinite(features.estimatedTokens)
      ? Math.max(0, features.estimatedTokens)
      : 0;

  const tier: RoutePoolTier = {
    id: 'sticky-primary',
    targets: candidates,
    priority: 0
  };

  const { providerKey, poolTargets, tierId } = trySelectFromTier(
    'sticky',
    tier,
    stickyKey,
    estimatedTokens,
    features,
    deps,
    {
      disabledProviders,
      disabledKeysMap,
      allowedProviders,
      disabledModels,
      requiredProviderKeys: stickyKeySet,
      allowAliasRotation: options.allowAliasRotation
    }
  );

  if (!providerKey) {
    return null;
  }

  return {
    providerKey,
    routeUsed: 'sticky',
    pool: poolTargets,
    poolId: tierId
  };
}

