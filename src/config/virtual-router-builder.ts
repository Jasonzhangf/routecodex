import type {
  UnknownRecord,
  VirtualRouterInput,
  VirtualRouterProvidersConfig,
  VirtualRouterRoutingConfig
} from './virtual-router-types.js';
import { loadProviderConfigsV2 } from './provider-v2-loader.js';

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function extractRoutingFromUserConfig(userConfig: UnknownRecord): VirtualRouterRoutingConfig {
  const vrNode = isRecord(userConfig.virtualrouter) ? (userConfig.virtualrouter as UnknownRecord) : {};
  const groupsNode = isRecord(vrNode.routingPolicyGroups) ? (vrNode.routingPolicyGroups as UnknownRecord) : undefined;
  if (groupsNode) {
    const groupEntries = Object.entries(groupsNode)
      .filter(([groupId, groupNode]) => Boolean(groupId.trim()) && isRecord(groupNode))
      .map(([groupId, groupNode]) => [groupId, groupNode as UnknownRecord] as const);
    if (groupEntries.length > 0) {
      const activeCandidate = typeof vrNode.activeRoutingPolicyGroup === 'string' ? vrNode.activeRoutingPolicyGroup.trim() : '';
      const activeEntry =
        (activeCandidate ? groupEntries.find(([groupId]) => groupId === activeCandidate) : undefined)
        ?? groupEntries.find(([groupId]) => groupId === 'default')
        ?? groupEntries.sort((a, b) => a[0].localeCompare(b[0]))[0];
      const activeRouting = activeEntry && isRecord(activeEntry[1].routing)
        ? (activeEntry[1].routing as VirtualRouterRoutingConfig)
        : undefined;
      if (activeRouting) {
        return activeRouting;
      }
    }
  }
  throw new Error('[config] v2 config requires virtualrouter.routingPolicyGroups with routing for active policy group');
}

/**
 * Build a VirtualRouterInput in "v2" mode by combining:
 * - Provider v2 configs loaded from ~/.routecodex/provider (or a custom root)
 * - Routing configuration from the user config (virtualrouter.routing 或旧式 routing 字段)
 *
 * 当前函数仅用于迁移与测试，尚未接入 HTTP server 运行路径。
 */
export async function buildVirtualRouterInputV2(
  userConfig: UnknownRecord,
  providerRootDir?: string
): Promise<VirtualRouterInput> {
  const routing = extractRoutingFromUserConfig(userConfig);

  const providerConfigs = await loadProviderConfigsV2(providerRootDir);
  const providers: VirtualRouterProvidersConfig = {};

  for (const [providerId, cfg] of Object.entries(providerConfigs)) {
    providers[providerId] = cfg.provider;
  }

  const input: VirtualRouterInput = {
    providers,
    routing
  };
  return input;
}
