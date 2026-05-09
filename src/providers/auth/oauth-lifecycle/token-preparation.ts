/**
 * Token Preparation helpers
 */

import type { StoredOAuthToken } from './token-helpers.js';
import type { OAuthEndpoints } from '../../core/config/oauth-flows.js';
import { logOAuthLifecycleNonBlocking } from './oauth-lifecycle-logger.js';
import { logOAuthDebug } from '../oauth-logger.js';
import { fetchQwenUserInfo, mergeQwenTokenData, validateQwenAccessToken } from '../qwen-userinfo-helper.js';
import { sanitizeToken } from './token-io.js';
import type { UnknownObject } from '../../../modules/pipeline/types/common-types.js';
import { readRawTokenFile } from './token-io.js';
import {
  getExpiresAt,
  hasStableQwenApiKey,
  extractApiKey,
  hasApiKeyField,
  hasAccessToken,
} from './token-helpers.js';
import { resolveTokenAliasFromPath } from './path-resolver.js';

export async function prepareTokenForStorage(
  providerType: string,
  tokenFilePath: string,
  tokenData: UnknownObject
): Promise<UnknownObject> {
  if (providerType === 'qwen') {
    const rawExisting = await readRawTokenFile(tokenFilePath);
    const existing = rawExisting && typeof rawExisting === 'object' ? (rawExisting as Record<string, unknown>) : null;
    const resolvedAlias = resolveTokenAliasFromPath(tokenFilePath);
    const token = sanitizeToken(tokenData) ?? (tokenData as StoredOAuthToken);
    const expiresAt = getExpiresAt(token);
    const expiresInRaw = token.expires_in;
    const expiresIn = typeof expiresInRaw === 'number' && Number.isFinite(expiresInRaw)
      ? expiresInRaw
      : (expiresAt && expiresAt > 10_000_000_000
          ? Math.max(1, Math.floor((expiresAt - Date.now()) / 1000))
          : 21600);
    const {
      resource_url: _dropLegacyResourceUrl,
      resourceUrl: _dropLegacyResourceUrlCamel,
      norefresh: _dropLegacyNoRefresh,
      noRefresh: _dropLegacyNoRefreshCamel,
      api_key: _dropLegacyApiKey,
      apiKey: _dropLegacyApiKeyCamel,
      ...existingWithoutLegacyQwenFields
    } = existing || {};
    const {
      resource_url: _dropIncomingResourceUrl,
      resourceUrl: _dropIncomingResourceUrlCamel,
      norefresh: _dropIncomingNoRefresh,
      noRefresh: _dropIncomingNoRefreshCamel,
      api_key: _dropIncomingApiKey,
      apiKey: _dropIncomingApiKeyCamel,
      ...tokenDataWithoutLegacyQwenFields
    } = tokenData as Record<string, unknown>;
    const rawResourceUrl =
      typeof (tokenData as Record<string, unknown>).resource_url === 'string' &&
      String((tokenData as Record<string, unknown>).resource_url).trim()
        ? String((tokenData as Record<string, unknown>).resource_url).trim()
        : typeof (tokenData as Record<string, unknown>).resourceUrl === 'string' &&
            String((tokenData as Record<string, unknown>).resourceUrl).trim()
          ? String((tokenData as Record<string, unknown>).resourceUrl).trim()
          : undefined;
    const resourceUrl = (() => {
      if (!rawResourceUrl) {
        return undefined;
      }
      let normalized = rawResourceUrl;
      if (!/^https?:\/\//i.test(normalized)) {
        normalized = `https://${normalized}`;
      }
      normalized = normalized.replace(/\/+$/, '');
      try {
        const parsed = new URL(normalized);
        const host = parsed.hostname.trim().toLowerCase();
        const pathname = parsed.pathname.replace(/\/+$/, '');
        const isOfficialQwenCodeHost = host === 'portal.qwen.ai' || host === 'chat.qwen.ai';
        const isDashscopeCompatibleHost =
          host === 'dashscope.aliyuncs.com' && /^\/compatible-mode(?:\/v1)?$/i.test(pathname);
        if (isOfficialQwenCodeHost && (!pathname || pathname === '/v1')) {
          return parsed.origin;
        }
        if (!isDashscopeCompatibleHost) {
          return undefined;
        }
        return `${parsed.origin}${pathname}`;
      } catch {
        return undefined;
      }
    })();
    const stableApiKey = hasStableQwenApiKey(token) ? extractApiKey(token) : undefined;
    return {
      ...existingWithoutLegacyQwenFields,
      ...tokenDataWithoutLegacyQwenFields,
      status: 'success',
      type: 'qwen',
      ...(resolvedAlias ? { alias: resolvedAlias } : {}),
      expires_in: expiresIn,
      access_token: String(token.access_token ?? ''),
      ...(resourceUrl ? { resource_url: resourceUrl } : {}),
      ...(stableApiKey ? { apiKey: stableApiKey, api_key: stableApiKey, norefresh: true, noRefresh: true } : {})
    } as UnknownObject;
  }
  return tokenData;
}

export function logTokenSnapshot(providerType: string, token: StoredOAuthToken | null, endpoints: OAuthEndpoints): void {
  try {
    const hasApiKey = hasApiKeyField(token);
    const hasAccess = hasAccessToken(token);
    const expRaw = token?.expires_at ?? token?.expired ?? token?.expiry_date ?? null;
    logOAuthDebug(
      `[OAuth] token.read: provider=${providerType} exists=${Boolean(token)} hasApiKey=${hasApiKey} hasAccess=${hasAccess} expRaw=${String(expRaw)}`
    );
    logOAuthDebug(
      `[OAuth] token.endpoints: provider=${providerType} tokenUrl=${String(endpoints.tokenUrl || '')} userInfoUrl=${String(endpoints.userInfoUrl || '')}`
    );
  } catch (error) {
    logOAuthLifecycleNonBlocking('logTokenSnapshot', error, { providerType });
  }
}

export { fetchQwenUserInfo, mergeQwenTokenData, validateQwenAccessToken };
