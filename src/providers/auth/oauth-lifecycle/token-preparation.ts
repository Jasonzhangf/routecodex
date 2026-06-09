/**
 * Token Preparation helpers
 */

import type { StoredOAuthToken } from './token-helpers.js';
import type { OAuthEndpoints } from '../../core/config/oauth-flows.js';
import { logOAuthLifecycleNonBlocking } from './oauth-lifecycle-logger.js';
import { logOAuthDebug } from '../oauth-logger.js';
import type { UnknownObject } from '../../../types/common-types.js';
import {
  hasApiKeyField,
  hasAccessToken,
} from './token-helpers.js';

export async function prepareTokenForStorage(
  providerType: string,
  tokenFilePath: string,
  tokenData: UnknownObject
): Promise<UnknownObject> {
  void providerType;
  void tokenFilePath;
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
