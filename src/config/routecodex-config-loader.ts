// feature_id: config.user_config_materialization
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveRouteCodexConfigPath } from './config-paths.js';
import type { ProviderProfileCollection } from '../providers/profile/provider-profile.js';
import type { UnknownRecord } from './user-config-codec.js';
import { materializeRouteCodexConfig } from './user-config-materializer.js';
import { parseUserConfigText } from './user-config-codec.js';
import { detectUserConfigFormat } from './user-config-codec.js';

export interface LoadedRouteCodexConfig {
  configPath: string;
  userConfig: UnknownRecord;
  providerProfiles: ProviderProfileCollection;
}

export async function loadRouteCodexConfig(explicitPath?: string): Promise<LoadedRouteCodexConfig> {
  const configPath = await resolveConfigPath(explicitPath);
  const raw = await fs.readFile(configPath, 'utf-8');
  const format = detectUserConfigFormat(configPath);
  const userConfig = parseUserConfigText(raw, format);
  const providerRootDir = resolveProviderRootDirFromEnv();
  const { userConfig: materializedUserConfig, providerProfiles } = await materializeRouteCodexConfig(
    userConfig,
    providerRootDir
  );

  return {
    configPath,
    userConfig: materializedUserConfig,
    providerProfiles
  };
}

export { collectV2ConfigSourceErrors } from './user-config-materializer.js';


function resolveProviderRootDirFromEnv(): string | undefined {
  const candidates = [
    process.env.ROUTECODEX_PROVIDER_DIR,
    process.env.RCC_PROVIDER_DIR
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return path.resolve(candidate.trim());
    }
  }
  return undefined;
}

async function resolveConfigPath(explicit?: string): Promise<string> {
  if (explicit && explicit.trim()) {
    return path.resolve(explicit.trim());
  }
  return resolveRouteCodexConfigPath();
}
