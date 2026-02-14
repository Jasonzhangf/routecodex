import type { OAuthAuth } from '../../api/provider-config.js';

type OAuthAuthExtended = OAuthAuth & { rawType?: string; oauthProviderId?: string; tokenFile?: string };

export class AuthModeUtils {
  static normalizeAuthMode(type: unknown): 'apikey' | 'oauth' {
    return typeof type === 'string' && type.toLowerCase().includes('oauth') ? 'oauth' : 'apikey';
  }

  static resolveOAuthProviderId(type: unknown): string | undefined {
    if (typeof type !== 'string') {
      return undefined;
    }
    const match = type.toLowerCase().match(/^([a-z0-9._-]+)-oauth$/);
    return match ? match[1] : undefined;
  }

  static ensureOAuthProviderId(auth: OAuthAuthExtended, extensions?: Record<string, unknown>): string {
    const fromExtension =
      typeof extensions?.oauthProviderId === 'string' && extensions.oauthProviderId.trim()
        ? extensions.oauthProviderId.trim()
        : undefined;
    if (fromExtension) {
      return fromExtension;
    }
    const fromAuthField =
      typeof auth?.oauthProviderId === 'string' && auth.oauthProviderId.trim()
        ? auth.oauthProviderId.trim()
        : undefined;
    if (fromAuthField) {
      return fromAuthField;
    }
    const providerId = AuthModeUtils.resolveOAuthProviderId(auth?.rawType ?? auth?.type);
    if (providerId) {
      return providerId;
    }
    const fallback = AuthModeUtils.resolveOAuthProviderId(auth?.type);
    if (fallback) {
      return fallback;
    }
    throw new Error(
      `OAuth auth.type must be declared as "<provider>-oauth" (received ${typeof auth?.rawType === 'string' ? auth.rawType : auth?.type ?? 'unknown'})`
    );
  }

  static ensureOAuthProviderIdLegacy(type: unknown): string {
    const providerId = AuthModeUtils.resolveOAuthProviderId(type);
    if (!providerId) {
      throw new Error(
        `OAuth auth.type must be declared as "<provider>-oauth" (received ${typeof type === 'string' ? type : 'unknown'})`
      );
    }
    return providerId;
  }
}
