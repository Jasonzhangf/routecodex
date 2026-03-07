import {
  getInitProviderCatalogEntry,
  type InitProviderTemplate,
  type ProviderCatalogCapabilities,
  type ProviderCatalogSdkBinding,
  type ProviderCatalogWebSearchBinding
} from '../cli/config/init-provider-catalog.js';
import type { UnknownRecord } from '../config/virtual-router-types.js';

export type ProviderCapabilityMap = Record<string, boolean>;

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeModelsNode(node: unknown): Record<string, UnknownRecord> {
  if (!isRecord(node)) {
    return {};
  }
  return node as Record<string, UnknownRecord>;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function lower(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeSdkBinding(binding: unknown): ProviderCatalogSdkBinding | undefined {
  if (!isRecord(binding)) {
    return undefined;
  }
  const family = lower(binding.family);
  if (family !== 'openai-compatible' && family !== 'anthropic-compatible' && family !== 'custom-runtime') {
    return undefined;
  }
  return {
    family,
    supported: binding.supported === false ? false : true,
    ...(readString(binding.notes) ? { notes: readString(binding.notes) } : {})
  };
}

function normalizeWebSearchBinding(binding: unknown, args: { providerId: string; defaultModel: string }): ProviderCatalogWebSearchBinding | undefined {
  if (!isRecord(binding)) {
    return undefined;
  }
  const engineId = readString(binding.engineId ?? binding.id);
  const executionModeRaw = lower(binding.executionMode);
  const executionMode = executionModeRaw === 'direct' || executionModeRaw === 'servertool' ? executionModeRaw : undefined;
  if (!engineId || !executionMode) {
    return undefined;
  }
  const modelId = readString(binding.modelId) || args.defaultModel;
  const providerKey = readString(binding.providerKey) || `${args.providerId}.${modelId}`;
  const routeTarget = readString(binding.routeTarget) || providerKey;
  const directActivationRaw = lower(binding.directActivation);
  const directActivation = directActivationRaw === 'route' || directActivationRaw === 'tool' ? directActivationRaw : undefined;
  const description = readString(binding.description) || `${engineId} web search binding`;
  return {
    engineId,
    executionMode,
    providerKey,
    routeTarget,
    description,
    ...(modelId ? { modelId } : {}),
    ...(directActivation ? { directActivation } : {}),
    ...(binding.default === true ? { default: true } : {})
  };
}

function extractWebSearchBindingFromPolicy(
  policyNode: unknown,
  args: { providerId: string; defaultModel: string }
): ProviderCatalogWebSearchBinding | undefined {
  if (!isRecord(policyNode)) {
    return undefined;
  }
  const engines = Array.isArray(policyNode.engines) ? policyNode.engines.filter((entry) => isRecord(entry)) as UnknownRecord[] : [];
  if (!engines.length) {
    return normalizeWebSearchBinding(policyNode, args);
  }
  const preferredEngine = engines.find((engine) => engine.default === true) ?? engines[0];
  const normalized = normalizeWebSearchBinding(preferredEngine, args);
  if (!normalized) {
    return undefined;
  }
  if (normalized.providerKey) {
    return normalized;
  }
  const searchNode = isRecord(policyNode.search) ? policyNode.search : undefined;
  const providerOverride = searchNode && isRecord(searchNode[normalized.engineId])
    ? readString((searchNode[normalized.engineId] as UnknownRecord).providerKey)
    : undefined;
  return providerOverride ? { ...normalized, providerKey: providerOverride, routeTarget: normalized.routeTarget || providerOverride } : normalized;
}

function mergeSdkBinding(
  preferred: ProviderCatalogSdkBinding | undefined,
  fallback: ProviderCatalogSdkBinding | undefined
): ProviderCatalogSdkBinding | undefined {
  if (!preferred && !fallback) {
    return undefined;
  }
  if (!preferred) {
    return fallback ? { ...fallback } : undefined;
  }
  if (!fallback) {
    return { ...preferred };
  }
  return {
    family: preferred.family,
    supported: preferred.supported,
    ...(preferred.notes || fallback.notes ? { notes: preferred.notes || fallback.notes } : {})
  };
}

function mergeCapabilities(
  inferred: ProviderCapabilityMap,
  catalog?: ProviderCatalogCapabilities
): ProviderCapabilityMap | undefined {
  const merged: ProviderCapabilityMap = {};
  for (const [key, value] of Object.entries(catalog ?? {})) {
    if (value) {
      merged[key] = true;
    }
  }
  for (const [key, value] of Object.entries(inferred)) {
    if (value) {
      merged[key] = true;
    }
  }
  return Object.keys(merged).length ? merged : undefined;
}

function inferRuntimeOnlyBinding(
  providerId: string,
  providerType: string,
  authType: string,
  compatibilityProfile: string
): ProviderCatalogSdkBinding | undefined {
  const runtimeOnlyAuths = new Set([
    'antigravity-oauth',
    'deepseek-account',
    'gemini-cli-oauth',
    'iflow-cookie',
    'iflow-oauth'
  ]);
  if (runtimeOnlyAuths.has(authType)) {
    return {
      family: 'custom-runtime',
      supported: false,
      notes: `Provider auth "${authType}" requires the existing RouteCodex runtime path.`
    };
  }
  if (providerType === 'iflow' || providerType === 'gemini-cli-http-provider' || providerType === 'gemini-cli') {
    return {
      family: 'custom-runtime',
      supported: false,
      notes: `Provider type "${providerType || providerId}" requires the existing RouteCodex runtime path.`
    };
  }
  if (compatibilityProfile === 'chat:deepseek-web') {
    return {
      family: 'custom-runtime',
      supported: false,
      notes: 'DeepSeek web-account providers require the existing RouteCodex runtime path.'
    };
  }
  return undefined;
}

function inferSdkBindingFromConfig(providerId: string, providerNode: UnknownRecord): ProviderCatalogSdkBinding | undefined {
  const explicit = normalizeSdkBinding(providerNode.sdkBinding);
  if (explicit) {
    return explicit;
  }
  const providerType = lower(providerNode.type);
  const authType = lower(isRecord(providerNode.auth) ? providerNode.auth.type : undefined);
  const compatibilityProfile = lower(providerNode.compatibilityProfile);
  const runtimeOnly = inferRuntimeOnlyBinding(providerId, providerType, authType, compatibilityProfile);
  if (runtimeOnly) {
    return runtimeOnly;
  }
  if (providerType === 'anthropic') {
    return { family: 'anthropic-compatible', supported: true };
  }
  if (providerType === 'openai' || providerType === 'responses') {
    return { family: 'openai-compatible', supported: true };
  }
  return undefined;
}

function inferCapabilitiesFromConfig(providerNode: UnknownRecord): ProviderCapabilityMap {
  const capabilities: ProviderCapabilityMap = {};
  const explicitCapabilities = isRecord(providerNode.capabilities) ? providerNode.capabilities : undefined;
  for (const key of ['supportsCoding', 'supportsLongContext', 'supportsMultimodal', 'supportsReasoning', 'supportsTools']) {
    if (explicitCapabilities && readBoolean(explicitCapabilities[key])) {
      capabilities[key] = true;
    }
  }

  const providerType = lower(providerNode.type);
  if (providerType === 'openai' || providerType === 'responses' || providerType === 'anthropic') {
    capabilities.supportsTools = true;
  }
  const compatibilityProfile = lower(providerNode.compatibilityProfile);
  if (compatibilityProfile.includes('claude-code')) {
    capabilities.supportsCoding = true;
  }

  for (const [modelId, modelNode] of Object.entries(normalizeModelsNode(providerNode.models))) {
    const normalizedModelId = modelId.toLowerCase();
    const maxContext = Math.max(
      readNumber(modelNode.maxContext) ?? 0,
      readNumber(modelNode.maxContextTokens) ?? 0,
      readNumber(modelNode.contextWindow) ?? 0
    );
    if (maxContext >= 200000) {
      capabilities.supportsLongContext = true;
    }
    if (
      readBoolean(modelNode.supportsThinking) ||
      readBoolean(modelNode.supportsReasoning) ||
      normalizedModelId.includes('thinking')
    ) {
      capabilities.supportsReasoning = true;
    }
    if (/(^|[-._])(coder|codex|code)([-._]|$)/i.test(normalizedModelId)) {
      capabilities.supportsCoding = true;
    }
    if (
      readBoolean(modelNode.supportsVision) ||
      readBoolean(modelNode.supportsImages) ||
      readBoolean(modelNode.supportsImageInput) ||
      readBoolean(modelNode.multimodal) ||
      /(^|[-._])(vl|vision|image)([-._]|$)/i.test(normalizedModelId)
    ) {
      capabilities.supportsMultimodal = true;
    }
  }

  return capabilities;
}

function inferWebSearchFromConfig(
  providerNode: UnknownRecord,
  args: { providerId: string; defaultModel: string }
): ProviderCatalogWebSearchBinding | undefined {
  const direct = normalizeWebSearchBinding(providerNode.webSearch, args);
  if (direct) {
    return direct;
  }
  return extractWebSearchBindingFromPolicy(providerNode.webSearch, args);
}

export type ResolvedProviderRuntimeMetadata = {
  catalogEntry?: InitProviderTemplate;
  sdkBinding?: ProviderCatalogSdkBinding;
  capabilities?: ProviderCapabilityMap;
  webSearch?: ProviderCatalogWebSearchBinding;
};

export function resolveProviderRuntimeMetadata(
  providerId: string,
  providerNode: UnknownRecord,
  args: { defaultModel: string }
): ResolvedProviderRuntimeMetadata {
  const catalogEntry = getInitProviderCatalogEntry(providerId);
  const sdkBinding = mergeSdkBinding(inferSdkBindingFromConfig(providerId, providerNode), catalogEntry?.sdkBinding);
  const capabilities = mergeCapabilities(inferCapabilitiesFromConfig(providerNode), catalogEntry?.capabilities);
  const webSearch = inferWebSearchFromConfig(providerNode, { providerId, defaultModel: args.defaultModel }) ?? catalogEntry?.webSearch;
  return {
    ...(catalogEntry ? { catalogEntry } : {}),
    ...(sdkBinding ? { sdkBinding } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(webSearch ? { webSearch } : {})
  };
}
