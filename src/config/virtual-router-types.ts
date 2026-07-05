export type UnknownRecord = Record<string, unknown>;

export interface VirtualRouterRoutingPool extends UnknownRecord {
  id?: string;
  targets: string[];
}

export type VirtualRouterRoutingConfig = Record<string, VirtualRouterRoutingPool[]>;

export type VirtualRouterProvidersConfig = Record<string, UnknownRecord>;

export interface VirtualRouterInput extends UnknownRecord {
  providers: VirtualRouterProvidersConfig;
  routing: VirtualRouterRoutingConfig;
  routingPolicyGroup?: string;
  forwarders?: Record<string, UnknownRecord>;
  applyPatch?: UnknownRecord;
}

export function buildVirtualRouterInputFromUserConfig(userConfig: UnknownRecord): VirtualRouterInput {
  const vrNode = isRecord(userConfig.virtualrouter) ? (userConfig.virtualrouter as UnknownRecord) : {};
  const providersSource = isRecord(vrNode.providers)
    ? (vrNode.providers as VirtualRouterProvidersConfig)
    : isRecord(userConfig.providers)
    ? (userConfig.providers as VirtualRouterProvidersConfig)
    : {};
  let routingSource: VirtualRouterRoutingConfig = {};
  if (isRecord(vrNode.routing)) {
    routingSource = vrNode.routing as VirtualRouterRoutingConfig;
  } else if (isRecord(vrNode.routingPolicyGroups)) {
    const groupsNode = vrNode.routingPolicyGroups as UnknownRecord;
    const entries = Object.entries(groupsNode)
      .filter(([groupId, groupNode]) => Boolean(groupId.trim()) && isRecord(groupNode))
      .map(([groupId, groupNode]) => [groupId, groupNode as UnknownRecord] as const);
    const activeCandidate = typeof vrNode.activeRoutingPolicyGroup === 'string' ? vrNode.activeRoutingPolicyGroup.trim() : '';
    const activeEntry =
      (activeCandidate ? entries.find(([groupId]) => groupId === activeCandidate) : undefined)
      ?? entries.find(([groupId]) => groupId === 'default')
      ?? entries.sort((a, b) => a[0].localeCompare(b[0]))[0];
    if (activeEntry && isRecord(activeEntry[1].routing)) {
      routingSource = activeEntry[1].routing as VirtualRouterRoutingConfig;
    }
  } else if (isRecord(userConfig.routing)) {
    routingSource = userConfig.routing as VirtualRouterRoutingConfig;
  }

  const forwardersSource = isRecord(vrNode.forwarders)
    ? (vrNode.forwarders as Record<string, UnknownRecord>)
    : isRecord(userConfig.forwarders)
      ? (userConfig.forwarders as Record<string, UnknownRecord>)
      : undefined;

  return {
    ...vrNode,
    providers: { ...providersSource },
    routing: Array.isArray(routingSource) ? {} : { ...routingSource },
    ...(forwardersSource && Object.keys(forwardersSource).length
      ? { forwarders: { ...forwardersSource } }
      : {})
  };
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
