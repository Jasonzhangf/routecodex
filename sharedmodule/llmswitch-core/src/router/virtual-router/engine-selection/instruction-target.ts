import type { RoutingInstructionState } from '../routing-instructions.js';
import type { ProviderRegistry } from '../provider-registry.js';
import { getProviderModelId } from './key-parsing.js';

export function resolveInstructionTarget(
  target: NonNullable<RoutingInstructionState['forcedTarget']>,
  providerRegistry: ProviderRegistry
): { mode: 'exact' | 'filter'; keys: string[] } | null {
  if (!target || !target.provider) {
    return null;
  }
  const providerId = target.provider;
  const providerKeys = providerRegistry.listProviderKeys(providerId);
  if (providerKeys.length === 0) {
    return null;
  }

  const alias = typeof target.keyAlias === 'string' ? target.keyAlias.trim() : '';
  const aliasExplicit = alias.length > 0 && target.pathLength === 3;
  if (aliasExplicit) {
    const prefix = `${providerId}.${alias}.`;
    const aliasKeys = providerKeys.filter((key) => key.startsWith(prefix));
    if (aliasKeys.length > 0) {
      if (target.model && target.model.trim()) {
        const normalizedModel = target.model.trim();
        const matching = aliasKeys.filter((key) => getProviderModelId(key, providerRegistry) === normalizedModel);
        if (matching.length > 0) {
          // Prefer exact to keep sticky pool deterministic when only one key matches.
          if (matching.length === 1) {
            return { mode: 'exact', keys: [matching[0]] };
          }
          return { mode: 'filter', keys: matching };
        }
      }
      return { mode: 'filter', keys: aliasKeys };
    }
  }

  if (typeof target.keyIndex === 'number' && target.keyIndex > 0) {
    const runtimeKey = providerRegistry.resolveRuntimeKeyByIndex(providerId, target.keyIndex);
    if (runtimeKey) {
      return { mode: 'exact', keys: [runtimeKey] };
    }
  }

  if (target.model && target.model.trim()) {
    const normalizedModel = target.model.trim();
    const matchingKeys = providerKeys.filter((key) => {
      const modelId = getProviderModelId(key, providerRegistry);
      return modelId === normalizedModel;
    });
    if (matchingKeys.length > 0) {
      return { mode: 'filter', keys: matchingKeys };
    }
  }

  if (alias && !aliasExplicit) {
    const legacyKey = providerRegistry.resolveRuntimeKeyByAlias(providerId, alias);
    if (legacyKey) {
      return { mode: 'exact', keys: [legacyKey] };
    }
  }

  return { mode: 'filter', keys: providerKeys };
}

