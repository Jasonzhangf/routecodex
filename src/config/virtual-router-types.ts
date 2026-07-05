// feature_id: config.virtual_router_types
// Deprecated type shim retained for old imports after Virtual Router bootstrap moved to Rust.
export type UnknownRecord = Record<string, unknown>;
export type VirtualRouterProvidersConfig = UnknownRecord;
export type VirtualRouterRoutingConfig = UnknownRecord;
export type VirtualRouterInput = UnknownRecord;

export function config_virtual_router_types_deprecated_shim_boundary(): void {}

export { bootstrapVirtualRouterConfig } from '../modules/llmswitch/bridge.js';
export {
  buildVirtualRouterInputV2,
  buildVirtualRouterInputV2 as buildRouterBootstrapConfigV2,
  type BuildVirtualRouterInputV2Options
} from './user-config-loader.js';

export function buildVirtualRouterInputFromUserConfig(_userConfig: UnknownRecord): VirtualRouterInput {
  throw new Error('virtual-router-builder deleted. Use bootstrapVirtualRouterConfig.');
}
