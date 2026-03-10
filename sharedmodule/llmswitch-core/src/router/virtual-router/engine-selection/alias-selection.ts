import type { AliasSelectionConfig, AliasSelectionStrategy } from '../types.js';
import {
  pinAliasQueueWithNative,
  resolveAliasSelectionStrategyWithNative
} from './native-virtual-router-alias-selection-semantics.js';

export type AliasQueueStore = Map<string, string[]>;

// Default provider-level strategy table.
// This is a data-only default; callers can override via `loadBalancing.aliasSelection.providers`.
export const DEFAULT_PROVIDER_ALIAS_SELECTION: Record<string, AliasSelectionStrategy> = {
  // Antigravity: upstream gateway may reject rapid cross-key switching; stick to one alias until error.
  antigravity: 'sticky-queue'
};

export function resolveAliasSelectionStrategy(
  providerId: string,
  cfg: AliasSelectionConfig | undefined
): AliasSelectionStrategy {
  return resolveAliasSelectionStrategyWithNative(providerId, cfg);
}

export function pinCandidatesByAliasQueue(opts: {
  queueStore: AliasQueueStore | undefined;
  providerId: string;
  modelId: string;
  candidates: string[];
  orderedTargets: string[];
  excludedProviderKeys: Set<string>;
  aliasOfKey: (providerKey: string) => string | null;
  modelIdOfKey: (providerKey: string) => string | null;
  availabilityCheck: (providerKey: string) => boolean;
}): string[] | null {
  const {
    queueStore,
    providerId,
    modelId,
    candidates,
    orderedTargets,
    excludedProviderKeys,
    aliasOfKey,
    modelIdOfKey,
    availabilityCheck
  } = opts;

  if (!queueStore) return null;
  if (!providerId || !modelId) return null;
  if (!Array.isArray(candidates) || candidates.length < 2) return null;

  const aliasBuckets = new Map<string, string[]>();
  for (const key of candidates) {
    if (!key || typeof key !== 'string') continue;
    if (!key.startsWith(`${providerId}.`)) return null;
    const m = modelIdOfKey(key);
    if (!m || m !== modelId) return null;
    const alias = aliasOfKey(key);
    if (!alias) return null;
    const list = aliasBuckets.get(alias) ?? [];
    list.push(key);
    aliasBuckets.set(alias, list);
  }
  if (aliasBuckets.size <= 1) return null;

  const queueKey = `${providerId}::${modelId}`;
  const desiredOrder = resolveAliasOrderFromTargets({
    orderedTargets,
    providerId,
    modelId,
    aliasOfKey,
    modelIdOfKey,
    allowedAliases: new Set(aliasBuckets.keys())
  });
  const excludedAliases = collectExcludedAliases({
    excludedProviderKeys,
    providerId,
    modelId,
    aliasOfKey,
    modelIdOfKey
  });
  const availabilityByAlias = buildAliasAvailabilityMap(aliasBuckets, availabilityCheck);
  const resolved = pinAliasQueueWithNative(
    {
      queue: queueStore.get(queueKey) ?? [],
      desiredOrder,
      excludedAliases,
      aliasBuckets: Object.fromEntries(aliasBuckets.entries()),
      candidateOrder: candidates,
      availabilityByAlias: Object.fromEntries(availabilityByAlias.entries())
    }
  );
  queueStore.set(queueKey, resolved.queue);
  return resolved.selectedCandidates.length ? resolved.selectedCandidates : null;
}

function collectExcludedAliases(opts: {
  excludedProviderKeys: Set<string>;
  providerId: string;
  modelId: string;
  aliasOfKey: (providerKey: string) => string | null;
  modelIdOfKey: (providerKey: string) => string | null;
}): string[] {
  const { excludedProviderKeys, providerId, modelId, aliasOfKey, modelIdOfKey } = opts;
  if (!excludedProviderKeys || excludedProviderKeys.size === 0) {
    return [];
  }
  const excludedAliases: string[] = [];
  for (const ex of excludedProviderKeys) {
    if (!ex || typeof ex !== 'string') continue;
    if (!ex.startsWith(`${providerId}.`)) continue;
    const exModel = modelIdOfKey(ex);
    if (!exModel || exModel !== modelId) continue;
    const exAlias = aliasOfKey(ex);
    if (exAlias) excludedAliases.push(exAlias);
  }
  return excludedAliases;
}

function buildAliasAvailabilityMap(
  aliasBuckets: Map<string, string[]>,
  availabilityCheck: (providerKey: string) => boolean
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const [alias, keys] of aliasBuckets.entries()) {
    out.set(alias, keys.some((key) => availabilityCheck(key)));
  }
  return out;
}

function resolveAliasOrderFromTargets(opts: {
  orderedTargets: string[];
  providerId: string;
  modelId: string;
  aliasOfKey: (providerKey: string) => string | null;
  modelIdOfKey: (providerKey: string) => string | null;
  allowedAliases: Set<string>;
}): string[] {
  const { orderedTargets, providerId, modelId, aliasOfKey, modelIdOfKey, allowedAliases } = opts;
  if (!Array.isArray(orderedTargets) || orderedTargets.length === 0) {
    return Array.from(allowedAliases);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of orderedTargets) {
    if (!key || typeof key !== 'string') continue;
    if (!key.startsWith(`${providerId}.`)) continue;
    const m = modelIdOfKey(key);
    if (!m || m !== modelId) continue;
    const alias = aliasOfKey(key);
    if (!alias || !allowedAliases.has(alias) || seen.has(alias)) continue;
    seen.add(alias);
    out.push(alias);
  }
  for (const alias of Array.from(allowedAliases)) {
    if (!seen.has(alias)) out.push(alias);
  }
  return out;
}
