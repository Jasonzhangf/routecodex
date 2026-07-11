// feature_id: config.user_config_materialization
import type { ProviderProfileCollection } from '../providers/profile/provider-profile.js';
import type { UnknownRecord } from './user-config-codec.js';
import { loadRouteCodexConfigNativeSync } from '../modules/llmswitch/bridge/config-integrations.js';

export interface LoadedRouteCodexConfig {
  configPath: string;
  userConfig: UnknownRecord;
  providerProfiles: ProviderProfileCollection;
}

export async function loadRouteCodexConfig(explicitPath?: string): Promise<LoadedRouteCodexConfig> {
  return loadRouteCodexConfigNativeSync({
    explicitPath,
    routecodexProviderDir: process.env.ROUTECODEX_PROVIDER_DIR,
    rccProviderDir: process.env.RCC_PROVIDER_DIR,
  }) as unknown as LoadedRouteCodexConfig;
}

export { collectV2ConfigSourceErrors } from './user-config-loader.js';
