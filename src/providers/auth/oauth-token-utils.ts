/**
 * OAuth Token Types and Utilities
 *
 * Shared type definitions and token utilities for OAuth modules.
 */

import type { UnknownObject } from '../../modules/pipeline/types/common-types.js';

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

/**
 * Check if value is a non-empty string
 */
export function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Extract access token from stored token
 */
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

/**
 * Extract API key from stored token
 */
export function extractApiKey(token: StoredOAuthToken | null): string | undefined {
  if (!token) {
    return undefined;
  }
  const candidate = token.apiKey ?? token.api_key;
  return hasNonEmptyString(candidate) ? String(candidate) : undefined;
}

/**
 * Check if token has API key field
 */
export function hasApiKeyField(token: StoredOAuthToken | null): boolean {
  if (!token) {
    return false;
  }
  return hasNonEmptyString(token.apiKey ?? token.api_key);
}

/**
 * Check if token has access token
 */
export function hasAccessToken(token: StoredOAuthToken | null): boolean {
  return hasNonEmptyString(token?.access_token) || hasNonEmptyString(token?.AccessToken);
}

/**
 * Check if Qwen has stable API key (not fallback from access_token)
 */
export function hasStableQwenApiKey(token: StoredOAuthToken | null): boolean {
  const apiKey = extractApiKey(token);
  if (!apiKey) {
    return false;
  }
  const access = extractAccessToken(token);
  return !access || apiKey !== access;
}

/**
 * Check if token has no-refresh flag
 */
export function hasNoRefreshFlag(token: StoredOAuthToken | null): boolean {
  if (!token) {
    return false;
  }
  const direct = (token as any).norefresh ?? (token as any).noRefresh;
  if (typeof direct === 'boolean') {
    return direct;
  }
  if (typeof direct === 'string') {
    const normalized = direct.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }
  return false;
}

/**
 * Get token expiry timestamp
 */
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

/**
 * Resolve project ID from token
 */
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

/**
 * Normalize Gemini CLI account token format
 */
export function normalizeGeminiCliAccountToken(token: UnknownObject): StoredOAuthToken | null {
  const raw = token as { token?: UnknownObject };
  const tokenNode = raw.token;
  if (!tokenNode || typeof tokenNode !== 'object') {
    return null;
  }
  const tokenObj = tokenNode as UnknownObject;
  const access = tokenObj.access_token;
  if (!hasNonEmptyString(access)) {
    return null;
  }

  const out = { ...(tokenObj as StoredOAuthToken) };
  const root = token as UnknownObject;

  if (typeof root.disabled === 'boolean') out.disabled = root.disabled;
  if (typeof root.disabled_reason === 'string') out.disabled_reason = root.disabled_reason;
  if (typeof root.disabled_at === 'number' || typeof root.disabled_at === 'string') out.disabled_at = root.disabled_at;

  if (typeof root.proxy_disabled === 'boolean') out.proxy_disabled = root.proxy_disabled;
  if (typeof root.proxyDisabled === 'boolean') out.proxyDisabled = root.proxyDisabled;
  if (typeof root.proxy_disabled_reason === 'string') out.proxy_disabled_reason = root.proxy_disabled_reason;
  if (typeof root.proxy_disabled_at === 'number' || typeof root.proxy_disabled_at === 'string') {
    out.proxy_disabled_at = root.proxy_disabled_at;
  }

  if (Array.isArray(root.protected_models)) out.protected_models = root.protected_models;
  if (Array.isArray(root.protectedModels)) out.protectedModels = root.protectedModels;

  if (!hasNonEmptyString(out.project_id) && hasNonEmptyString(root.project_id)) {
    out.project_id = String(root.project_id);
  }
  if (!hasNonEmptyString(out.projectId) && hasNonEmptyString(root.projectId)) {
    out.projectId = String(root.projectId);
  }
  if (!Array.isArray(out.projects) && Array.isArray(root.projects)) {
    out.projects = root.projects;
  }
  if (!hasNonEmptyString(out.email) && hasNonEmptyString(root.email)) {
    out.email = String(root.email);
  }

  const expiryTimestamp = (tokenObj as { expiry_timestamp?: unknown }).expiry_timestamp;
  if (!hasNonEmptyString(out.expires_at) && typeof expiryTimestamp === 'number') {
    out.expires_at = expiryTimestamp > 10_000_000_000 ? expiryTimestamp : expiryTimestamp * 1000;
  }

  return out;
}

/**
 * Sanitize token to standard format
 */
export function sanitizeToken(token: UnknownObject | null): StoredOAuthToken | null {
  if (!token || typeof token !== 'object') {
    return null;
  }
  const normalized = normalizeGeminiCliAccountToken(token);
  if (normalized) {
    return normalized;
  }
  const copy = { ...token } as StoredOAuthToken;
  if (!hasNonEmptyString(copy.apiKey) && hasNonEmptyString(copy.api_key)) {
    copy.apiKey = copy.api_key;
  }
  return copy;
}