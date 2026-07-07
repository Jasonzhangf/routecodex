// feature_id: config.user_config_materialization
import fs from 'node:fs/promises';
import { resolveRouteCodexConfigPath } from './config-paths.js';
import type { ProviderProfileCollection } from '../providers/profile/provider-profile.js';
import type { UnknownRecord } from './user-config-codec.js';
import { materializeRouteCodexConfig } from './user-config-loader.js';
import { parseUserConfigText } from './user-config-codec.js';
import { detectUserConfigFormat } from './user-config-codec.js';
import { planRouteCodexConfigLoaderPathsNativeSync } from '../modules/llmswitch/bridge.js';

export interface LoadedRouteCodexConfig {
  configPath: string;
  userConfig: UnknownRecord;
  providerProfiles: ProviderProfileCollection;
}

export async function loadRouteCodexConfig(explicitPath?: string): Promise<LoadedRouteCodexConfig> {
  const plan = planRouteCodexConfigLoaderPathsNativeSync({
    explicitPath,
    routecodexProviderDir: process.env.ROUTECODEX_PROVIDER_DIR,
    rccProviderDir: process.env.RCC_PROVIDER_DIR,
  });
  const configPath = plan.explicitPath ?? await resolveConfigPath();
  const raw = await fs.readFile(configPath, 'utf-8');
  const format = detectUserConfigFormat(configPath);
  const userConfig = parseUserConfigText(raw, format);
  const { userConfig: materializedUserConfig, providerProfiles } = await materializeRouteCodexConfig(
    userConfig,
    plan.providerRootDir
  );

  return {
    configPath,
    userConfig: materializedUserConfig,
    providerProfiles
  };
}

export { collectV2ConfigSourceErrors } from './user-config-loader.js';

async function resolveConfigPath(): Promise<string> {
  return resolveRouteCodexConfigPath();
}
