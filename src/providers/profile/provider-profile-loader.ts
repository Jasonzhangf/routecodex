// feature_id: config.provider_profile_materialization
// feature_id: config.forwarder_profile_materialization
import type {
  ProviderForwarderCollection,
} from './forwarder-types.js';
import { FORWARDER_ID_PREFIX, validateForwarderId } from './forwarder-types.js';
import type {
  ProviderProfileCollection,
} from './provider-profile.js';

import type { ApiKeyEntry, ApiKeyAuthConfig } from './provider-profile.js';
import {
  buildRouteCodexForwarderProfilesSync,
  buildRouteCodexProviderProfilesSync,
} from '../../modules/llmswitch/bridge/config-integrations.js';

type UnknownRecord = Record<string, unknown>;

export function buildProviderProfiles(config: UnknownRecord): ProviderProfileCollection {
  return buildRouteCodexProviderProfilesSync(config) as unknown as ProviderProfileCollection;
}

/**
 * 从 authNode 提取 API Key entries 数组
 */
export function extractApiKeyEntries(auth: ApiKeyAuthConfig): ApiKeyEntry[] {
  if (auth.entries && auth.entries.length > 0) {
    return auth.entries;
  }
  const singleEntry: ApiKeyEntry = {
    apiKey: auth.apiKey,
    secretRef: auth.secretRef,
    env: auth.env
  };
  if (singleEntry.apiKey || singleEntry.secretRef || singleEntry.env) {
    return [singleEntry];
  }
  return [];
}

// ==================== ProviderForwarder loader ====================

export function buildForwarderProfiles(
  config: UnknownRecord,
  knownProviderIds: Set<string>
): ProviderForwarderCollection {
  return buildRouteCodexForwarderProfilesSync(
    config,
    knownProviderIds
  ) as unknown as ProviderForwarderCollection;
}

// Re-export the prefix for callers
export { FORWARDER_ID_PREFIX, validateForwarderId };
