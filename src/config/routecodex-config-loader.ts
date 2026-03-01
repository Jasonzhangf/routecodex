import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveRouteCodexConfigPath } from './config-paths.js';
import { buildProviderProfiles } from '../providers/profile/provider-profile-loader.js';
import type { ProviderProfileCollection } from '../providers/profile/provider-profile.js';
import { buildVirtualRouterInputV2 } from './virtual-router-builder.js';

type UnknownRecord = Record<string, unknown>;

const ROUTING_POLICY_OPTIONAL_KEYS = [
  'loadBalancing',
  'classifier',
  'health',
  'contextRouting',
  'webSearch',
  'execCommandGuard',
  'clock'
] as const;

let stickyConfigPath: string | null = null;
const warnedLegacyConfigPaths = new Set<string>();

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
  stickyConfigPath = configPath;

  const modeRaw = (userConfig as UnknownRecord).virtualrouterMode;
  const mode = typeof modeRaw === 'string' && modeRaw.trim().toLowerCase() === 'v2' ? 'v2' : 'v1';

  if (mode === 'v2') {
    sanitizeV2ConfigSources(userConfig, configPath);
    validateV2ConfigSources(userConfig);
  } else {
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
  }

  materializeActiveRoutingPolicyGroup(userConfig);

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
  if (stickyConfigPath) {
    return stickyConfigPath;
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

function sanitizeV2ConfigSources(userConfig: UnknownRecord, configPath: string): void {
  const removed: string[] = [];
  const allowedTopLevel = new Set(['version', 'httpserver', 'virtualrouter', 'virtualrouterMode']);
  const legacyTopLevel = new Set(['oauthBrowser', 'loadBalancing', 'classifier', 'providers', 'routing', 'quota', 'clock']);

  for (const key of Object.keys(userConfig)) {
    if (allowedTopLevel.has(key)) {
      continue;
    }
    if (legacyTopLevel.has(key)) {
      delete userConfig[key];
      removed.push(`top-level.${key}`);
    }
  }

  const httpserver = isRecord(userConfig.httpserver) ? (userConfig.httpserver as UnknownRecord) : undefined;
  if (httpserver && Object.prototype.hasOwnProperty.call(httpserver, 'apikey')) {
    delete httpserver.apikey;
    removed.push('httpserver.apikey');
  }

  const vr = isRecord(userConfig.virtualrouter) ? (userConfig.virtualrouter as UnknownRecord) : undefined;
  if (vr) {
    const allowedVr = new Set(['routingPolicyGroups', 'activeRoutingPolicyGroup']);
    for (const key of Object.keys(vr)) {
      if (allowedVr.has(key)) {
        continue;
      }
      if (ROUTING_POLICY_OPTIONAL_KEYS.includes(key as (typeof ROUTING_POLICY_OPTIONAL_KEYS)[number])) {
        delete vr[key];
        removed.push(`virtualrouter.${key}`);
        continue;
      }
      if (key === 'routing' || key === 'providers' || key === 'quota' || key === 'clock') {
        delete vr[key];
        removed.push(`virtualrouter.${key}`);
        continue;
      }
      const value = vr[key];
      if (isRecord(value)) {
        const maybeProviderNode = value as UnknownRecord;
        const looksLikeProviderNode =
          typeof maybeProviderNode.type === 'string' ||
          typeof maybeProviderNode.providerType === 'string' ||
          isRecord(maybeProviderNode.models) ||
          isRecord(maybeProviderNode.auth);
        if (looksLikeProviderNode) {
          delete vr[key];
          removed.push(`virtualrouter.${key}`);
        }
      }
    }
  }

  if (removed.length) {
    if (!warnedLegacyConfigPaths.has(configPath)) {
      warnedLegacyConfigPaths.add(configPath);
      console.warn(`[config] v2 ignored legacy fields (${configPath}): ${removed.join(', ')}`);
    }
  }
}

function validateV2ConfigSources(userConfig: UnknownRecord): void {
  const errors: string[] = [];
  const allowedTopLevel = new Set(['version', 'httpserver', 'virtualrouter', 'virtualrouterMode']);
  for (const key of Object.keys(userConfig)) {
    if (!allowedTopLevel.has(key)) {
      errors.push(`v2 config disallows top-level field "${key}"`);
    }
  }

  const httpserver = isRecord(userConfig.httpserver) ? (userConfig.httpserver as UnknownRecord) : undefined;
  if (httpserver) {
    const allowedHttp = new Set(['host', 'port']);
    for (const key of Object.keys(httpserver)) {
      if (!allowedHttp.has(key)) {
        errors.push(`v2 config disallows httpserver field "${key}" (only host/port allowed)`);
      }
    }
  }

  const vr = isRecord(userConfig.virtualrouter) ? (userConfig.virtualrouter as UnknownRecord) : undefined;
  if (!vr) {
    errors.push('v2 config requires virtualrouter.routingPolicyGroups');
  } else {
    const allowedVr = new Set(['routingPolicyGroups', 'activeRoutingPolicyGroup']);
    for (const key of Object.keys(vr)) {
      if (!allowedVr.has(key)) {
        errors.push(`v2 config disallows virtualrouter field "${key}" (routingPolicyGroups only)`);
      }
    }

    const groupsNode = isRecord(vr.routingPolicyGroups) ? (vr.routingPolicyGroups as UnknownRecord) : undefined;
    if (!groupsNode || !Object.keys(groupsNode).length) {
      errors.push('v2 config requires non-empty virtualrouter.routingPolicyGroups');
    } else {
      const allowedGroupKeys = new Set(['routing', ...ROUTING_POLICY_OPTIONAL_KEYS]);
      for (const [groupId, groupNode] of Object.entries(groupsNode)) {
        if (!groupId.trim()) {
          errors.push('v2 routingPolicyGroups contains empty group id');
          continue;
        }
        if (!isRecord(groupNode)) {
          errors.push(`v2 routingPolicyGroups["${groupId}"] must be an object`);
          continue;
        }
        for (const key of Object.keys(groupNode as UnknownRecord)) {
          if (!allowedGroupKeys.has(key)) {
            errors.push(
              `v2 routingPolicyGroups["${groupId}"] disallows field "${key}" (routing/optional policy fields only)`
            );
          }
        }
        if (!isRecord((groupNode as UnknownRecord).routing)) {
          errors.push(`v2 routingPolicyGroups["${groupId}"] must define routing`);
        }
      }
    }
  }

  if (errors.length) {
    const message = ['[config] v2 config must use single-source layout:', ...errors].join('\n- ');
    throw new Error(message);
  }
}

function materializeActiveRoutingPolicyGroup(userConfig: UnknownRecord): void {
  const vr = isRecord(userConfig.virtualrouter) ? (userConfig.virtualrouter as UnknownRecord) : null;
  if (!vr) {
    return;
  }

  const groupsNode = vr.routingPolicyGroups;
  if (!isRecord(groupsNode)) {
    return;
  }

  const groups: Record<string, UnknownRecord> = {};
  for (const [groupId, groupNode] of Object.entries(groupsNode)) {
    if (!groupId.trim() || !isRecord(groupNode)) {
      continue;
    }
    groups[groupId] = groupNode as UnknownRecord;
  }
  const groupIds = Object.keys(groups);
  if (!groupIds.length) {
    return;
  }

  const activeCandidate = typeof vr.activeRoutingPolicyGroup === 'string' ? vr.activeRoutingPolicyGroup.trim() : '';
  const activeGroupId =
    activeCandidate && groups[activeCandidate]
      ? activeCandidate
      : groups.default
        ? 'default'
        : groupIds.sort((a, b) => a.localeCompare(b))[0];

  const activePolicy = groups[activeGroupId];
  if (!isRecord(activePolicy.routing)) {
    return;
  }

  vr.activeRoutingPolicyGroup = activeGroupId;
  vr.routing = activePolicy.routing;

  for (const key of ROUTING_POLICY_OPTIONAL_KEYS) {
    const value = activePolicy[key];
    if (isRecord(value)) {
      vr[key] = value;
      continue;
    }
    delete vr[key];
  }
}
