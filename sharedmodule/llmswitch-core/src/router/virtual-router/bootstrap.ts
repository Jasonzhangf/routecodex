import {
  VirtualRouterError,
  VirtualRouterErrorCode,
  type VirtualRouterBootstrapInput,
  type VirtualRouterBootstrapResult,
  type VirtualRouterConfig
} from './types.js';
import {
  DEFAULT_LOAD_BALANCING
} from './bootstrap/config-defaults.js';
import { asRecord } from './bootstrap/utils.js';
import { bootstrapRoutingWithNative } from './engine-selection/native-virtual-router-bootstrap-routing.js';
import {
  bootstrapProviderProfilesWithNative,
  bootstrapProvidersWithNative
} from './engine-selection/native-virtual-router-bootstrap-providers.js';
import { parseVirtualRouterNativeError } from './engine-selection/native-router-hotpath-loader.js';
import { isNativeDisabledByEnv, makeNativeRequiredError } from './engine-selection/native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBinding } from './engine-selection/native-router-hotpath-loader.js';


export function bootstrapVirtualRouterConfig(
  input: VirtualRouterBootstrapInput
): VirtualRouterBootstrapResult {
  const section = extractVirtualRouterSection(input);
  const providersSource = asRecord(section.providers);
  if (!Object.keys(providersSource).length) {
    throw new VirtualRouterError(
      'Virtual Router requires at least one provider in configuration',
      VirtualRouterErrorCode.CONFIG_ERROR
    );
  }

  const providersBootstrap = bootstrapProvidersWithNative({ providersSource });
  const { runtimeEntries, aliasIndex, modelIndex } = providersBootstrap;
  const routingBootstrap = bootstrapRoutingWithNative({
    routingSource: section.routing,
    aliasIndex,
    modelIndex,
    forwarderIds: section.forwarders ? Object.keys(section.forwarders) : []
  });
  const routingSource = routingBootstrap.routingSource;
  const routing = routingBootstrap.routing;

  const routedTargetKeys = new Set<string>([
    ...routingBootstrap.targetKeys,
    ...collectForwarderTargetKeys(section.forwarders, aliasIndex)
  ]);
  const providerProfilesBootstrap = bootstrapProviderProfilesWithNative({
    routedTargetKeys,
    aliasIndex,
    modelIndex,
    runtimeEntries
  });
  const providerProfiles = providerProfilesBootstrap.profiles;
  const targetRuntime = providerProfilesBootstrap.targetRuntime;
  const configMeta = bootstrapConfigMetaWithNative(section, routingSource);
  const loadBalancing = configMeta.loadBalancing ?? DEFAULT_LOAD_BALANCING;

  const config: VirtualRouterConfig = {
    routing,
    providers: providerProfiles,
    classifier: configMeta.classifier,
    loadBalancing,
    ...(configMeta.health ? { health: configMeta.health } : {}),
    contextRouting: configMeta.contextRouting,
    ...(configMeta.webSearch ? { webSearch: configMeta.webSearch } : {}),
    ...(configMeta.execCommandGuard ? { execCommandGuard: configMeta.execCommandGuard } : {}),
    ...(configMeta.applyPatch ? { applyPatch: configMeta.applyPatch } : {}),
    ...(section.forwarders && Object.keys(section.forwarders).length
      ? { forwarders: section.forwarders }
      : {})
  };

  return {
    config,
    runtime: runtimeEntries,
    targetRuntime,
    providers: providerProfiles,
    routing
  };
}

function collectForwarderTargetKeys(
  forwarders: Record<string, Record<string, unknown>> | undefined,
  aliasIndex: Map<string, string[]>
): string[] {
  if (!forwarders || typeof forwarders !== 'object') {
    return [];
  }
  const out: string[] = [];
  for (const raw of Object.values(forwarders)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }
    const model = readNonEmptyString((raw as Record<string, unknown>).modelId)
      ?? readNonEmptyString((raw as Record<string, unknown>).model);
    const targets = Array.isArray((raw as Record<string, unknown>).targets)
      ? ((raw as Record<string, unknown>).targets as unknown[])
      : [];
    if (!model || !targets.length) {
      continue;
    }
    for (const target of targets) {
      if (!target || typeof target !== 'object' || Array.isArray(target)) {
        continue;
      }
      const targetRecord = target as Record<string, unknown>;
      const providerId = readNonEmptyString(targetRecord.providerId)
        ?? readNonEmptyString(targetRecord.providerKey);
      if (!providerId) {
        continue;
      }
      const aliases = aliasIndex.get(providerId) ?? [];
      for (const alias of aliases) {
        out.push(`${providerId}.${alias}.${model}`);
      }
    }
  }
  return out;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractVirtualRouterSection(
  input: VirtualRouterBootstrapInput
): {
  providers: Record<string, unknown>;
  routing: Record<string, unknown>;
  forwarders?: Record<string, Record<string, unknown>>;
  classifier?: unknown;
  loadBalancing?: unknown;
  health?: unknown;
  contextRouting?: unknown;
  webSearch?: unknown;
  execCommandGuard?: unknown;
  applyPatch?: unknown;
} {
  const root = asRecord(input);
  const section = root.virtualrouter && typeof root.virtualrouter === 'object' ? asRecord(root.virtualrouter) : root;
  const providers = asRecord(section.providers ?? root.providers);
  const routing = asRecord(section.routing ?? root.routing);
  const forwardersRaw = (section as Record<string, unknown>).forwarders
    ?? (root as Record<string, unknown>).forwarders;
  const forwarders = forwardersRaw && typeof forwardersRaw === 'object' && !Array.isArray(forwardersRaw)
    ? (forwardersRaw as Record<string, Record<string, unknown>>)
    : undefined;
  const classifier = section.classifier ?? root.classifier;
  const loadBalancing = section.loadBalancing ?? root.loadBalancing;
  const health = section.health ?? root.health;
  const contextRouting = section.contextRouting ?? root.contextRouting;
  const webSearch = section.webSearch ?? (root as Record<string, unknown>).webSearch;
  const execCommandGuard =
    (section as Record<string, unknown>).execCommandGuard ?? (root as Record<string, unknown>).execCommandGuard;
  const servertool = (section as Record<string, unknown>).servertool ?? (root as Record<string, unknown>).servertool;
  const servertoolRecord = servertool && typeof servertool === 'object' && !Array.isArray(servertool)
    ? (servertool as Record<string, unknown>)
    : undefined;
  const applyPatch = (section as Record<string, unknown>).applyPatch
    ?? (section as Record<string, unknown>).apply_patch
    ?? servertoolRecord?.applyPatch
    ?? servertoolRecord?.apply_patch
    ?? (root as Record<string, unknown>).applyPatch
    ?? (root as Record<string, unknown>).apply_patch;

  return { providers, routing, forwarders, classifier, loadBalancing, health, contextRouting, webSearch, execCommandGuard, applyPatch };
}

type NativeBootstrapConfigMeta = Pick<VirtualRouterConfig, 'classifier' | 'health' | 'contextRouting' | 'webSearch' | 'execCommandGuard' | 'applyPatch' | 'loadBalancing'>;

function requireNativeBootstrapConfigFunction(exportName: string): (...args: string[]) => unknown {
  if (isNativeDisabledByEnv()) {
    throw makeNativeRequiredError(exportName, 'native disabled');
  }
  const binding = loadNativeRouterHotpathBinding() as Record<string, unknown> | null;
  const fn = binding?.[exportName];
  if (typeof fn !== 'function') {
    throw makeNativeRequiredError(exportName);
  }
  return fn as (...args: string[]) => unknown;
}

function bootstrapConfigMetaWithNative(
  section: Record<string, unknown>,
  routingSource: Record<string, unknown>
): NativeBootstrapConfigMeta {
  const fn = requireNativeBootstrapConfigFunction('bootstrapVirtualRouterConfigMetaJson');
  let raw: unknown;
  try {
    raw = fn(JSON.stringify(section), JSON.stringify(routingSource));
  } catch (error) {
    const virtualRouterError = parseVirtualRouterNativeError(error);
    if (virtualRouterError) throw virtualRouterError;
    throw error;
  }
  const returnedVirtualRouterError = parseVirtualRouterNativeError(raw);
  if (returnedVirtualRouterError) {
    throw returnedVirtualRouterError;
  }
  if (typeof raw !== 'string' || !raw) {
    throw new VirtualRouterError(
      'Virtual router native config bootstrap returned empty payload',
      VirtualRouterErrorCode.CONFIG_ERROR
    );
  }
  try {
    return JSON.parse(raw) as NativeBootstrapConfigMeta;
  } catch {
    throw new VirtualRouterError(
      'Virtual router native config bootstrap returned invalid payload',
      VirtualRouterErrorCode.CONFIG_ERROR
    );
  }
}
