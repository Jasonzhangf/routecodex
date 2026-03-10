import { VirtualRouterError, VirtualRouterErrorCode } from './types.js';
import type { ProviderProfile, TargetMetadata } from './types.js';

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

  resolveRuntimeKeyByAlias(providerId: string, keyAlias: string): string | null {
    const pattern = new RegExp(`^${providerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.${keyAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.|$)`);
    for (const key of this.providers.keys()) {
      if (pattern.test(key)) {
        return key;
      }
    }
    return null;
  }

  resolveRuntimeKeyByIndex(providerId: string, keyIndex: number): string | null {
    const index = keyIndex - 1;
    if (index < 0) return null;

    const keys = this.listProviderKeys(providerId);
    if (index >= keys.length) return null;

    return keys[index];
  }

  listProviderKeys(providerId: string): string[] {
    const pattern = new RegExp(`^${providerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`);
    return this.listKeys().filter(key => pattern.test(key));
  }

  resolveRuntimeKeyByModel(providerId: string, modelId: string): string | null {
    if (!providerId || !modelId) {
      return null;
    }
    const normalizedModel = modelId.trim();
    if (!normalizedModel) {
      return null;
    }
    const providerKeys = this.listProviderKeys(providerId);
    for (const key of providerKeys) {
      const profile = this.providers.get(key);
      const candidate = profile?.modelId ?? deriveModelId(key);
      if (candidate === normalizedModel) {
        return key;
      }
    }
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
      ...(profile.deepseek ? { deepseek: profile.deepseek } : {}),
      ...(profile.serverToolsDisabled ? { serverToolsDisabled: true } : {})
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
