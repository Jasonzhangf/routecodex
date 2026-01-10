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
  const routingSource = isRecord(vrNode.routing)
    ? (vrNode.routing as VirtualRouterRoutingConfig)
    : isRecord(userConfig.routing)
    ? (userConfig.routing as VirtualRouterRoutingConfig)
    : {};

  return {
    ...vrNode,
    providers: { ...providersSource },
    routing: Array.isArray(routingSource) ? {} : { ...routingSource }
  };
}

