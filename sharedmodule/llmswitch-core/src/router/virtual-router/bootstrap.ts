import {
  VirtualRouterError,
  VirtualRouterErrorCode,
  type AliasSelectionConfig,
  type AliasSelectionStrategy,
  type LoadBalancingPolicy,
  type ProviderAuthConfig,
  type ProviderHealthConfig,
  type ProviderRuntimeProfile,
  type VirtualRouterBootstrapInput,
  type VirtualRouterBootstrapResult,
  type VirtualRouterClassifierConfig,
  type VirtualRouterConfig,
  type VirtualRouterContextRoutingConfig
} from './types.js';
import {
  DEFAULT_CLASSIFIER,
  DEFAULT_CONTEXT_ROUTING,
  DEFAULT_HEALTH,
  DEFAULT_LOAD_BALANCING
} from './bootstrap/config-defaults.js';
import { asRecord } from './bootstrap/utils.js';
import { normalizeClock, normalizeContextRouting, normalizeExecCommandGuard } from './bootstrap/config-normalizers.js';
import { normalizeHealth, buildProviderProfiles } from './bootstrap/profile-builder.js';
import {
  normalizeRouting,
  expandRoutingTable,
  buildRuntimeKey,
  type NormalizedRoutePoolConfig
} from './bootstrap/routing-config.js';
import { normalizeProvider, type NormalizedProvider } from './bootstrap/provider-normalization.js';
import { extractProviderAuthEntries } from './bootstrap/auth-utils.js';
import { normalizeWebSearch, validateWebSearchRouting } from './bootstrap/web-search-config.js';

interface ProviderRuntimeBuildResult {
  runtimeEntries: Record<string, ProviderRuntimeProfile>;
  aliasIndex: Map<string, string[]>;
  modelIndex: Map<string, { declared: boolean; models: string[] }>;
}

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

  const routingSource = normalizeRouting(section.routing);
  const webSearch = normalizeWebSearch(section.webSearch, routingSource);
  validateWebSearchRouting(webSearch, routingSource);
  const execCommandGuard = normalizeExecCommandGuard(section.execCommandGuard);
  const clock = normalizeClock(section.clock);

  const { runtimeEntries, aliasIndex, modelIndex } = buildProviderRuntimeEntries(providersSource);
  const { routing, targetKeys } = expandRoutingTable(routingSource, aliasIndex, modelIndex);

  const expandedTargetKeys = new Set(targetKeys);
  for (const [providerId, aliases] of aliasIndex.entries()) {
    const models = modelIndex.get(providerId)?.models ?? [];
    if (!models.length || !aliases.length) {
      continue;
    }
    for (const alias of aliases) {
      const runtimeKey = buildRuntimeKey(providerId, alias);
      for (const modelId of models) {
        if (modelId && typeof modelId === 'string') {
          expandedTargetKeys.add(`${runtimeKey}.${modelId}`);
        }
      }
    }
  }

  const { profiles: providerProfiles, targetRuntime } = buildProviderProfiles(expandedTargetKeys, runtimeEntries);
  const classifier = normalizeClassifier(section.classifier);
  const loadBalancing = section.loadBalancing ?? DEFAULT_LOAD_BALANCING;
  const health = section.health ?? DEFAULT_HEALTH;
  const contextRouting = section.contextRouting ?? DEFAULT_CONTEXT_ROUTING;

  const config: VirtualRouterConfig = {
    routing,
    providers: providerProfiles,
    classifier,
    loadBalancing,
    health,
    contextRouting,
    ...(webSearch ? { webSearch } : {}),
    ...(execCommandGuard ? { execCommandGuard } : {}),
    ...(clock ? { clock } : {})
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
  classifier?: VirtualRouterClassifierConfig;
  loadBalancing?: LoadBalancingPolicy;
  health?: ProviderHealthConfig;
  contextRouting?: VirtualRouterContextRoutingConfig;
  webSearch?: unknown;
  execCommandGuard?: unknown;
  clock?: unknown;
} {
  const root = asRecord(input);
  const section = root.virtualrouter && typeof root.virtualrouter === 'object' ? asRecord(root.virtualrouter) : root;
  const providers = asRecord(section.providers ?? root.providers);
  const routing = asRecord(section.routing ?? root.routing);
  const classifier = (section.classifier ?? root.classifier) as VirtualRouterClassifierConfig | undefined;
  const loadBalancing = normalizeLoadBalancing(section.loadBalancing ?? root.loadBalancing);
  const health = normalizeHealth(section.health ?? root.health);
  const contextRouting = normalizeContextRouting(section.contextRouting ?? root.contextRouting);
  const webSearch = section.webSearch ?? (root as Record<string, unknown>).webSearch;
  const execCommandGuard =
    (section as Record<string, unknown>).execCommandGuard ?? (root as Record<string, unknown>).execCommandGuard;
  const clock = (section as Record<string, unknown>).clock ?? (root as Record<string, unknown>).clock;

  return { providers, routing, classifier, loadBalancing, health, contextRouting, webSearch, execCommandGuard, clock };
}

function buildProviderRuntimeEntries(providers: Record<string, unknown>): ProviderRuntimeBuildResult {
  const runtimeEntries: Record<string, ProviderRuntimeProfile> = {};
  const aliasIndex = new Map<string, string[]>();
  const modelIndex = new Map<string, { declared: boolean; models: string[] }>();

  for (const [providerId, providerRaw] of Object.entries(providers)) {
    const normalizedProvider = normalizeProvider(providerId, providerRaw);
    modelIndex.set(providerId, collectProviderModels(providerRaw, normalizedProvider));
    const authEntries = extractProviderAuthEntries(providerId, providerRaw);
    if (!authEntries.length) {
      throw new VirtualRouterError(
        `Provider ${providerId} requires at least one auth entry`,
        VirtualRouterErrorCode.CONFIG_ERROR
      );
    }
    aliasIndex.set(providerId, authEntries.map((entry) => entry.keyAlias));
    for (const entry of authEntries) {
      const runtimeKey = buildRuntimeKey(providerId, entry.keyAlias);
      const runtimeAuth: ProviderAuthConfig = {
        type: entry.auth.type,
        rawType: entry.auth.rawType,
        oauthProviderId: entry.auth.oauthProviderId,
        secretRef: entry.auth.secretRef,
        value: entry.auth.value,
        tokenFile: entry.auth.tokenFile,
        tokenUrl: entry.auth.tokenUrl,
        deviceCodeUrl: entry.auth.deviceCodeUrl,
        clientId: entry.auth.clientId,
        clientSecret: entry.auth.clientSecret,
        scopes: entry.auth.scopes && entry.auth.scopes.length ? [...entry.auth.scopes] : undefined,
        authorizationUrl: entry.auth.authorizationUrl,
        userInfoUrl: entry.auth.userInfoUrl,
        refreshUrl: entry.auth.refreshUrl
      };

      if (!runtimeAuth.tokenFile && (runtimeAuth.rawType?.includes('oauth') || runtimeAuth.type === 'oauth')) {
        runtimeAuth.tokenFile = entry.keyAlias;
      }
      if (runtimeAuth.type === 'apiKey' && !runtimeAuth.secretRef) {
        runtimeAuth.secretRef = `${providerId}.${entry.keyAlias}`;
      }
        runtimeEntries[runtimeKey] = {
          runtimeKey,
          providerId,
          keyAlias: entry.keyAlias,
          providerType: normalizedProvider.providerType,
          endpoint: normalizedProvider.endpoint,
          headers: normalizedProvider.headers,
          auth: runtimeAuth,
          ...(normalizedProvider.enabled !== undefined ? { enabled: normalizedProvider.enabled } : {}),
          outboundProfile: normalizedProvider.outboundProfile,
          compatibilityProfile: normalizedProvider.compatibilityProfile,
          processMode: normalizedProvider.processMode,
          responsesConfig: normalizedProvider.responsesConfig,
          streaming: normalizedProvider.streaming,
          modelStreaming: normalizedProvider.modelStreaming,
          modelOutputTokens: normalizedProvider.modelOutputTokens,
          defaultOutputTokens: normalizedProvider.defaultOutputTokens,
          modelContextTokens: normalizedProvider.modelContextTokens,
          defaultContextTokens: normalizedProvider.defaultContextTokens,
          ...(normalizedProvider.deepseek ? { deepseek: normalizedProvider.deepseek } : {}),
          ...(normalizedProvider.serverToolsDisabled ? { serverToolsDisabled: true } : {}),
          ...(normalizedProvider.modelCapabilities ? { modelCapabilities: normalizedProvider.modelCapabilities } : {})
        };
    }
  }

  return { runtimeEntries, aliasIndex, modelIndex };
}

function collectProviderModels(
  providerRaw: unknown,
  _normalizedProvider: NormalizedProvider
): { declared: boolean; models: string[] } {
  const rawModelsNode = (providerRaw as any).models;
  const modelsDeclared = rawModelsNode !== undefined;
  const modelsNode = asRecord(rawModelsNode);
  const collected = new Set<string>();

  for (const [modelName, modelConfigRaw] of Object.entries(modelsNode)) {
    const normalizedModelName = typeof modelName === 'string' ? modelName.trim() : '';
    if (normalizedModelName) {
      collected.add(normalizedModelName);
    }
    const modelConfig = asRecord(modelConfigRaw);
    const aliasesNode = Array.isArray((modelConfig as { aliases?: unknown }).aliases)
      ? ((modelConfig as { aliases: unknown[] }).aliases as unknown[])
      : [];
    for (const alias of aliasesNode) {
      if (typeof alias !== 'string') {
        continue;
      }
      const normalizedAlias = alias.trim();
      if (normalizedAlias) {
        collected.add(normalizedAlias);
      }
    }
  }

  return { declared: modelsDeclared, models: Array.from(collected) };
}

function normalizeClassifier(input?: VirtualRouterClassifierConfig): VirtualRouterClassifierConfig {
  const normalized = asRecord(input) as VirtualRouterClassifierConfig;
  return {
    longContextThresholdTokens:
      typeof normalized.longContextThresholdTokens === 'number'
        ? normalized.longContextThresholdTokens
        : DEFAULT_CLASSIFIER.longContextThresholdTokens,
    thinkingKeywords: normalizeStringArray(normalized.thinkingKeywords, DEFAULT_CLASSIFIER.thinkingKeywords),
    codingKeywords: normalizeStringArray(normalized.codingKeywords, DEFAULT_CLASSIFIER.codingKeywords),
    backgroundKeywords: normalizeStringArray(normalized.backgroundKeywords, DEFAULT_CLASSIFIER.backgroundKeywords),
    visionKeywords: normalizeStringArray(normalized.visionKeywords, DEFAULT_CLASSIFIER.visionKeywords)
  };
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const normalized = value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  return normalized.length ? normalized : [...fallback];
}

function normalizeLoadBalancing(input: unknown): LoadBalancingPolicy | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  const strategyRaw = typeof record.strategy === 'string' ? record.strategy.trim().toLowerCase() : '';
  const weightsRaw = asRecord(record.weights);
  const weightsEntries: Record<string, number> = {};
  for (const [key, value] of Object.entries(weightsRaw)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      weightsEntries[key] = value;
    }
  }
  const healthWeightedRaw = asRecord(record.healthWeighted);
  const healthWeighted =
    Object.keys(healthWeightedRaw).length > 0
      ? {
          ...(typeof healthWeightedRaw.enabled === 'boolean' ? { enabled: healthWeightedRaw.enabled } : {}),
          ...(typeof healthWeightedRaw.recoverToBestOnRetry === 'boolean'
            ? { recoverToBestOnRetry: healthWeightedRaw.recoverToBestOnRetry }
            : {}),
          ...(typeof healthWeightedRaw.baseWeight === 'number' && Number.isFinite(healthWeightedRaw.baseWeight)
            ? { baseWeight: healthWeightedRaw.baseWeight }
            : {}),
          ...(typeof healthWeightedRaw.minMultiplier === 'number' && Number.isFinite(healthWeightedRaw.minMultiplier)
            ? { minMultiplier: healthWeightedRaw.minMultiplier }
            : {}),
          ...(typeof healthWeightedRaw.beta === 'number' && Number.isFinite(healthWeightedRaw.beta)
            ? { beta: healthWeightedRaw.beta }
            : {}),
          ...(typeof healthWeightedRaw.halfLifeMs === 'number' && Number.isFinite(healthWeightedRaw.halfLifeMs)
            ? { halfLifeMs: healthWeightedRaw.halfLifeMs }
            : {})
        }
      : undefined;

  const contextWeightedRaw = asRecord((record as any).contextWeighted);
  const contextWeighted =
    Object.keys(contextWeightedRaw).length > 0
      ? {
          ...(typeof contextWeightedRaw.enabled === 'boolean' ? { enabled: contextWeightedRaw.enabled } : {}),
          ...(typeof contextWeightedRaw.clientCapTokens === 'number' && Number.isFinite(contextWeightedRaw.clientCapTokens)
            ? { clientCapTokens: contextWeightedRaw.clientCapTokens }
            : {}),
          ...(typeof contextWeightedRaw.gamma === 'number' && Number.isFinite(contextWeightedRaw.gamma)
            ? { gamma: contextWeightedRaw.gamma }
            : {}),
          ...(typeof contextWeightedRaw.maxMultiplier === 'number' && Number.isFinite(contextWeightedRaw.maxMultiplier)
            ? { maxMultiplier: contextWeightedRaw.maxMultiplier }
            : {})
        }
      : undefined;

  const aliasSelection = normalizeAliasSelection(record.aliasSelection);

  const hasNonStrategyConfig =
    Object.keys(weightsEntries).length > 0 ||
    Boolean(healthWeighted) ||
    Boolean(contextWeighted) ||
    Boolean(aliasSelection);
  if (!strategyRaw && !hasNonStrategyConfig) {
    return undefined;
  }

  const strategy: LoadBalancingPolicy['strategy'] =
    strategyRaw === 'weighted' || strategyRaw === 'sticky' ? strategyRaw : 'round-robin';

  return {
    strategy,
    ...(Object.keys(weightsEntries).length ? { weights: weightsEntries } : {}),
    ...(aliasSelection ? { aliasSelection } : {}),
    ...(healthWeighted ? { healthWeighted } : {}),
    ...(contextWeighted ? { contextWeighted } : {})
  };
}

function normalizeAliasSelection(raw: unknown): AliasSelectionConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const enabled = typeof record.enabled === 'boolean' ? record.enabled : undefined;
  const defaultStrategy = coerceAliasSelectionStrategy(record.defaultStrategy);
  const sessionLeaseCooldownMs =
    typeof record.sessionLeaseCooldownMs === 'number' && Number.isFinite(record.sessionLeaseCooldownMs)
      ? Math.max(0, Math.floor(record.sessionLeaseCooldownMs))
      : typeof (record as any).sessionLease_cooldown_ms === 'number' &&
          Number.isFinite((record as any).sessionLease_cooldown_ms)
        ? Math.max(0, Math.floor((record as any).sessionLease_cooldown_ms))
        : undefined;
  const antigravitySessionBindingRaw =
    typeof record.antigravitySessionBinding === 'string'
      ? record.antigravitySessionBinding.trim().toLowerCase()
      : typeof (record as any).antigravity_session_binding === 'string'
        ? String((record as any).antigravity_session_binding).trim().toLowerCase()
        : '';
  const antigravitySessionBinding =
    antigravitySessionBindingRaw === 'strict'
      ? 'strict'
      : antigravitySessionBindingRaw === 'lease'
        ? 'lease'
        : undefined;
  const providersRaw = asRecord(record.providers);
  const providers: Record<string, AliasSelectionStrategy> = {};
  for (const [providerId, value] of Object.entries(providersRaw)) {
    const strategy = coerceAliasSelectionStrategy(value);
    if (strategy) {
      providers[providerId] = strategy;
    }
  }
  const out: AliasSelectionConfig = {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(defaultStrategy ? { defaultStrategy } : {}),
    ...(sessionLeaseCooldownMs !== undefined ? { sessionLeaseCooldownMs } : {}),
    ...(antigravitySessionBinding ? { antigravitySessionBinding } : {}),
    ...(Object.keys(providers).length ? { providers } : {})
  };
  return Object.keys(out).length ? out : undefined;
}

function coerceAliasSelectionStrategy(value: unknown): AliasSelectionStrategy | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === 'none') return 'none';
  if (normalized === 'sticky-queue' || normalized === 'sticky_queue' || normalized === 'stickyqueue') {
    return 'sticky-queue';
  }
  return undefined;
}
