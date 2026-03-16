import {
  DEFAULT_MODEL_CONTEXT_TOKENS,
  VirtualRouterError,
  VirtualRouterErrorCode,
  type ProviderHealthConfig,
  type AnthropicThinkingConfig,
  type AnthropicThinkingBudgetMap,
  type ProviderProfile,
  type ProviderRuntimeProfile
} from '../types.js';
import { buildRuntimeKey, parseTargetKey } from './routing-config.js';

export function buildProviderProfiles(
  targetKeys: Set<string>,
  runtimeEntries: Record<string, ProviderRuntimeProfile>
): { profiles: Record<string, ProviderProfile>; targetRuntime: Record<string, ProviderRuntimeProfile> } {
  const profiles: Record<string, ProviderProfile> = {};
  const targetRuntime: Record<string, ProviderRuntimeProfile> = {};
  for (const targetKey of targetKeys) {
    const parsed = parseTargetKey(targetKey);
    if (!parsed) continue;
    const runtimeKey = buildRuntimeKey(parsed.providerId, parsed.keyAlias);
    const runtime = runtimeEntries[runtimeKey];
    if (!runtime) {
      throw new VirtualRouterError(
        `Routing target ${targetKey} references unknown runtime key ${runtimeKey}`,
        VirtualRouterErrorCode.CONFIG_ERROR
      );
    }
    const modelStreamingPref = runtime.modelStreaming?.[parsed.modelId];
    const streamingPref =
      runtime.streaming === 'always' || runtime.streaming === 'never'
        ? runtime.streaming
        : modelStreamingPref !== undefined
          ? modelStreamingPref
          : runtime.streaming;
    const contextTokens = resolveContextTokens(runtime, parsed.modelId);
    const outputTokens = resolveOutputTokens(runtime, parsed.modelId);
    const anthropicThinkingConfig = resolveAnthropicThinkingConfig(runtime, parsed.modelId);
    const anthropicThinking = resolveAnthropicThinking(runtime, parsed.modelId);
    const anthropicThinkingBudgets = resolveAnthropicThinkingBudgets(runtime, parsed.modelId);
    const modelCapabilities = runtime.modelCapabilities;

    profiles[targetKey] = {
      providerKey: targetKey,
      providerType: runtime.providerType,
      endpoint: runtime.endpoint,
      auth: { ...runtime.auth },
      ...(runtime.enabled !== undefined ? { enabled: runtime.enabled } : {}),
      outboundProfile: runtime.outboundProfile,
      compatibilityProfile: runtime.compatibilityProfile,
      runtimeKey,
      modelId: parsed.modelId,
      processMode: runtime.processMode || 'chat',
      responsesConfig: runtime.responsesConfig,
      streaming: streamingPref,
      maxOutputTokens: outputTokens,
      maxContextTokens: contextTokens,
      ...(anthropicThinkingConfig ? { anthropicThinkingConfig } : {}),
      ...(anthropicThinking ? { anthropicThinking } : {}),
      ...(anthropicThinkingBudgets ? { anthropicThinkingBudgets } : {}),
      ...(runtime.deepseek ? { deepseek: runtime.deepseek } : {}),
      ...(runtime.serverToolsDisabled ? { serverToolsDisabled: true } : {}),
      ...(modelCapabilities ? { modelCapabilities } : {})
    };
    targetRuntime[targetKey] = {
      ...runtime,
      modelId: parsed.modelId,
      streaming: streamingPref,
      maxContextTokens: contextTokens,
      ...(anthropicThinkingConfig ? { anthropicThinkingConfig } : {}),
      ...(anthropicThinking ? { anthropicThinking } : {}),
      ...(anthropicThinkingBudgets ? { anthropicThinkingBudgets } : {})
    };
  }
  return { profiles, targetRuntime };
}

export function resolveContextTokens(runtime: ProviderRuntimeProfile, modelId: string): number {
  const specific = runtime.modelContextTokens?.[modelId];
  if (typeof specific === 'number' && Number.isFinite(specific) && specific > 0) {
    return Math.floor(specific);
  }
  const fallback = runtime.defaultContextTokens ?? runtime.maxContextTokens;
  if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0) {
    return Math.floor(fallback);
  }
  return DEFAULT_MODEL_CONTEXT_TOKENS;
}

export function resolveOutputTokens(runtime: ProviderRuntimeProfile, modelId: string): number | undefined {
  const specific = runtime.modelOutputTokens?.[modelId];
  if (typeof specific === 'number' && Number.isFinite(specific) && specific > 0) {
    return Math.floor(specific);
  }
  const fallback = runtime.defaultOutputTokens;
  if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0) {
    return Math.floor(fallback);
  }
  return undefined;
}

export function resolveAnthropicThinking(runtime: ProviderRuntimeProfile, modelId: string): string | undefined {
  const config = resolveAnthropicThinkingConfig(runtime, modelId);
  if (config?.effort) {
    return config.effort;
  }
  if (config?.mode) {
    return config.mode;
  }
  const specific = runtime.modelAnthropicThinking?.[modelId];
  if (typeof specific === 'string' && specific.trim()) {
    return specific.trim().toLowerCase();
  }
  const fallback = runtime.defaultAnthropicThinking;
  if (typeof fallback === 'string' && fallback.trim()) {
    return fallback.trim().toLowerCase();
  }
  return undefined;
}

export function resolveAnthropicThinkingConfig(
  runtime: ProviderRuntimeProfile,
  modelId: string
): AnthropicThinkingConfig | undefined {
  const specific = runtime.modelAnthropicThinkingConfig?.[modelId];
  if (specific) {
    return { ...specific };
  }
  if (runtime.anthropicThinkingConfig) {
    return { ...runtime.anthropicThinkingConfig };
  }
  if (runtime.defaultAnthropicThinkingConfig) {
    return { ...runtime.defaultAnthropicThinkingConfig };
  }
  return undefined;
}

export function resolveAnthropicThinkingBudgets(
  runtime: ProviderRuntimeProfile,
  modelId: string
): AnthropicThinkingBudgetMap | undefined {
  const specific = runtime.modelAnthropicThinkingBudgets?.[modelId];
  if (specific) {
    return { ...specific };
  }
  if (runtime.anthropicThinkingBudgets) {
    return { ...runtime.anthropicThinkingBudgets };
  }
  if (runtime.defaultAnthropicThinkingBudgets) {
    return { ...runtime.defaultAnthropicThinkingBudgets };
  }
  return undefined;
}

export function normalizeHealth(input: unknown): ProviderHealthConfig | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  const failureThreshold =
    typeof record.failureThreshold === 'number' ? record.failureThreshold : undefined;
  const cooldownMs = typeof record.cooldownMs === 'number' ? record.cooldownMs : undefined;
  const fatalCooldownMs =
    typeof record.fatalCooldownMs === 'number' ? record.fatalCooldownMs : undefined;
  if (typeof failureThreshold !== 'number' || typeof cooldownMs !== 'number') {
    return undefined;
  }
  return fatalCooldownMs !== undefined
    ? { failureThreshold, cooldownMs, fatalCooldownMs }
    : { failureThreshold, cooldownMs };
}
