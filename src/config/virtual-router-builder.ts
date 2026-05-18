import type {
  UnknownRecord,
  VirtualRouterInput,
  VirtualRouterProvidersConfig,
  VirtualRouterRoutingConfig
} from './virtual-router-types.js';
import { loadProviderConfigsV2 } from './provider-v2-loader.js';
import { formatUnknownError, isRecord } from '../utils/common-utils.js';


function resolveReferencedProviderIdsFromRouting(routing: VirtualRouterRoutingConfig): Set<string> {
  const providerIds = new Set<string>();
  for (const entries of Object.values(routing)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (!isRecord(entry)) {
        continue;
      }

      if (Array.isArray(entry.targets)) {
        for (const target of entry.targets) {
          if (typeof target !== 'string' || !target.trim()) {
            continue;
          }
          const providerId = target.trim().split('.', 1)[0];
          if (providerId) {
            providerIds.add(providerId);
          }
        }
      }

      const loadBalancing = isRecord(entry.loadBalancing) ? (entry.loadBalancing as UnknownRecord) : undefined;
      const weights = isRecord(loadBalancing?.weights) ? (loadBalancing.weights as UnknownRecord) : undefined;
      if (!weights) {
        continue;
      }
      for (const target of Object.keys(weights)) {
        if (typeof target !== 'string' || !target.trim()) {
          continue;
        }
        const providerId = target.trim().split('.', 1)[0];
        if (providerId) {
          providerIds.add(providerId);
        }
      }
    }
  }
  return providerIds;
}

function resolveProviderIdsFromProviderPorts(userConfig: UnknownRecord): Set<string> {
  const ids = new Set<string>();
  const httpserver = isRecord(userConfig.httpserver) ? (userConfig.httpserver as UnknownRecord) : undefined;
  const ports = Array.isArray(httpserver?.ports) ? (httpserver!.ports as unknown[]) : [];
  for (const portRaw of ports) {
    if (!isRecord(portRaw)) {
      continue;
    }
    const mode = typeof portRaw.mode === 'string' ? portRaw.mode.trim().toLowerCase() : '';
    if (mode !== 'provider') {
      continue;
    }
    const binding = typeof portRaw.providerBinding === 'string' ? portRaw.providerBinding.trim() : '';
    if (!binding) {
      continue;
    }
    const providerId = binding.split('.', 1)[0]?.trim();
    if (providerId) {
      ids.add(providerId);
    }
  }
  return ids;
}

function withRoutePolicyGroupTag(routeEntry: unknown, groupId: string): unknown {
  if (!routeEntry || typeof routeEntry !== 'object') {
    return routeEntry;
  }
  if (Array.isArray(routeEntry)) {
    return routeEntry.map((item) => withRoutePolicyGroupTag(item, groupId));
  }
  const record = routeEntry as UnknownRecord;
  const routeParams = isRecord(record.routeParams) ? { ...(record.routeParams as UnknownRecord) } : {};
  if (typeof routeParams.routePolicyGroup !== 'string' || !routeParams.routePolicyGroup.trim()) {
    routeParams.routePolicyGroup = groupId;
  }
  return {
    ...record,
    routeParams,
  };
}

/**
 * Per-port routing: collect ALL groups into global routing config.
 * Per-port allowedProviders filter restricts routing at request time.
 */
function extractRoutingFromUserConfig(userConfig: UnknownRecord): VirtualRouterRoutingConfig {
  const vrNode = isRecord(userConfig.virtualrouter) ? (userConfig.virtualrouter as UnknownRecord) : {};
  const groupsNode = isRecord(vrNode.routingPolicyGroups) ? (vrNode.routingPolicyGroups as UnknownRecord) : undefined;
  if (!groupsNode) {
    throw new Error('[config] v2 config requires virtualrouter.routingPolicyGroups');
  }
  const groupEntries = Object.entries(groupsNode)
    .filter(([groupId, groupNode]) => Boolean(groupId.trim()) && isRecord(groupNode))
    .map(([groupId, groupNode]) => [groupId.trim(), groupNode as UnknownRecord] as const);
  if (groupEntries.length === 0) {
    throw new Error('[config] v2 config requires virtualrouter.routingPolicyGroups with at least one group');
  }
  // Collect routing from ALL groups into a flat RoutingPools config.
  // Per-port allowedProviders filter will restrict routing at request time.
  const routing: VirtualRouterRoutingConfig = {};
  for (const [groupId, groupNode] of groupEntries) {
    const groupRouting = isRecord(groupNode.routing) ? (groupNode.routing as VirtualRouterRoutingConfig) : undefined;
    if (!groupRouting) continue;
    for (const [routeType, routeEntry] of Object.entries(groupRouting)) {
      if (!routeEntry || typeof routeEntry !== 'object') continue;
            const taggedRouteEntry = withRoutePolicyGroupTag(routeEntry, groupId) as any;
      const taggedRouteArray = Array.isArray(taggedRouteEntry) ? taggedRouteEntry : [taggedRouteEntry];
      const existing = Array.isArray(routing[routeType]) ? routing[routeType] as any[] : [];
      routing[routeType] = [...existing, ...taggedRouteArray] as any;
    }
  }
  if (!Object.keys(routing).length) {
    throw new Error('[config] v2 config requires virtualrouter.routingPolicyGroups group with routing field');
  }
  return routing;
}

/**
 * Build a VirtualRouterInput in "v2" mode by combining:
 * - Provider v2 configs loaded from ~/.rcc/provider (or a custom root)
 * - RoutingPools merged from ALL routingPolicyGroups; per-port allowedProviders filter restricts at runtime
 *
 * V2 config is the single source of truth: no legacy routing fallback and no
 * auto-synthesized capability routes are injected here.
 */
export async function buildVirtualRouterInputV2(
  userConfig: UnknownRecord,
  providerRootDir?: string
): Promise<VirtualRouterInput> {
  const routing = extractRoutingFromUserConfig(userConfig);
  const referencedProviderIds = resolveReferencedProviderIdsFromRouting(routing);
  for (const providerId of resolveProviderIdsFromProviderPorts(userConfig)) {
    referencedProviderIds.add(providerId);
  }

  const providerConfigs = await loadProviderConfigsV2(providerRootDir);
  const providers: VirtualRouterProvidersConfig = {};

  for (const [providerId, cfg] of Object.entries(providerConfigs)) {
    if (referencedProviderIds.size > 0 && !referencedProviderIds.has(providerId)) {
      continue;
    }
    providers[providerId] = cfg.provider;
  }

  const input: VirtualRouterInput = {
    providers,
    routing
  };
  return input;
}
