// feature_id: config.user_config_materialization
import { loadProviderConfigsV2, type ProviderConfigV2 } from './provider-v2-loader.js';
import { buildProviderProfiles } from '../providers/profile/provider-profile-loader.js';
import type { ProviderProfileCollection } from '../providers/profile/provider-profile.js';
import { isRecord } from '../utils/common-utils.js';
import {
  collectRouteCodexV2ConfigSourceErrorsSync,
  compileRouteCodexRuntimeManifest,
  extractRouteCodexMaterializedProviderConfigsSync,
  materializeRouteCodexUserConfigFromManifestSync,
  normalizeRouteCodexV2RuntimeSourceSync,
  resolvePrimaryRouteCodexRoutingPolicyGroupSync
} from '../modules/llmswitch/bridge.js';

export type UnknownRecord = Record<string, unknown>;
export type VirtualRouterInput = UnknownRecord;

export interface MaterializedRouteCodexConfig {
  userConfig: UnknownRecord;
  providerProfiles: ProviderProfileCollection;
}

export interface RouteCodexRuntimeConfigManifest {
  manifestVersion: 'routecodex.runtime-config.v1';
  routingPolicyGroup?: string | null;
  virtualRouterBootstrapInput: UnknownRecord;
  pipelineRuntimeConfig: UnknownRecord;
  providerIds: string[];
  forwarderIds: string[];
}

export type BuildVirtualRouterInputV2Options = {
  routingPolicyGroup?: string;
  includeAllRoutingPolicyGroups?: boolean;
};

type ProviderConfigMap = Record<string, ProviderConfigV2>;

export async function compileRouteCodexRuntimeConfigManifest(
  userConfig: UnknownRecord,
  providerRootDir?: string,
  options?: BuildVirtualRouterInputV2Options
): Promise<RouteCodexRuntimeConfigManifest> {
  const providerConfigs = extractRouteCodexMaterializedProviderConfigsSync(userConfig) as ProviderConfigMap | null
    ?? (await loadProviderConfigsV2(providerRootDir));
  const requestedRoutingPolicyGroup = typeof options?.routingPolicyGroup === 'string' && options.routingPolicyGroup.trim()
    ? options.routingPolicyGroup.trim()
    : undefined;
  const manifest = await compileRouteCodexRuntimeManifest({
    userConfig,
    providerConfigs,
    options: {
      ...(requestedRoutingPolicyGroup ? { routingPolicyGroup: requestedRoutingPolicyGroup } : {}),
      ...(options?.includeAllRoutingPolicyGroups === true ? { includeAllRoutingPolicyGroups: true } : {})
    }
  });
  const bootstrapInput = isRecord(manifest.virtualRouterBootstrapInput)
    ? manifest.virtualRouterBootstrapInput as UnknownRecord
    : undefined;
  if (!bootstrapInput) {
    throw new Error('[config] Rust runtime config compiler returned invalid virtualRouterBootstrapInput');
  }
  const pipelineRuntimeConfig = isRecord(manifest.pipelineRuntimeConfig)
    ? manifest.pipelineRuntimeConfig as UnknownRecord
    : undefined;
  if (!pipelineRuntimeConfig) {
    throw new Error('[config] Rust runtime config compiler returned invalid pipelineRuntimeConfig');
  }
  const providerIds = Array.isArray(manifest.providerIds)
    ? manifest.providerIds.filter((value: unknown): value is string => typeof value === 'string')
    : undefined;
  const forwarderIds = Array.isArray(manifest.forwarderIds)
    ? manifest.forwarderIds.filter((value: unknown): value is string => typeof value === 'string')
    : undefined;
  if (!providerIds || !forwarderIds || manifest.manifestVersion !== 'routecodex.runtime-config.v1') {
    throw new Error('[config] Rust runtime config compiler returned invalid manifest metadata');
  }
  return {
    manifestVersion: 'routecodex.runtime-config.v1',
    routingPolicyGroup: typeof manifest.routingPolicyGroup === 'string' ? manifest.routingPolicyGroup : null,
    virtualRouterBootstrapInput: bootstrapInput,
    pipelineRuntimeConfig,
    providerIds,
    forwarderIds
  };
}

export async function materializeRouteCodexConfig(
  userConfigInput: UnknownRecord,
  providerRootDir?: string
): Promise<MaterializedRouteCodexConfig> {
  const userConfig = normalizeRouteCodexV2RuntimeSourceSync(userConfigInput);
  validateV2ConfigSources(userConfig);
  const routingPolicyGroup = resolvePrimaryRouteCodexRoutingPolicyGroupSync(userConfig);
  const manifest = await compileRouteCodexRuntimeConfigManifest(userConfig, providerRootDir, {
    ...(routingPolicyGroup ? { routingPolicyGroup } : {})
  });
  const materializedUserConfig = materializeRouteCodexUserConfigFromManifestSync(
    userConfig,
    manifest as unknown as UnknownRecord
  );
  const providerProfiles = buildProviderProfiles(materializedUserConfig);
  return { userConfig: materializedUserConfig, providerProfiles };
}

export function collectV2ConfigSourceErrors(userConfig: UnknownRecord): string[] {
  return collectRouteCodexV2ConfigSourceErrorsSync(userConfig);
}

export function validateV2ConfigSources(userConfig: UnknownRecord): void {
  const errors = collectV2ConfigSourceErrors(userConfig);
  if (errors.length) {
    const message = ['[config] v2 config must use single-source layout:', ...errors].join('\n- ');
    throw new Error(message);
  }
}
