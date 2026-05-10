import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveRouteCodexConfigPath } from './config-paths.js';
import { resolveRccConfigFile } from './user-data-paths.js';
import type { ProviderProfileCollection } from '../providers/profile/provider-profile.js';
import type { UnknownRecord } from './user-config-loader.js';
import { collectV2ConfigSourceErrors, materializeRouteCodexConfig } from './user-config-loader.js';
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
  const { userConfig: materializedUserConfig, providerProfiles } = await materializeRouteCodexConfig(userConfig);

  return {
    configPath,
    userConfig: materializedUserConfig,
    providerProfiles
  };
}

export { collectV2ConfigSourceErrors } from './user-config-loader.js';

async function resolveConfigPath(explicit?: string): Promise<string> {
  if (explicit && explicit.trim()) {
    return path.resolve(explicit.trim());
  }
  const resolved = resolveRouteCodexConfigPath();
  if (resolved) {
    return resolved;
  }
  return resolveRccConfigFile();
}
