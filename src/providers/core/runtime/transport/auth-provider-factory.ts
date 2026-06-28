/**
 * Auth Provider Factory
 *
 * 负责创建 API Key 认证提供者实例。
 */

import { ApiKeyAuthProvider } from '../../../auth/apikey-auth.js';
import { ApiKeyRotator } from '../../../auth/apikey-auth.js';
import type { IAuthProvider } from '../../../auth/auth-interface.js';
import type { ApiKeyAuth } from '../../api/provider-config.js';
import type { ServiceProfile } from '../../api/provider-types.js';

type ApiKeyAuthWithEntries = ApiKeyAuth & {
  selectionMode?: 'round-robin' | 'priority';
  entries?: Array<{
    alias?: string;
    apiKey?: string;
    env?: string;
    secretRef?: string;
  }>;
};

export interface AuthProviderFactoryContext {
  providerType: string;
  moduleType: string;
  config: {
    config: {
      providerId?: string;
      baseUrl?: string;
      overrides?: {
        baseUrl?: string;
      };
      auth: ApiKeyAuth;
    };
  };
  serviceProfile: ServiceProfile;
}

export class AuthProviderFactory {
  private context: AuthProviderFactoryContext;

  constructor(context: AuthProviderFactoryContext) {
    this.context = context;
  }

  createAuthProvider(): IAuthProvider {
    const auth = this.context.config.config.auth;
    if (auth.type !== 'apikey') {
      throw new Error(`Unsupported auth type: ${auth.type}`);
    }
    return this.createApiKeyAuthProvider(auth);
  }

  private createApiKeyAuthProvider(auth: ApiKeyAuth): IAuthProvider {
    // 检查是否有多 key entries，有则使用轮询模式
    const authWithEntries = auth as ApiKeyAuthWithEntries;
    if (authWithEntries.entries && authWithEntries.entries.length > 0) {
      const rotator = new ApiKeyRotator(
        authWithEntries.entries,
        authWithEntries.selectionMode ?? 'round-robin'
      );
      return new ApiKeyAuthProvider(auth as ApiKeyAuth, rotator);
    }

    return new ApiKeyAuthProvider(auth as ApiKeyAuth);
  }
}
