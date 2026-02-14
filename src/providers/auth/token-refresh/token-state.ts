/**
 * Token State Evaluator
 *
 * Evaluates token validity and expiry state for different providers.
 */

import type { StoredOAuthToken } from '../oauth-token-utils.js';
import { hasApiKeyField, hasAccessToken, hasStableQwenApiKey, getExpiresAt } from '../oauth-token-utils.js';

const TOKEN_REFRESH_SKEW_MS = 60_000;

export interface TokenState {
  hasApiKey: boolean;
  hasAccess: boolean;
  expiresAt: number | null;
  isExpiredOrNear: boolean;
  validAccess: boolean;
}

/**
 * Evaluate token state for provider-specific validation
 */
export function evaluateTokenState(token: StoredOAuthToken | null, providerType: string): TokenState {
  const hasApiKey = hasApiKeyField(token);
  const hasAccess = hasAccessToken(token);
  const expiresAt = getExpiresAt(token);
  const isExpiredOrNear = expiresAt !== null && Date.now() >= (expiresAt - TOKEN_REFRESH_SKEW_MS);
  let validAccess: boolean;

  const pt = providerType.toLowerCase();
  if (pt === 'iflow') {
    validAccess = hasApiKey || (!isExpiredOrNear && hasAccess);
  } else if (pt === 'qwen') {
    // Qwen: when stable api_key is obtained, skip refresh/reauth; otherwise rely on access_token expiry
    validAccess = hasStableQwenApiKey(token) || (!isExpiredOrNear && (hasAccess || hasApiKey));
  } else {
    validAccess = (hasApiKey || hasAccess) && !isExpiredOrNear;
  }

  return { hasApiKey, hasAccess, expiresAt, isExpiredOrNear, validAccess };
}