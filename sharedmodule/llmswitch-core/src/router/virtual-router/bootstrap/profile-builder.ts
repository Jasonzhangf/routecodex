import {
  DEFAULT_MODEL_CONTEXT_TOKENS,
  VirtualRouterError,
  VirtualRouterErrorCode,
  type ProviderHealthConfig,
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
    const streamingPref =
      runtime.modelStreaming?.[parsed.modelId] !== undefined
        ? runtime.modelStreaming?.[parsed.modelId]
        : runtime.streaming;
    const contextTokens = resolveContextTokens(runtime, parsed.modelId);
    const outputTokens = resolveOutputTokens(runtime, parsed.modelId);

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
      ...(runtime.deepseek ? { deepseek: runtime.deepseek } : {}),
      ...(runtime.serverToolsDisabled ? { serverToolsDisabled: true } : {})
    };
    targetRuntime[targetKey] = {
      ...runtime,
      modelId: parsed.modelId,
      streaming: streamingPref,
      maxContextTokens: contextTokens
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
