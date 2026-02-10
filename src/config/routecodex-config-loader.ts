import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveRouteCodexConfigPath } from './config-paths.js';
import { buildProviderProfiles } from '../providers/profile/provider-profile-loader.js';
import type { ProviderProfileCollection } from '../providers/profile/provider-profile.js';
import { buildVirtualRouterInputV2 } from './virtual-router-builder.js';

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

  const modeRaw = (userConfig as UnknownRecord).virtualrouterMode;
  const mode = typeof modeRaw === 'string' && modeRaw.trim().toLowerCase() === 'v2' ? 'v2' : 'v1';

  if (mode === 'v2') {
    const vrBase = isRecord(userConfig.virtualrouter) ? (userConfig.virtualrouter as UnknownRecord) : {};
    const v2Input = await buildVirtualRouterInputV2(userConfig);
    userConfig.virtualrouter = {
      ...vrBase,
      providers: v2Input.providers,
      routing: v2Input.routing
    };
  } else {
    const providers = isRecord(userConfig.providers) ? userConfig.providers : {};
    const routing = isRecord(userConfig.routing) ? userConfig.routing : {};

    if (!isRecord(userConfig.virtualrouter)) {
      userConfig.virtualrouter = { providers, routing };
    } else {
      const vr = userConfig.virtualrouter as UnknownRecord;
      const mergedProviders: UnknownRecord = {
        ...(isRecord(vr.providers) ? (vr.providers as UnknownRecord) : providers)
      };

      for (const [key, value] of Object.entries(vr)) {
        if (key === 'providers' || key === 'routing') {
          continue;
        }
        if (!isRecord(value)) {
          continue;
        }
        const maybeProviderNode = value as UnknownRecord;
        const looksLikeProviderNode =
          typeof maybeProviderNode.type === 'string' ||
          typeof maybeProviderNode.providerType === 'string' ||
          isRecord(maybeProviderNode.models) ||
          isRecord(maybeProviderNode.auth);
        if (!looksLikeProviderNode) {
          continue;
        }
        if (!isRecord(mergedProviders[key])) {
          mergedProviders[key] = maybeProviderNode;
        }
      }

      vr.providers = mergedProviders;
      if (!isRecord(vr.routing)) {
        vr.routing = routing;
      }
    }
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
