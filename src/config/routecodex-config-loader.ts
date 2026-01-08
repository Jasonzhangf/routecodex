import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveRouteCodexConfigPath } from './config-paths.js';
import { buildProviderProfiles } from '../providers/profile/provider-profile-loader.js';
import type { ProviderProfileCollection } from '../providers/profile/provider-profile.js';

type UnknownRecord = Record<string, unknown>;

export interface LoadedRouteCodexConfig {
  configPath: string;
  userConfig: UnknownRecord;
  providerProfiles: ProviderProfileCollection;
}

export async function loadRouteCodexConfig(explicitPath?: string): Promise<LoadedRouteCodexConfig> {
  const configPath = await resolveConfigPath(explicitPath);
  const raw = await fs.readFile(configPath, 'utf-8');
  const parsed = raw.trim() ? JSON.parse(raw) : {};
  const userConfig: UnknownRecord = isRecord(parsed) ? parsed : {};

  // 全局 OAuth 浏览器选择开关（例如：'camoufox' 或 'default'）
  // 若配置中声明且环境变量未显式指定，则将其映射到 ROUTECODEX_OAUTH_BROWSER，供 OAuth 流程使用。
  const oauthBrowserValue = (userConfig as Record<string, unknown>).oauthBrowser;
  const oauthBrowserRaw =
    typeof oauthBrowserValue === 'string'
      ? oauthBrowserValue.trim()
      : '';
  if (oauthBrowserRaw && !process.env.ROUTECODEX_OAUTH_BROWSER) {
    process.env.ROUTECODEX_OAUTH_BROWSER = oauthBrowserRaw;
  }

  if (!isRecord(userConfig.virtualrouter)) {
    const providers = isRecord(userConfig.providers) ? userConfig.providers : {};
    const routing = isRecord(userConfig.routing) ? userConfig.routing : {};
    userConfig.virtualrouter = { providers, routing };
  }

  const providerProfiles = buildProviderProfiles(userConfig);

  return {
    configPath,
    userConfig,
    providerProfiles
  };
}

async function resolveConfigPath(explicit?: string): Promise<string> {
  if (explicit && explicit.trim()) {
    return path.resolve(explicit.trim());
  }
  const resolved = resolveRouteCodexConfigPath();
  if (resolved) {
    return resolved;
  }
  return path.join(os.homedir(), '.routecodex', 'config.json');
}

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
