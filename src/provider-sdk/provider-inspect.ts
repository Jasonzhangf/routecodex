import type { InitProviderTemplate, ProviderCatalogWebSearchBinding } from '../cli/config/init-provider-catalog.js';
import { buildWeightedRoutePool } from '../cli/config/init-v2-builder.js';
import type { ProviderConfigV2 } from '../config/provider-v2-loader.js';
import {
  normalizeModelsNode,
  readString,
  resolveProviderRuntimeMetadata,
  type ProviderCapabilityMap
} from './provider-runtime-inference.js';

function sortObjectKeys<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
  ) as T;
}

function routePool(routeId: string, target: string): Record<string, unknown>[] {
  return [buildWeightedRoutePool(`${routeId}-primary`, [target])];
}

function summarizeWebSearchBinding(
  binding: ProviderCatalogWebSearchBinding,
  providerId: string,
  defaultModel: string
): Record<string, unknown> {
  const modelId = binding.modelId || defaultModel;
  const providerKey = binding.providerKey || `${providerId}.${modelId}`;
  const routeTarget = binding.routeTarget || providerKey;
  return {
    engineId: binding.engineId,
    providerKey,
    routeTarget,
    modelId,
    executionMode: binding.executionMode,
    ...(binding.directActivation ? { directActivation: binding.directActivation } : {}),
    ...(binding.description ? { description: binding.description } : {}),
    ...(binding.default ? { default: true } : {})
  };
}

function buildWebSearchPolicyOptions(summary: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!summary) {
    return undefined;
  }
  const engineId = readString(summary.engineId);
  const providerKey = readString(summary.providerKey);
  if (!engineId || !providerKey) {
    return undefined;
  }
  return {
    webSearch: {
      engines: [
        {
          id: engineId,
          providerKey,
          ...(readString(summary.modelId) ? { modelId: readString(summary.modelId) } : {}),
          ...(readString(summary.description) ? { description: readString(summary.description) } : {}),
          ...(readString(summary.executionMode) ? { executionMode: readString(summary.executionMode) } : {}),
          ...(readString(summary.directActivation) ? { directActivation: readString(summary.directActivation) } : {}),
          ...(summary.default === true ? { default: true } : {})
        }
      ],
      search: {
        [engineId]: {
          providerKey
        }
      }
    }
  };
}

function buildRoutingHints(args: {
  routeTargets: { default: string; webSearch?: string };
  capabilities?: ProviderCapabilityMap;
  webSearch?: Record<string, unknown>;
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
    notes.push('web_search route suggested from provider webSearch binding.');
  }
  if (args.catalogEntry && !args.webSearch) {
    notes.push(`catalog metadata detected for ${args.catalogEntry.id}, but routing remains config-first.`);
  }

  return {
    routing,
    ...(buildWebSearchPolicyOptions(args.webSearch) ? { policyOptions: buildWebSearchPolicyOptions(args.webSearch) } : {}),
    routeTargets: {
      default: args.routeTargets.default,
      ...(args.routeTargets.webSearch ? { webSearch: args.routeTargets.webSearch } : {})
    },
    notes
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
  const providerNode = typeof config.provider === 'object' && config.provider && !Array.isArray(config.provider)
    ? config.provider
    : {};
  const modelsNode = normalizeModelsNode((providerNode as { models?: unknown }).models);
  const modelIds = Object.keys(modelsNode).sort();
  const configDefaultModel = readString((providerNode as { defaultModel?: unknown }).defaultModel);
  const metadata = resolveProviderRuntimeMetadata(providerId, providerNode, {
    defaultModel: configDefaultModel || modelIds[0] || ''
  });
  const defaultModel = configDefaultModel || metadata.catalogEntry?.defaultModel || modelIds[0] || '';
  const webSearchSummary = metadata.webSearch
    ? summarizeWebSearchBinding(metadata.webSearch, providerId, defaultModel)
    : undefined;
  const baseURL =
    readString((providerNode as { baseURL?: unknown }).baseURL) ||
    readString((providerNode as { baseUrl?: unknown }).baseUrl);
  const compatibilityProfile = readString((providerNode as { compatibilityProfile?: unknown }).compatibilityProfile);
  const authNode = typeof (providerNode as { auth?: unknown }).auth === 'object' && (providerNode as { auth?: unknown }).auth && !Array.isArray((providerNode as { auth?: unknown }).auth)
    ? ((providerNode as { auth: Record<string, unknown> }).auth)
    : undefined;
  const authType = readString(authNode?.type);
  const routeTargets = {
    default: defaultModel ? `${providerId}.${defaultModel}` : providerId,
    ...(webSearchSummary?.routeTarget ? { webSearch: String(webSearchSummary.routeTarget) } : {})
  };

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
    ...(metadata.catalogEntry?.id ? { catalogId: metadata.catalogEntry.id } : {}),
    ...(metadata.catalogEntry?.label ? { catalogLabel: metadata.catalogEntry.label } : {}),
    ...(metadata.sdkBinding ? { sdkBinding: { ...metadata.sdkBinding } } : {}),
    ...(metadata.capabilities ? { capabilities: metadata.capabilities } : {}),
    ...(webSearchSummary ? { webSearch: webSearchSummary } : {}),
    ...(options?.configPath ? { configPath: options.configPath } : {}),
    routeTargets,
    ...(options?.includeRoutingHints
      ? {
          routingHints: buildRoutingHints({
            routeTargets,
            capabilities: metadata.capabilities,
            webSearch: webSearchSummary,
            catalogEntry: metadata.catalogEntry
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
