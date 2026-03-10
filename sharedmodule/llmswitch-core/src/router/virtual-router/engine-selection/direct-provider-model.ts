import type { RoutePoolTier, RouterMetadataInput, RoutingFeatures } from '../types.js';
import type { RoutingInstructionState } from '../routing-instructions.js';
import type { SelectionDeps } from './selection-deps.js';
import { trySelectFromTier } from './tier-selection.js';

export function selectDirectProviderModel(
  providerId: string,
  modelId: string,
  metadata: RouterMetadataInput,
  features: RoutingFeatures,
  activeState: RoutingInstructionState,
  deps: SelectionDeps
): { providerKey: string; routeUsed: string; pool: string[]; poolId?: string } | null {
  const normalizedProvider = typeof providerId === 'string' ? providerId.trim() : '';
  const normalizedModel = typeof modelId === 'string' ? modelId.trim() : '';
  if (!normalizedProvider || !normalizedModel) {
    return null;
  }
  const providerKeys = deps.providerRegistry.listProviderKeys(normalizedProvider);
  if (providerKeys.length === 0) {
    return null;
  }

  const matchingKeys = providerKeys.filter((key) => {
    try {
      const profile = deps.providerRegistry.get(key);
      return profile?.modelId === normalizedModel;
    } catch {
      return false;
    }
  });
  if (matchingKeys.length === 0) {
    return null;
  }

  const attempted: string[] = [];
  const estimatedTokens =
    typeof features.estimatedTokens === 'number' && Number.isFinite(features.estimatedTokens)
      ? Math.max(0, features.estimatedTokens)
      : 0;

  const tier: RoutePoolTier = {
    id: `direct:${normalizedProvider}.${normalizedModel}`,
    targets: matchingKeys,
    priority: 100,
    mode: 'round-robin',
    backup: false
  };

  const { providerKey, poolTargets, tierId, failureHint } = trySelectFromTier(
    'direct',
    tier,
    undefined,
    estimatedTokens,
    features,
    deps,
    {
      disabledProviders: new Set(activeState.disabledProviders),
      disabledKeysMap: new Map(activeState.disabledKeys),
      allowedProviders: new Set(activeState.allowedProviders),
      disabledModels: new Map(activeState.disabledModels),
      allowAliasRotation: true
    }
  );
  if (providerKey) {
    return { providerKey, routeUsed: 'direct', pool: poolTargets, poolId: tierId };
  }
  if (failureHint) {
    attempted.push(failureHint);
  }
  return null;
}

