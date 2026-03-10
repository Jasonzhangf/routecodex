import type { ProviderRegistry } from '../provider-registry.js';
import type { RouterMetadataInput } from '../types.js';
import { analyzeProviderKey } from './native-router-hotpath.js';

function parseProviderKey(providerKey: string): { providerId: string | null; alias: string | null; keyIndex?: number } {
  return analyzeProviderKey(providerKey);
}

export function extractProviderId(providerKey: string): string | null {
  return parseProviderKey(providerKey).providerId;
}

export function extractKeyAlias(providerKey: string): string | null {
  const alias = parseProviderKey(providerKey).alias;
  if (!alias) {
    return null;
  }
  return normalizeAliasDescriptor(alias);
}

export function normalizeAliasDescriptor(alias: string): string {
  return alias;
}

export function extractKeyIndex(providerKey: string): number | undefined {
  return parseProviderKey(providerKey).keyIndex;
}

export function getProviderModelId(providerKey: string, providerRegistry: ProviderRegistry): string | null {
  const profile = providerRegistry.get(providerKey);
  if (profile.modelId) {
    return profile.modelId;
  }
  const parts = providerKey.split('.');
  if (parts.length === 2) {
    return parts[1] || null;
  }
  if (parts.length === 3) {
    return parts[2] || null;
  }
  return null;
}

export function extractExcludedProviderKeySet(metadata: RouterMetadataInput | undefined): Set<string> {
  if (!metadata) {
    return new Set();
  }
  const raw = (metadata as { excludedProviderKeys?: unknown }).excludedProviderKeys;
  if (!Array.isArray(raw) || raw.length === 0) {
    return new Set();
  }
  const normalized = raw
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value): value is string => Boolean(value));
  return new Set(normalized);
}
