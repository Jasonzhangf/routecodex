// feature_id: config.virtual_router_types
// Deprecated — virtual-router-builder logic fully migrated to Rust bootstrap.
// Shim retained for backward compat with old imports. Delete once all consumers migrate.
export type UnknownRecord = Record<string, unknown>;
export type VirtualRouterProvidersConfig = UnknownRecord;
export type VirtualRouterRoutingConfig = UnknownRecord;
export type VirtualRouterInput = UnknownRecord;

export function config_virtual_router_types_deprecated_shim_boundary(): void {}

// Re-export bootstrapVirtualRouterConfig for transition; consumers should import from bridge directly.
export { bootstrapVirtualRouterConfig } from '../modules/llmswitch/bridge.js';

// Backward-compat shims — throw to catch stale callers.
export function buildVirtualRouterInputFromUserConfig(_userConfig: UnknownRecord): VirtualRouterInput {
  throw new Error('virtual-router-builder deleted. Use bootstrapVirtualRouterConfig.');
}
export async function buildVirtualRouterInputV2(
  userConfig: UnknownRecord,
  _providerRootDir?: string,
  _options?: { routingPolicyGroup?: string; includeAllRoutingPolicyGroups?: boolean }
): Promise<VirtualRouterInput> {
  // Bridge to Rust native bootstrap for transition.
  const { bootstrapVirtualRouterConfig } = await import('../modules/llmswitch/bridge.js');
  const result = await bootstrapVirtualRouterConfig(userConfig as Record<string, unknown>);
  return (result as unknown as VirtualRouterInput) ?? ({} as VirtualRouterInput);
}
