export type UnknownRecord = Record<string, unknown>;

export interface VirtualRouterRoutingPool extends UnknownRecord {
  id?: string;
  targets: string[];
}

export type VirtualRouterRoutingConfig = Record<string, VirtualRouterRoutingPool[]>;

export type VirtualRouterProvidersConfig = Record<string, UnknownRecord>;

/**
 * Host-side view of the Virtual Router input passed into
 * `bootstrapVirtualRouterConfig`. This is intentionally loose and mirrors
 * the `virtualrouter` section of the user config.
 */
export interface VirtualRouterInput extends UnknownRecord {
  providers: VirtualRouterProvidersConfig;
  routing: VirtualRouterRoutingConfig;
}

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Derive a VirtualRouterInput shape from the raw user config.
 * This mirrors the legacy fallback logic where `providers` / `routing`
 * could live either under `virtualrouter` or at the top level.
 *
 * This function does not mutate the input and is currently intended
 * for tests and migration tooling.
 */
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

  return {
    ...vrNode,
    providers: { ...providersSource },
    routing: Array.isArray(routingSource) ? {} : { ...routingSource }
  };
}
