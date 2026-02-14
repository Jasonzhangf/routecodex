/**
 * Auth Provider Factory
 *
 * 负责创建各种认证提供者实例：
 * - ApiKeyAuthProvider
 * - OAuthAuthProvider
 * - TokenFileAuthProvider
 * - IflowCookieAuthProvider
 */

import { ApiKeyAuthProvider } from '../../../auth/apikey-auth.js';
import { OAuthAuthProvider } from '../../../auth/oauth-auth.js';
import { TokenFileAuthProvider } from '../../../auth/tokenfile-auth.js';
import { IflowCookieAuthProvider } from '../../../auth/iflow-cookie-auth.js';
import { ApiKeyRotator } from '../../../auth/apikey-auth.js';
import { getProviderFamilyProfile } from '../../../profile/profile-registry.js';
import type { IAuthProvider } from '../../../auth/auth-interface.js';
import type { ApiKeyAuth, OAuthAuth } from '../../api/provider-config.js';
import type { ServiceProfile } from '../../api/provider-types.js';

type OAuthAuthExtended = OAuthAuth & {
  rawType?: string;
  oauthProviderId?: string;
  tokenFile?: string;
};

type ApiKeyAuthWithEntries = ApiKeyAuth & {
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
      auth: ApiKeyAuth | OAuthAuth;
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
    const authMode = this.normalizeAuthMode(auth.type);

    // 根据认证类型创建对应的认证提供者
    if (authMode === 'apikey') {
      return this.createApiKeyAuthProvider(auth as ApiKeyAuth);
    } else if (authMode === 'oauth') {
      return this.createOAuthAuthProvider(auth as OAuthAuthExtended);
    } else {
      throw new Error(`Unsupported auth type: ${auth.type}`);
    }
  }

  private createApiKeyAuthProvider(auth: ApiKeyAuth): IAuthProvider {
    const rawTypeValue =
      typeof (auth as unknown as { rawType?: unknown }).rawType === 'string'
        ? String((auth as unknown as { rawType: string }).rawType)
        : typeof (auth as { type?: unknown }).type === 'string'
          ? String((auth as { type: string }).type)
          : '';
    const rawType = rawTypeValue.toLowerCase();
    const providerId = typeof (this.context.config.config.providerId) === 'string'
      ? this.context.config.config.providerId.toLowerCase()
      : '';
    const baseUrl = typeof this.context.config.config.baseUrl === 'string'
      ? this.context.config.config.baseUrl.toLowerCase()
      : '';
    const isIflowFamily =
      providerId === 'iflow' ||
      baseUrl.includes('apis.iflow.cn') ||
      baseUrl.includes('iflow.cn');

    // iFlow Cookie 模式：使用浏览器导出的 Cookie 交换 API Key，避免频繁走 OAuth。
    if (
      isIflowFamily &&
      (rawType === 'iflow-cookie' ||
        (!((auth as ApiKeyAuth).apiKey) &&
          (typeof (auth as unknown as { cookie?: unknown }).cookie === 'string' ||
            typeof (auth as unknown as { cookieFile?: unknown }).cookieFile === 'string')))
    ) {
      return new IflowCookieAuthProvider(auth as unknown as Record<string, unknown>);
    }

    // 检查是否有多 key entries，有则使用轮询模式
    const authWithEntries = auth as ApiKeyAuthWithEntries;
    if (authWithEntries.entries && authWithEntries.entries.length > 0) {
      const rotator = new ApiKeyRotator(authWithEntries.entries);
      return new ApiKeyAuthProvider(auth as ApiKeyAuth, rotator);
    }

    return new ApiKeyAuthProvider(auth as ApiKeyAuth);
  }

  private createOAuthAuthProvider(auth: OAuthAuthExtended): IAuthProvider {
    const resolvedOAuthProviderId = this.ensureOAuthProviderId(auth);
    const serviceProfileKey =
      this.context.moduleType === 'gemini-cli-http-provider'
        ? 'gemini-cli'
        : (resolvedOAuthProviderId ?? this.context.providerType);

    const familyProfile = getProviderFamilyProfile({
      providerId: this.context.config.config.providerId,
      providerType: this.context.providerType,
      oauthProviderId: resolvedOAuthProviderId
    });

    const profileTokenFileMode = familyProfile?.resolveOAuthTokenFileMode?.({
      oauthProviderId: resolvedOAuthProviderId,
      auth: {
        clientId: auth.clientId,
        tokenUrl: auth.tokenUrl,
        deviceCodeUrl: auth.deviceCodeUrl
      },
      moduleType: this.context.moduleType
    });

    // For providers like Qwen/iflow/Gemini CLI where public OAuth client may not be available,
    // allow reading tokens produced by external login tools (CLIProxyAPI) via token file.
    const useTokenFile =
      (typeof profileTokenFileMode === 'boolean'
        ? profileTokenFileMode
        : (
            resolvedOAuthProviderId === 'qwen' ||
            resolvedOAuthProviderId === 'iflow' ||
            this.context.moduleType === 'gemini-cli-http-provider'
          )) &&
      !auth.clientId &&
      !auth.tokenUrl &&
      !auth.deviceCodeUrl;

    if (useTokenFile) {
      // Keep TokenFileAuthProvider pure: do not infer providerId from type/rawType.
      // The creator already knows oauthProviderId and must pass it explicitly.
      return new TokenFileAuthProvider({ ...auth, oauthProviderId: resolvedOAuthProviderId } as OAuthAuthExtended);
    }
    return new OAuthAuthProvider(auth, resolvedOAuthProviderId);
  }

  private normalizeAuthMode(type: unknown): 'apikey' | 'oauth' {
    return typeof type === 'string' && type.toLowerCase().includes('oauth') ? 'oauth' : 'apikey';
  }

  private resolveOAuthProviderId(type: unknown): string | undefined {
    if (typeof type !== 'string') {
      return undefined;
    }
    const match = type.toLowerCase().match(/^([a-z0-9._-]+)-oauth$/);
    return match ? match[1] : undefined;
  }

  private ensureOAuthProviderId(auth: OAuthAuthExtended): string {
    const fromAuthField =
      typeof auth?.oauthProviderId === 'string' && auth.oauthProviderId.trim()
        ? auth.oauthProviderId.trim()
        : undefined;
    if (fromAuthField) {
      return fromAuthField;
    }
    const providerId = this.resolveOAuthProviderId(auth?.rawType ?? auth?.type);
    if (providerId) {
      return providerId;
    }
    const fallback = this.resolveOAuthProviderId(auth?.type);
    if (fallback) {
      return fallback;
    }
    throw new Error(
      `OAuth auth.type must be declared as "<provider>-oauth" (received ${typeof auth?.rawType === 'string' ? auth.rawType : auth?.type ?? 'unknown'})`
    );
  }
}
