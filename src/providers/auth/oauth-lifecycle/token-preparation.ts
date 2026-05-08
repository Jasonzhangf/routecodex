/**
 * Token Preparation helpers
 *
 * Extracted from oauth-lifecycle.ts. Wraps/prepares OAuth tokens for storage.
 */

import type { StoredOAuthToken } from './token-helpers.js';
import type { OAuthEndpoints } from '../../core/config/oauth-flows.js';
import { logOAuthLifecycleNonBlocking } from './oauth-lifecycle-logger.js';
import { logOAuthDebug } from '../oauth-logger.js';
import { isGeminiCliFamily, resolveTokenFilePath } from './path-resolver.js';
import { fetchGeminiCLIUserInfo, mergeGeminiCLITokenData, getDefaultProjectId } from '../gemini-cli-userinfo-helper.js';
import { fetchQwenUserInfo, mergeQwenTokenData, validateQwenAccessToken } from '../qwen-userinfo-helper.js';
import { normalizeGeminiCliAccountToken, sanitizeToken } from './token-io.js';
import { hasNonEmptyString } from './token-helpers.js';
import type { UnknownObject } from '../../../modules/pipeline/types/common-types.js';
import { readRawTokenFile } from './token-io.js';
import { extractAccessToken } from './token-helpers.js';
import {
  coerceExpiryTimestampSeconds,
  resolveProjectId,
  getExpiresAt,
  hasStableQwenApiKey,
  extractApiKey,
  hasApiKeyField,
  hasAccessToken,
} from './token-helpers.js';
import { resolveTokenAliasFromPath } from './path-resolver.js';


export async function wrapGeminiCliTokenForStorage(
  tokenData: UnknownObject,
  tokenFilePath: string
): Promise<UnknownObject> {
  const rawExisting = await readRawTokenFile(tokenFilePath);
  const existing = rawExisting && typeof rawExisting === 'object' ? rawExisting : null;
  const existingToken = existing && typeof (existing as UnknownObject).token === 'object'
    ? ((existing as UnknownObject).token as UnknownObject)
    : null;

  const sanitized = sanitizeToken(tokenData) ?? (tokenData as StoredOAuthToken);
  const accessToken = extractAccessToken(sanitized);
  if (!accessToken) {
    return tokenData;
  }

  const nextToken: UnknownObject = {
    ...(existingToken || {}),
    access_token: accessToken,
    token_type: hasNonEmptyString((sanitized as UnknownObject).token_type)
      ? String((sanitized as UnknownObject).token_type)
      : ((existingToken as UnknownObject | null)?.token_type as string | undefined) ?? 'Bearer'
  };

  const refreshToken = (sanitized as UnknownObject).refresh_token;
  if (hasNonEmptyString(refreshToken)) {
    nextToken.refresh_token = refreshToken;
  } else if (existingToken && hasNonEmptyString(existingToken.refresh_token)) {
    nextToken.refresh_token = existingToken.refresh_token;
  }

  const expiresIn = (sanitized as UnknownObject).expires_in;
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn)) {
    nextToken.expires_in = expiresIn;
  } else if (existingToken && typeof existingToken.expires_in === 'number') {
    nextToken.expires_in = existingToken.expires_in;
  }

  const expiryTimestamp = coerceExpiryTimestampSeconds(sanitized);
  if (typeof expiryTimestamp === 'number') {
    nextToken.expiry_timestamp = expiryTimestamp;
  } else if (existingToken && typeof existingToken.expiry_timestamp === 'number') {
    nextToken.expiry_timestamp = existingToken.expiry_timestamp;
  }

  const email = (sanitized as UnknownObject).email;
  if (hasNonEmptyString(email)) {
    nextToken.email = String(email);
  } else if (existingToken && hasNonEmptyString(existingToken.email)) {
    nextToken.email = String(existingToken.email);
  }

  const projectId = resolveProjectId(sanitized as UnknownObject);
  if (projectId) {
    nextToken.project_id = projectId;
  } else if (existingToken && hasNonEmptyString(existingToken.project_id)) {
    nextToken.project_id = String(existingToken.project_id);
  }

  const sessionId = (sanitized as UnknownObject).session_id ?? (sanitized as UnknownObject).sessionId;
  if (hasNonEmptyString(sessionId)) {
    nextToken.session_id = String(sessionId);
  } else if (existingToken && hasNonEmptyString(existingToken.session_id)) {
    nextToken.session_id = String(existingToken.session_id);
  }

  const result: UnknownObject = {
    ...(existing || {}),
    token: nextToken
  };

  // Keep top-level fields in sync for backward compatibility.
  result.access_token = nextToken.access_token;
  if (hasNonEmptyString(nextToken.refresh_token)) {
    result.refresh_token = nextToken.refresh_token;
  }
  if (typeof nextToken.expires_in === 'number') {
    result.expires_in = nextToken.expires_in;
  }
  if (hasNonEmptyString(nextToken.token_type)) {
    result.token_type = nextToken.token_type;
  }
  if (typeof nextToken.expiry_timestamp === 'number') {
    const expiresAtMs = nextToken.expiry_timestamp * 1000;
    result.expires_at = expiresAtMs;
    result.expiry_date = expiresAtMs;
    result.expired = new Date(expiresAtMs).toISOString();
  }

  const scope = (sanitized as UnknownObject).scope;
  if (hasNonEmptyString(scope)) {
    result.scope = String(scope);
  }
  const idToken = (sanitized as UnknownObject).id_token;
  if (hasNonEmptyString(idToken)) {
    result.id_token = String(idToken);
  }

  if (hasNonEmptyString(email)) {
    result.email = String(email);
  }
  if (projectId) {
    result.project_id = projectId;
  }
  if (Array.isArray((sanitized as UnknownObject).projects)) {
    result.projects = (sanitized as UnknownObject).projects as unknown[];
  }

  return result;
}

export async function prepareTokenForStorage(
  providerType: string,
  tokenFilePath: string,
  tokenData: UnknownObject
): Promise<UnknownObject> {
  if (isGeminiCliFamily(providerType)) {
    return await wrapGeminiCliTokenForStorage(tokenData, tokenFilePath);
  }
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
  } catch (error) {
    logOAuthLifecycleNonBlocking('logTokenSnapshot', error, { providerType });
  }
}

