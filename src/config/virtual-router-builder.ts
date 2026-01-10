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
  const vrRouting = isRecord(vrNode.routing) ? (vrNode.routing as VirtualRouterRoutingConfig) : undefined;
  if (vrRouting) {
    return vrRouting;
  }
  const rootRouting = isRecord(userConfig.routing) ? (userConfig.routing as VirtualRouterRoutingConfig) : undefined;
  return rootRouting ? rootRouting : {};
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
