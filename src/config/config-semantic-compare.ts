import type { ProviderProfileCollection } from '../providers/profile/provider-profile.js';
import type { UnknownRecord } from './user-config-loader.js';
import { materializeRouteCodexConfig } from './user-config-loader.js';

export interface SemanticCompareResult {
  equal: boolean;
  left: unknown;
  right: unknown;
}

function normalizeForCompare(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForCompare(item));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, normalizeForCompare(child)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForCompare(value));
}

export function compareSemanticValue(left: unknown, right: unknown): SemanticCompareResult {
  return {
    equal: stableStringify(left) === stableStringify(right),
    left: normalizeForCompare(left),
    right: normalizeForCompare(right)
  };
}

export interface RouteCodexSemanticSnapshot {
  userConfig: UnknownRecord;
  providerProfiles: ProviderProfileCollection;
}

export async function buildRouteCodexSemanticSnapshot(
  userConfig: UnknownRecord,
  providerRootDir?: string
): Promise<RouteCodexSemanticSnapshot> {
  return materializeRouteCodexConfig(userConfig, providerRootDir);
}
