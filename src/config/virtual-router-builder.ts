import type {
  UnknownRecord,
  VirtualRouterInput,
  VirtualRouterProvidersConfig,
  VirtualRouterRoutingConfig,
  VirtualRouterRoutingPool
} from './virtual-router-types.js';
import { loadProviderConfigsV2, type ProviderConfigV2 } from './provider-v2-loader.js';

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
 * - Provider v2 configs loaded from ~/.rcc/provider (or a custom root)
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

  const routingWithCapabilityRoutes = synthesizeCapabilityRoutes(routing, providerConfigs);

  const input: VirtualRouterInput = {
    providers,
    routing: routingWithCapabilityRoutes
  };
  return input;
}

function synthesizeCapabilityRoutes(
  routing: VirtualRouterRoutingConfig,
  providerConfigs: Record<string, ProviderConfigV2>
): VirtualRouterRoutingConfig {
  const allowedProviders = collectRoutedProviderIds(routing);
  const multimodalTargets = collectTargetsByCapability(
    providerConfigs,
    allowedProviders,
    supportsMultimodalCapability
  );
  const webSearchTargets = collectTargetsByCapability(
    providerConfigs,
    allowedProviders,
    supportsWebSearchCapability
  );
  if (multimodalTargets.length === 0 && webSearchTargets.length === 0) {
    return routing;
  }

  const nextRouting: VirtualRouterRoutingConfig = { ...routing };
  if (multimodalTargets.length > 0 && !routeHasConfiguredTargets(nextRouting.multimodal)) {
    nextRouting.multimodal = [buildCapabilityRoutePool('multimodal', multimodalTargets)];
  }
  if (multimodalTargets.length > 0 && !routeHasConfiguredTargets(nextRouting.vision)) {
    nextRouting.vision = [buildCapabilityRoutePool('vision', multimodalTargets)];
  }
  if (
    webSearchTargets.length > 0
    && !routeHasConfiguredTargets(nextRouting.web_search)
    && !routeHasConfiguredTargets(nextRouting.search)
  ) {
    nextRouting.web_search = [buildCapabilityRoutePool('web_search', webSearchTargets)];
  }
  return nextRouting;
}

function collectTargetsByCapability(
  providerConfigs: Record<string, ProviderConfigV2>,
  allowedProviders: Set<string>,
  supportsCapability: (modelNode: UnknownRecord) => boolean
): string[] {
  const targets: string[] = [];
  for (const [providerId, cfg] of Object.entries(providerConfigs)) {
    if (allowedProviders.size > 0 && !allowedProviders.has(providerId)) {
      continue;
    }
    const providerNode = isRecord(cfg.provider) ? cfg.provider : {};
    const modelEntries = collectModelEntries(providerNode.models);
    for (const { modelId, modelNode } of modelEntries) {
      if (!supportsCapability(modelNode)) {
        continue;
      }
      const target = `${providerId}.${modelId}`;
      if (!targets.includes(target)) {
        targets.push(target);
      }
    }
  }
  return targets;
}

function collectRoutedProviderIds(routing: VirtualRouterRoutingConfig): Set<string> {
  const out = new Set<string>();
  for (const pools of Object.values(routing)) {
    if (!Array.isArray(pools)) {
      continue;
    }
    for (const pool of pools) {
      if (!isRecord(pool)) {
        continue;
      }
      const targets = Array.isArray(pool.targets) ? pool.targets : [];
      for (const target of targets) {
        const providerId = extractProviderIdFromRouteTarget(target);
        if (providerId) {
          out.add(providerId);
        }
      }
      const lb = isRecord(pool.loadBalancing) ? (pool.loadBalancing as UnknownRecord) : undefined;
      const weights = lb && isRecord(lb.weights) ? (lb.weights as UnknownRecord) : undefined;
      if (weights) {
        for (const weightKey of Object.keys(weights)) {
          const providerId = extractProviderIdFromRouteTarget(weightKey);
          if (providerId) {
            out.add(providerId);
          }
        }
      }
    }
  }
  return out;
}

function extractProviderIdFromRouteTarget(target: unknown): string | null {
  if (typeof target !== 'string') {
    return null;
  }
  const trimmed = target.trim();
  if (!trimmed) {
    return null;
  }
  const idx = trimmed.indexOf('.');
  if (idx <= 0) {
    return trimmed;
  }
  return trimmed.slice(0, idx);
}

function collectModelEntries(modelsNode: unknown): Array<{ modelId: string; modelNode: UnknownRecord }> {
  const entries: Array<{ modelId: string; modelNode: UnknownRecord }> = [];
  if (Array.isArray(modelsNode)) {
    for (const entry of modelsNode) {
      if (!isRecord(entry)) {
        continue;
      }
      const modelId = typeof entry.id === 'string' ? entry.id.trim() : '';
      if (!modelId) {
        continue;
      }
      entries.push({ modelId, modelNode: entry });
    }
    return entries;
  }

  if (!isRecord(modelsNode)) {
    return entries;
  }
  for (const [modelIdRaw, modelNodeRaw] of Object.entries(modelsNode)) {
    const modelId = typeof modelIdRaw === 'string' ? modelIdRaw.trim() : '';
    if (!modelId || !isRecord(modelNodeRaw)) {
      continue;
    }
    entries.push({ modelId, modelNode: modelNodeRaw });
  }
  return entries;
}

function supportsMultimodalCapability(modelNode: UnknownRecord): boolean {
  const boolFlags = ['supportsVision', 'supportsImages', 'supportsImageInput', 'supportsMultimodal', 'multimodal'];
  for (const key of boolFlags) {
    if (modelNode[key] === true) {
      return true;
    }
  }
  const capabilities = Array.isArray(modelNode.capabilities) ? modelNode.capabilities : [];
  for (const capability of capabilities) {
    if (typeof capability !== 'string') {
      continue;
    }
    const normalized = capability.trim().toLowerCase();
    if (normalized === 'vision' || normalized === 'multimodal') {
      return true;
    }
  }
  return false;
}

function supportsWebSearchCapability(modelNode: UnknownRecord): boolean {
  const boolFlags = [
    'supportsWebSearch',
    'webSearch',
    'supportsSearch',
    'supportsSearchTool',
    'supportsWebSearchTool',
    'supportsBuiltinWebSearch'
  ];
  for (const key of boolFlags) {
    if (modelNode[key] === true) {
      return true;
    }
  }
  const capabilities = Array.isArray(modelNode.capabilities) ? modelNode.capabilities : [];
  for (const capability of capabilities) {
    if (typeof capability !== 'string') {
      continue;
    }
    const normalized = capability.trim().toLowerCase();
    if (
      normalized === 'web_search'
      || normalized === 'websearch'
      || normalized === 'web-search'
      || normalized === 'search'
    ) {
      return true;
    }
  }
  return false;
}

function routeHasConfiguredTargets(routePools: VirtualRouterRoutingPool[] | undefined): boolean {
  if (!Array.isArray(routePools) || routePools.length === 0) {
    return false;
  }
  return routePools.some((pool) => {
    if (!pool || typeof pool !== 'object') {
      return false;
    }
    return Array.isArray(pool.targets) && pool.targets.some((target) => typeof target === 'string' && target.trim());
  });
}

function buildCapabilityRoutePool(
  routeName: 'multimodal' | 'vision' | 'web_search',
  targets: string[]
): VirtualRouterRoutingPool {
  return {
    id: `${routeName}-auto-capability`,
    mode: 'priority',
    priority: 180,
    targets: [...targets],
    loadBalancing: {
      strategy: 'weighted',
      weights: Object.fromEntries(targets.map((target) => [target, 1]))
    }
  };
}
