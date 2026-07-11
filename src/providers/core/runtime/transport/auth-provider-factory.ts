/**
 * Auth Provider Factory
 *
 * 负责创建 API Key / Grok session 认证提供者实例。
 */

import { ApiKeyAuthProvider } from '../../../auth/apikey-auth.js';
import { ApiKeyRotator } from '../../../auth/apikey-auth.js';
import {
  GrokAuthProvider,
  isGrokAuthCandidate,
  type GrokAuthConfig
} from '../../../auth/grok-auth.js';
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
    tokenFile?: string;
    authFile?: string;
    disabled?: boolean;
    disabledUntil?: number;
  }>;
  authFile?: string;
  authDir?: string;
  providerRoot?: string;
  tokenUrl?: string;
  earlyRefreshMs?: number;
  clientSurface?: string;
  clientVersion?: string;
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

    const providerId = this.context.config.config.providerId;
    const authWithExtras = auth as ApiKeyAuthWithEntries;
    if (
      isGrokAuthCandidate({
        rawType: auth.rawType,
        providerId,
        tokenFile: auth.tokenFile,
        authFile: authWithExtras.authFile,
        authDir: authWithExtras.authDir,
        entries: authWithExtras.entries
      })
    ) {
      return this.createGrokAuthProvider(authWithExtras);
    }

    return this.createApiKeyAuthProvider(auth);
  }

  private createGrokAuthProvider(auth: ApiKeyAuthWithEntries): IAuthProvider {
    const config: GrokAuthConfig = {
      type: 'apikey',
      apiKey: typeof auth.apiKey === 'string' ? auth.apiKey : '',
      rawType: auth.rawType || 'grok',
      tokenFile: auth.tokenFile,
      authFile: auth.authFile,
      // Always bind independent provider auth folder unless explicitly overridden.
      authDir: auth.authDir || '~/.rcc/provider/grok/auth',
      providerRoot: auth.providerRoot || '~/.rcc/provider/grok',
      entries: auth.entries,
      // Independent grok provider default: priority token rotation.
      selectionMode: auth.selectionMode ?? 'priority',
      tokenUrl: auth.tokenUrl,
      earlyRefreshMs: auth.earlyRefreshMs,
      clientSurface: auth.clientSurface,
      clientVersion: auth.clientVersion
    };
    return new GrokAuthProvider(config);
  }

  private createApiKeyAuthProvider(auth: ApiKeyAuth): IAuthProvider {
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
