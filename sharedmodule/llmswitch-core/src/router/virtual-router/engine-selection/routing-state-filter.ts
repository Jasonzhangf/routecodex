import type { RoutePoolTier } from '../types.js';
import type { RoutingInstructionState } from '../routing-instructions.js';
import type { ProviderRegistry } from '../provider-registry.js';
import { extractKeyAlias, extractKeyIndex, extractProviderId, getProviderModelId } from './key-parsing.js';

export function filterCandidatesByRoutingState(
  routes: string[],
  state: RoutingInstructionState,
  routing: Record<string, RoutePoolTier[]>,
  providerRegistry: ProviderRegistry
): string[] {
  if (
    state.allowedProviders.size === 0 &&
    state.disabledProviders.size === 0 &&
    state.disabledKeys.size === 0 &&
    state.disabledModels.size === 0
  ) {
    return routes;
  }

  return routes.filter((routeName) => {
    const pools = routing[routeName];
    if (!pools) return false;

    for (const pool of pools) {
      if (!Array.isArray(pool.targets) || pool.targets.length === 0) {
        continue;
      }

      for (const providerKey of pool.targets) {
        const providerId = extractProviderId(providerKey);
        if (!providerId) continue;

        if (state.allowedProviders.size > 0 && !state.allowedProviders.has(providerId)) {
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
          const modelId = getProviderModelId(providerKey, providerRegistry);
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

