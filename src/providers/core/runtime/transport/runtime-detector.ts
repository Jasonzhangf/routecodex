/**
 * Runtime Detector
 *
 * 检测特定运行时环境：
 * - isAntigravity
 * - isIflow
 * - isGeminiFamily
 */

import type { ProviderRuntimeMetadata } from '../provider-runtime-metadata.js';

export class RuntimeDetector {
  private config: {
    config: {
      providerId?: string;
    };
  };
  private oauthProviderId?: string;
  private providerType: string;

  constructor(
    config: { config: { providerId?: string } },
    providerType: string,
    oauthProviderId?: string
  ) {
    this.config = config;
    this.providerType = providerType;
    this.oauthProviderId = oauthProviderId;
  }

  isAntigravity(runtimeMetadata?: ProviderRuntimeMetadata): boolean {
    const fromConfig =
      typeof this.config?.config?.providerId === 'string' && this.config.config.providerId.trim()
        ? this.config.config.providerId.trim().toLowerCase()
        : '';
    const fromRuntime =
      typeof runtimeMetadata?.providerId === 'string' && runtimeMetadata.providerId.trim()
        ? runtimeMetadata.providerId.trim().toLowerCase()
        : '';
    const fromProviderKey =
      typeof runtimeMetadata?.providerKey === 'string' && runtimeMetadata.providerKey.trim()
        ? runtimeMetadata.providerKey.trim().toLowerCase()
        : '';
    const fromOAuth = typeof this.oauthProviderId === 'string' ? this.oauthProviderId.trim().toLowerCase() : '';

    if (fromConfig === 'antigravity' || fromRuntime === 'antigravity' || fromOAuth === 'antigravity') {
      return true;
    }
    if (fromProviderKey.startsWith('antigravity.')) {
      return true;
    }
    return false;
  }

  isIflow(runtimeMetadata?: ProviderRuntimeMetadata): boolean {
    const fromConfig =
      typeof this.config?.config?.providerId === 'string' && this.config.config.providerId.trim()
        ? this.config.config.providerId.trim().toLowerCase()
        : '';
    const fromRuntime =
      typeof runtimeMetadata?.providerId === 'string' && runtimeMetadata.providerId.trim()
        ? runtimeMetadata.providerId.trim().toLowerCase()
        : '';
    const fromProviderKey =
      typeof runtimeMetadata?.providerKey === 'string' && runtimeMetadata.providerKey.trim()
        ? runtimeMetadata.providerKey.trim().toLowerCase()
        : '';
    const fromOAuth = typeof this.oauthProviderId === 'string' ? this.oauthProviderId.trim().toLowerCase() : '';

    if (fromConfig === 'iflow' || fromRuntime === 'iflow' || fromOAuth === 'iflow') {
      return true;
    }
    if (fromProviderKey.startsWith('iflow.')) {
      return true;
    }
    return false;
  }

  isGeminiFamily(): boolean {
    const providerType = this.providerType.toLowerCase();
    return providerType === 'gemini' ||
           providerType === 'gemini-cli' ||
           providerType === 'antigravity';
  }
}
