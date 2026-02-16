/**
 * Token Helpers
 *
 * Token extraction and validation utilities.
 */

import type { UnknownObject } from '../../../modules/pipeline/types/common-types.js';

export type StoredOAuthToken = UnknownObject & {
  access_token?: string;
  AccessToken?: string;
  refresh_token?: string;
  api_key?: string;
  apiKey?: string;
  expires_at?: number | string;
  expired?: number | string;
  expiry_date?: number | string;
  norefresh?: boolean;
};

export function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function extractAccessToken(token: StoredOAuthToken | null): string | undefined {
  if (!token) {
    return undefined;
  }
  if (hasNonEmptyString(token.access_token)) {
    return token.access_token;
  }
  if (hasNonEmptyString(token.AccessToken)) {
    return token.AccessToken;
  }
  return undefined;
}

export function extractApiKey(token: StoredOAuthToken | null): string | undefined {
  if (!token) {
    return undefined;
  }
  const candidate = token.apiKey ?? token.api_key;
  return hasNonEmptyString(candidate) ? String(candidate) : undefined;
}

export function hasApiKeyField(token: StoredOAuthToken | null): boolean {
  if (!token) {
    return false;
  }
  return hasNonEmptyString(token.apiKey ?? token.api_key);
}

export function hasStableQwenApiKey(token: StoredOAuthToken | null): boolean {
  const apiKey = extractApiKey(token);
  if (!apiKey) {
    return false;
  }
  const access = extractAccessToken(token);
  return !access || apiKey !== access;
}

export function hasAccessToken(token: StoredOAuthToken | null): boolean {
  return hasNonEmptyString(token?.access_token) || hasNonEmptyString(token?.AccessToken);
}

export function getExpiresAt(token: StoredOAuthToken | null): number | null {
  if (!token) {
    return null;
  }
  const raw = token.expires_at ?? token.expired ?? token.expiry_date;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
    const ts = Date.parse(raw);
    return Number.isFinite(ts) ? ts : null;
  }
  return null;
}

export function resolveProjectId(token: UnknownObject | null): string | undefined {
  if (!token || typeof token !== 'object') {
    return undefined;
  }
  const record = token as Record<string, unknown>;
  if (hasNonEmptyString(record.project_id)) {
    return record.project_id;
  }
  if (hasNonEmptyString(record.projectId)) {
    return record.projectId;
  }
  return undefined;
}

export function coerceExpiryTimestampSeconds(token: StoredOAuthToken | null): number | undefined {
  if (!token) {
    return undefined;
  }
  const rawExpiry = (token as UnknownObject).expiry_timestamp;
  if (typeof rawExpiry === 'number' && Number.isFinite(rawExpiry)) {
    return rawExpiry > 10_000_000_000 ? Math.floor(rawExpiry / 1000) : rawExpiry;
  }
  const expiresAt = getExpiresAt(token);
  if (!expiresAt) {
    return undefined;
  }
  return expiresAt > 10_000_000_000 ? Math.floor(expiresAt / 1000) : Math.floor(expiresAt);
}

export function hasNoRefreshFlag(token: StoredOAuthToken | null): boolean {
  if (!token) {
    return false;
  }
  const direct = (token as UnknownObject).norefresh ?? (token as UnknownObject).noRefresh;
  if (typeof direct === 'boolean') {
    return direct;
  }
  if (typeof direct === 'string') {
    const normalized = direct.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }
  return false;
}

export function evaluateTokenState(token: StoredOAuthToken | null, providerType: string) {
  const hasApiKey = hasApiKeyField(token);
  const hasStableQwenKey = providerType === 'qwen' ? hasStableQwenApiKey(token) : false;
  const hasAccess = hasAccessToken(token);
  const expiresAt = getExpiresAt(token);
  const isExpired = expiresAt !== null && Date.now() >= expiresAt - 60_000;
  const isNearExpiry = expiresAt !== null && Date.now() >= expiresAt - 300_000;

  // qwen: only stable api_key can bypass expiry checks.
  // iflow and other OAuth providers must rely on non-expired access_token/refresh flow
  // so expired api_key never short-circuits token refresh/reauth.
  const apiKeyBypassesExpiry = providerType === 'qwen' && hasStableQwenKey;
  const validAccess = apiKeyBypassesExpiry || (hasAccess && !isExpired);
  const isExpiredOrNear = isExpired || isNearExpiry;

  return {
    hasApiKey,
    hasAccess,
    expiresAt,
    isExpired,
    isNearExpiry,
    validAccess,
    isExpiredOrNear
  };
}
