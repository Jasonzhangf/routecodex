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
    modelIndex
  });
  const routingSource = routingBootstrap.routingSource;
  const routing = routingBootstrap.routing;

  const providerProfilesBootstrap = bootstrapProviderProfilesWithNative({
    routedTargetKeys: routingBootstrap.targetKeys,
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
    ...(configMeta.clock ? { clock: configMeta.clock } : {})
  };

  return {
    config,
    runtime: runtimeEntries,
    targetRuntime,
    providers: providerProfiles,
    routing
  };
}

function extractVirtualRouterSection(
  input: VirtualRouterBootstrapInput
): {
  providers: Record<string, unknown>;
  routing: Record<string, unknown>;
  classifier?: unknown;
  loadBalancing?: unknown;
  health?: unknown;
  contextRouting?: unknown;
  webSearch?: unknown;
  execCommandGuard?: unknown;
  clock?: unknown;
} {
  const root = asRecord(input);
  const section = root.virtualrouter && typeof root.virtualrouter === 'object' ? asRecord(root.virtualrouter) : root;
  const providers = asRecord(section.providers ?? root.providers);
  const routing = asRecord(section.routing ?? root.routing);
  const classifier = section.classifier ?? root.classifier;
  const loadBalancing = section.loadBalancing ?? root.loadBalancing;
  const health = section.health ?? root.health;
  const contextRouting = section.contextRouting ?? root.contextRouting;
  const webSearch = section.webSearch ?? (root as Record<string, unknown>).webSearch;
  const execCommandGuard =
    (section as Record<string, unknown>).execCommandGuard ?? (root as Record<string, unknown>).execCommandGuard;
  const clock = (section as Record<string, unknown>).clock ?? (root as Record<string, unknown>).clock;

  return { providers, routing, classifier, loadBalancing, health, contextRouting, webSearch, execCommandGuard, clock };
}

type NativeBootstrapConfigMeta = Pick<VirtualRouterConfig, 'classifier' | 'health' | 'contextRouting' | 'webSearch' | 'execCommandGuard' | 'clock' | 'loadBalancing'>;

const VIRTUAL_ROUTER_ERROR_PREFIX = 'VIRTUAL_ROUTER_ERROR:';

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

function extractNativeErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error ?? 'unknown error');
}

function parseVirtualRouterNativeError(error: unknown): VirtualRouterError | null {
  const message = extractNativeErrorMessage(error);
  if (!message) return null;
  const normalized = message.startsWith('Error:') ? message.replace(/^Error:\s*/, '') : message;
  if (!normalized.startsWith(VIRTUAL_ROUTER_ERROR_PREFIX)) {
    return null;
  }
  const remainder = normalized.slice(VIRTUAL_ROUTER_ERROR_PREFIX.length);
  const index = remainder.indexOf(':');
  if (index <= 0) return null;
  const code = remainder.slice(0, index);
  const detail = remainder.slice(index + 1).trim() || 'Virtual router error';
  if (!Object.values(VirtualRouterErrorCode).includes(code as VirtualRouterErrorCode)) {
    return null;
  }
  return new VirtualRouterError(detail, code as VirtualRouterErrorCode);
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
