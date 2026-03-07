import {
  buildCatalogWebSearchDefaults,
  getInitProviderCatalogEntry,
  type ProviderCatalogCapabilities,
  type InitProviderTemplate,
  type ProviderCatalogWebSearchBinding
} from '../cli/config/init-provider-catalog.js';
import { buildWeightedRoutePool } from '../cli/config/init-v2-builder.js';
import type { ProviderConfigV2 } from '../config/provider-v2-loader.js';
import type { UnknownRecord } from '../config/virtual-router-types.js';

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeModelsNode(node: unknown): Record<string, UnknownRecord> {
  if (!isRecord(node)) {
    return {};
  }
  return node as Record<string, UnknownRecord>;
}

function sortObjectKeys<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
  ) as T;
}

function routePool(routeId: string, target: string): Record<string, unknown>[] {
  return [buildWeightedRoutePool(`${routeId}-primary`, [target])];
}

function buildRoutingHints(args: {
  routeTargets: { default: string; webSearch?: string };
  capabilities?: Record<string, boolean>;
  catalogEntry?: InitProviderTemplate;
}): ProviderRoutingHints {
  const routing: Record<string, unknown> = {
    default: routePool('default', args.routeTargets.default),
    thinking: routePool('thinking', args.routeTargets.default),
    tools: routePool('tools', args.routeTargets.default)
  };
  const notes: string[] = [
    'default/thinking/tools are always suggested so a single provider can be dropped into a fresh weighted pool.'
  ];

  if (args.capabilities?.supportsCoding) {
    routing.coding = routePool('coding', args.routeTargets.default);
    notes.push('coding route suggested from supportsCoding capability.');
  }
  if (args.capabilities?.supportsLongContext) {
    routing.longcontext = routePool('longcontext', args.routeTargets.default);
    notes.push('longcontext route suggested from supportsLongContext capability.');
  }
  if (args.capabilities?.supportsMultimodal) {
    routing.multimodal = routePool('multimodal', args.routeTargets.default);
    notes.push('multimodal route suggested from supportsMultimodal capability.');
  }
  if (args.routeTargets.webSearch) {
    routing.web_search = routePool('web_search', args.routeTargets.webSearch);
    notes.push('web_search route suggested from catalog webSearch binding.');
  }

  const webSearchDefaults = args.catalogEntry ? buildCatalogWebSearchDefaults([args.catalogEntry]) : null;

  return {
    routing,
    ...(webSearchDefaults?.webSearch ? { policyOptions: { webSearch: webSearchDefaults.webSearch } } : {}),
    routeTargets: {
      default: args.routeTargets.default,
      ...(args.routeTargets.webSearch ? { webSearch: args.routeTargets.webSearch } : {})
    },
    notes
  };
}

function toCapabilitiesMap(capabilities?: ProviderCatalogCapabilities): Record<string, boolean> {
  const entries = Object.entries(capabilities ?? {})
    .filter(([, enabled]) => Boolean(enabled))
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries) as Record<string, boolean>;
}

function toWebSearchSummary(
  catalogEntry: InitProviderTemplate | undefined,
  providerId: string,
  defaultModel: string
): Record<string, unknown> | undefined {
  const binding = catalogEntry?.webSearch;
  if (!binding) {
    return undefined;
  }
  return summarizeWebSearchBinding(binding, providerId, defaultModel);
}

function summarizeWebSearchBinding(
  binding: ProviderCatalogWebSearchBinding,
  providerId: string,
  defaultModel: string
): Record<string, unknown> {
  const modelId = binding.modelId || defaultModel;
  return {
    engineId: binding.engineId,
    providerKey: binding.providerKey || `${providerId}.${modelId}`,
    routeTarget: binding.routeTarget || binding.providerKey || `${providerId}.${modelId}`,
    modelId,
    executionMode: binding.executionMode,
    ...(binding.directActivation ? { directActivation: binding.directActivation } : {}),
    ...(binding.description ? { description: binding.description } : {}),
    ...(binding.default ? { default: true } : {})
  };
}

export interface ProviderRoutingHints {
  routing: Record<string, unknown>;
  policyOptions?: Record<string, unknown>;
  routeTargets: {
    default: string;
    webSearch?: string;
  };
  notes: string[];
}

export function buildRoutingHintsConfigFragment(
  hints: ProviderRoutingHints,
  policyId = 'default'
): Record<string, unknown> {
  const normalizedPolicyId = policyId.trim() || 'default';
  return {
    virtualrouter: {
      activeRoutingPolicyGroup: normalizedPolicyId,
      routingPolicyGroups: {
        [normalizedPolicyId]: {
          ...(hints.policyOptions ?? {}),
          routing: hints.routing
        }
      }
    }
  };
}

export interface ProviderInspection {
  providerId: string;
  version: string;
  providerType: string;
  baseURL?: string;
  authType?: string;
  defaultModel: string;
  modelCount: number;
  models: string[];
  compatibilityProfile?: string;
  sdkBinding?: Record<string, unknown>;
  capabilities?: Record<string, boolean>;
  webSearch?: Record<string, unknown>;
  configPath?: string;
  catalogId?: string;
  catalogLabel?: string;
  routeTargets: {
    default: string;
    webSearch?: string;
  };
  routingHints?: ProviderRoutingHints;
}

export function inspectProviderConfig(
  config: ProviderConfigV2,
  options?: { configPath?: string; includeRoutingHints?: boolean }
): ProviderInspection {
  const providerId = config.providerId;
  const providerNode = isRecord(config.provider) ? config.provider : {};
  const modelsNode = normalizeModelsNode((providerNode as { models?: unknown }).models);
  const modelIds = Object.keys(modelsNode).sort();
  const catalogEntry = getInitProviderCatalogEntry(providerId);
  const defaultModel =
    readString((providerNode as { defaultModel?: unknown }).defaultModel) ||
    catalogEntry?.defaultModel ||
    modelIds[0] ||
    '';
  const baseURL =
    readString((providerNode as { baseURL?: unknown }).baseURL) ||
    readString((providerNode as { baseUrl?: unknown }).baseUrl);
  const compatibilityProfile = readString((providerNode as { compatibilityProfile?: unknown }).compatibilityProfile);
  const authNode = isRecord((providerNode as { auth?: unknown }).auth)
    ? (providerNode as { auth: UnknownRecord }).auth
    : undefined;
  const authType = readString(authNode?.type);
  const webSearch = toWebSearchSummary(catalogEntry, providerId, defaultModel);

  const capabilities = catalogEntry?.capabilities ? toCapabilitiesMap(catalogEntry.capabilities) : undefined;

  const inspection: ProviderInspection = {
    providerId,
    version: config.version,
    providerType: readString((providerNode as { type?: unknown }).type) || 'unknown',
    ...(baseURL ? { baseURL } : {}),
    ...(compatibilityProfile ? { compatibilityProfile } : {}),
    ...(authType ? { authType } : {}),
    defaultModel,
    modelCount: modelIds.length,
    models: modelIds,
    ...(catalogEntry?.id ? { catalogId: catalogEntry.id } : {}),
    ...(catalogEntry?.label ? { catalogLabel: catalogEntry.label } : {}),
    ...(catalogEntry?.sdkBinding ? { sdkBinding: { ...catalogEntry.sdkBinding } } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(webSearch ? { webSearch } : {}),
    ...(options?.configPath ? { configPath: options.configPath } : {}),
    routeTargets: {
      default: defaultModel ? `${providerId}.${defaultModel}` : providerId,
      ...(catalogEntry?.webSearch
        ? { webSearch: summarizeWebSearchBinding(catalogEntry.webSearch, providerId, defaultModel).routeTarget as string }
        : {})
    },
    ...(options?.includeRoutingHints
      ? {
          routingHints: buildRoutingHints({
            routeTargets: {
              default: defaultModel ? `${providerId}.${defaultModel}` : providerId,
              ...(catalogEntry?.webSearch
                ? { webSearch: summarizeWebSearchBinding(catalogEntry.webSearch, providerId, defaultModel).routeTarget as string }
                : {})
            },
            capabilities,
            catalogEntry
          })
        }
      : {})
  };

  return {
    ...inspection,
    ...(inspection.sdkBinding ? { sdkBinding: sortObjectKeys(inspection.sdkBinding) } : {}),
    ...(inspection.capabilities ? { capabilities: sortObjectKeys(inspection.capabilities) } : {})
  };
}
