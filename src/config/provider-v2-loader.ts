import {
  loadRouteCodexProviderConfigsV2FromRootSync,
  planProviderConfigRootNativeSync
} from '../modules/llmswitch/bridge.js';
import { resolveRccProviderDir } from './user-data-paths.js';

type UnknownRecord = Record<string, unknown>;

export interface ProviderConfigV2 {
  version: string;
  providerId: string;
  /**
   * Provider configuration payload compatible with the `providers[providerId]`
   * entry expected by `bootstrapVirtualRouterConfig`.
   */
  provider: UnknownRecord;
}

function resolveProviderRoot(rootDir?: string): string {
  return planProviderConfigRootNativeSync(rootDir).rootDir ?? resolveRccProviderDir();
}

/**
 * Load all Provider v2 configs under the given root directory.
 *
 * Rules:
 * - `config.v2.toml` uses the directory name as the single source of truth.
 * - `config.v2.*.toml` files are treated as standalone provider declarations
 *   and must declare a globally unique provider id.
 */
export async function loadProviderConfigsV2(rootDir?: string): Promise<Record<string, ProviderConfigV2>> {
  return loadRouteCodexProviderConfigsV2FromRootSync(resolveProviderRoot(rootDir)) as unknown as Record<string, ProviderConfigV2>;
}
