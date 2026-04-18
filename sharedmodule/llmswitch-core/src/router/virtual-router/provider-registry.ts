import { VirtualRouterError, VirtualRouterErrorCode } from './types.js';
import type { ProviderProfile, TargetMetadata, ModelCapability } from './types.js';

const NON_BLOCKING_WARN_THROTTLE_MS = 60_000;
const nonBlockingWarnByStage = new Map<string, number>();

function shouldLogNonBlockingStage(stage: string): boolean {
  const now = Date.now();
  const lastAt = nonBlockingWarnByStage.get(stage) ?? 0;
  if (now - lastAt < NON_BLOCKING_WARN_THROTTLE_MS) {
    return false;
  }
  nonBlockingWarnByStage.set(stage, now);
  return true;
}

function logProviderRegistryNonBlocking(
  stage: string,
  operation: string,
  details?: Record<string, unknown>
): void {
  if (!shouldLogNonBlockingStage(stage)) {
    return;
  }
  try {
    const suffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[provider-registry] stage=${stage} operation=${operation} returned empty${suffix}`);
  } catch {
    void 0;
  }
}

export class ProviderRegistry {
  private readonly providers: Map<string, ProviderProfile> = new Map();

  constructor(profiles?: Record<string, ProviderProfile>) {
    if (profiles) {
      this.load(profiles);
    }
  }

  load(profiles: Record<string, ProviderProfile>): void {
    this.providers.clear();
    for (const [key, profile] of Object.entries(profiles)) {
      const normalized = ProviderRegistry.normalizeProfile(key, profile);
      this.providers.set(normalized.providerKey, normalized);
    }
  }

  get(providerKey: string): ProviderProfile {
    const profile = this.providers.get(providerKey);
    if (!profile) {
      throw new VirtualRouterError(`Provider ${providerKey} is not registered`, VirtualRouterErrorCode.CONFIG_ERROR, {
        providerKey
      });
    }
    return profile;
  }

 has(providerKey: string): boolean {
   return this.providers.has(providerKey);
 }

listKeys(): string[] {
  return Array.from(this.providers.keys());
}

  getModelCapabilities(providerKey: string): Set<ModelCapability> {
    const profile = this.providers.get(providerKey);
    if (!profile) {
      logProviderRegistryNonBlocking('capability_lookup', 'get_model_capabilities', {
        providerKey,
        cause: 'provider_not_registered'
      });
      return new Set();
    }
    const modelId = profile.modelId ?? deriveModelId(providerKey);
    if (!modelId) {
      logProviderRegistryNonBlocking('capability_lookup', 'get_model_capabilities', {
        providerKey,
        cause: 'missing_model_id'
      });
      return new Set();
    }
    const capabilities = profile.modelCapabilities?.[modelId];
    if (!capabilities || !Array.isArray(capabilities)) {
      return new Set();
    }
    return new Set(capabilities.filter((c): c is ModelCapability => typeof c === 'string'));
  }

  hasCapability(providerKey: string, capability: ModelCapability): boolean {
    return this.getModelCapabilities(providerKey).has(capability);
  }

  resolveRuntimeKeyByAlias(providerId: string, keyAlias: string): string | null {
    if (!providerId || !keyAlias) {
      logProviderRegistryNonBlocking('runtime_key_alias', 'resolve_runtime_key_by_alias', {
        providerId,
        keyAlias,
        cause: 'invalid_input'
      });
      return null;
    }
    const pattern = new RegExp(`^${providerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.${keyAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.|$)`);
    for (const key of this.providers.keys()) {
      if (pattern.test(key)) {
        return key;
      }
    }
    logProviderRegistryNonBlocking('runtime_key_alias', 'resolve_runtime_key_by_alias', {
      providerId,
      keyAlias,
      cause: this.listProviderKeys(providerId).length > 0 ? 'alias_not_found' : 'provider_not_registered'
    });
    return null;
  }

  resolveRuntimeKeyByIndex(providerId: string, keyIndex: number): string | null {
    const index = keyIndex - 1;
    if (index < 0) {
      logProviderRegistryNonBlocking('runtime_key_index', 'resolve_runtime_key_by_index', {
        providerId,
        keyIndex,
        cause: 'invalid_index'
      });
      return null;
    }

    const keys = this.listProviderKeys(providerId);
    if (index >= keys.length) {
      logProviderRegistryNonBlocking('runtime_key_index', 'resolve_runtime_key_by_index', {
        providerId,
        keyIndex,
        cause: keys.length > 0 ? 'index_out_of_range' : 'provider_not_registered'
      });
      return null;
    }

    return keys[index];
  }

  listProviderKeys(providerId: string): string[] {
    const pattern = new RegExp(`^${providerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`);
    return this.listKeys().filter(key => pattern.test(key));
  }

  resolveRuntimeKeyByModel(providerId: string, modelId: string): string | null {
    if (!providerId || !modelId) {
      logProviderRegistryNonBlocking('runtime_key_model', 'resolve_runtime_key_by_model', {
        providerId,
        modelId,
        cause: 'invalid_input'
      });
      return null;
    }
    const normalizedModel = modelId.trim();
    if (!normalizedModel) {
      logProviderRegistryNonBlocking('runtime_key_model', 'resolve_runtime_key_by_model', {
        providerId,
        modelId,
        cause: 'empty_model_id'
      });
      return null;
    }
    const providerKeys = this.listProviderKeys(providerId);
    if (providerKeys.length === 0) {
      logProviderRegistryNonBlocking('runtime_key_model', 'resolve_runtime_key_by_model', {
        providerId,
        modelId: normalizedModel,
        cause: 'provider_not_registered'
      });
      return null;
    }
    for (const key of providerKeys) {
      const profile = this.providers.get(key);
      const candidate = profile?.modelId ?? deriveModelId(key);
      if (candidate === normalizedModel) {
        return key;
      }
    }
    logProviderRegistryNonBlocking('runtime_key_model', 'resolve_runtime_key_by_model', {
      providerId,
      modelId: normalizedModel,
      cause: 'model_not_found'
    });
    return null;
  }

  buildTarget(providerKey: string): TargetMetadata {
    const profile = this.get(providerKey);
    const modelId = profile.modelId ?? deriveModelId(profile.providerKey);
    if (!modelId) {
      throw new VirtualRouterError(
        `Provider ${providerKey} is missing model identifier`,
        VirtualRouterErrorCode.CONFIG_ERROR,
        { providerKey }
      );
    }
    return {
      providerKey: profile.providerKey,
      providerType: profile.providerType,
      outboundProfile: profile.outboundProfile,
      compatibilityProfile: profile.compatibilityProfile,
      runtimeKey: profile.runtimeKey,
      modelId,
      processMode: profile.processMode || 'chat',
      responsesConfig: profile.responsesConfig,
      streaming: profile.streaming,
      maxOutputTokens: profile.maxOutputTokens,
      maxContextTokens: profile.maxContextTokens,
      ...(profile.anthropicThinkingConfig ? { anthropicThinkingConfig: profile.anthropicThinkingConfig } : {}),
      ...(profile.anthropicThinking ? { anthropicThinking: profile.anthropicThinking } : {}),
      ...(profile.anthropicThinkingBudgets ? { anthropicThinkingBudgets: profile.anthropicThinkingBudgets } : {}),
      ...(profile.deepseek ? { deepseek: profile.deepseek } : {})
    };
  }

  private static normalizeProfile(key: string, profile: ProviderProfile): ProviderProfile {
    const providerKey = profile.providerKey ?? key;
    const modelId = profile.modelId ?? deriveModelId(providerKey);
    return {
      providerKey,
      providerType: profile.providerType,
      endpoint: profile.endpoint,
      auth: profile.auth,
      ...(profile.enabled !== undefined ? { enabled: profile.enabled } : {}),
      outboundProfile: profile.outboundProfile,
      compatibilityProfile: profile.compatibilityProfile,
      runtimeKey: profile.runtimeKey,
      modelId,
      processMode: profile.processMode || 'chat',
      responsesConfig: profile.responsesConfig,
      streaming: profile.streaming,
      maxOutputTokens: profile.maxOutputTokens,
      maxContextTokens: profile.maxContextTokens,
      ...(profile.anthropicThinkingConfig ? { anthropicThinkingConfig: profile.anthropicThinkingConfig } : {}),
      ...(profile.anthropicThinking ? { anthropicThinking: profile.anthropicThinking } : {}),
      ...(profile.anthropicThinkingBudgets ? { anthropicThinkingBudgets: profile.anthropicThinkingBudgets } : {}),
      ...(profile.deepseek ? { deepseek: profile.deepseek } : {}),
      ...(profile.serverToolsDisabled ? { serverToolsDisabled: true } : {}),
      ...(profile.modelCapabilities ? { modelCapabilities: profile.modelCapabilities } : {})
    };
  }
}

function deriveModelId(providerKey: string | undefined): string | undefined {
  if (!providerKey) return undefined;
  const firstDot = providerKey.indexOf('.');
  if (firstDot <= 0 || firstDot === providerKey.length - 1) return undefined;
  const remainder = providerKey.slice(firstDot + 1);
  const secondDot = remainder.indexOf('.');
  if (secondDot <= 0 || secondDot === remainder.length - 1) return remainder.trim() || undefined;
  return remainder.slice(secondDot + 1).trim() || undefined;
}
