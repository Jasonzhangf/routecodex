/**
 * Token Overrides Builder
 */

import type { OAuthFlowConfig, OAuthClientConfig, OAuthEndpoints } from '../../core/config/oauth-flows.js';
import { hasNonEmptyString } from './token-helpers.js';
import type { ExtendedOAuthAuth } from './path-resolver.js';
import { LOCAL_HOSTS, HTTP_PROTOCOLS } from '../../../constants/index.js';
import { resolveTokenAliasFromPath } from './path-resolver.js';

export function buildEndpointOverrides(defaults: OAuthFlowConfig, auth: ExtendedOAuthAuth): OAuthEndpoints {
  const overridden: OAuthEndpoints = { ...defaults.endpoints };
  if (hasNonEmptyString(auth.tokenUrl)) {
    overridden.tokenUrl = auth.tokenUrl!;
  }
  if (hasNonEmptyString(auth.deviceCodeUrl)) {
    overridden.deviceCodeUrl = auth.deviceCodeUrl!;
  }
  if (hasNonEmptyString(auth.authorizationUrl)) {
    overridden.authorizationUrl = auth.authorizationUrl;
  }
  if (hasNonEmptyString(auth.userInfoUrl)) {
    overridden.userInfoUrl = auth.userInfoUrl;
  }
  return overridden;
}

export async function buildClientOverrides(defaults: OAuthFlowConfig, auth: ExtendedOAuthAuth, _providerType: string): Promise<OAuthClientConfig> {
  const base = { ...defaults.client };
  if (hasNonEmptyString(auth.clientId)) {
    base.clientId = auth.clientId!;
  }
  if (hasNonEmptyString(auth.clientSecret)) {
    base.clientSecret = auth.clientSecret;
  }
  if (Array.isArray(auth.scopes) && auth.scopes.length > 0) {
    base.scopes = [...auth.scopes];
  }
  if (hasNonEmptyString(auth.redirectUri)) {
    base.redirectUri = auth.redirectUri;
  }
  return base;
}

export function buildHeaderOverrides(defaults: OAuthFlowConfig, _providerType: string): Record<string, string> {
  return { ...(defaults.headers || {}) };
}

export function resolveTokenPortalBaseUrl(): string | null {
  const configured = String(process.env.ROUTECODEX_TOKEN_PORTAL_BASE || '').trim();
  if (configured) {
    return configured;
  }

  const envPort = Number(
    process.env.ROUTECODEX_PORT ||
    process.env.RCC_PORT ||
    process.env.ROUTECODEX_SERVER_PORT ||
    NaN
  );
  if (!Number.isFinite(envPort) || envPort <= 0) {
    return null;
  }
  const host = LOCAL_HOSTS.IPV4;
  return `${HTTP_PROTOCOLS.HTTP}${host}:${envPort}/token-auth/demo`;
}

export function buildTokenPortalConfig(
  providerType: string,
  tokenFilePath: string
): OAuthFlowConfig['tokenPortal'] | undefined {
  const baseUrl = resolveTokenPortalBaseUrl();
  if (!baseUrl) {
    return undefined;
  }
  const alias = resolveTokenAliasFromPath(tokenFilePath) ?? 'default';
  return {
    baseUrl,
    provider: providerType,
    alias,
    tokenFile: tokenFilePath
  };
}

export async function buildOverrides(
  providerType: string,
  defaults: OAuthFlowConfig,
  auth: ExtendedOAuthAuth,
  openBrowser: boolean,
  tokenFilePath: string
) {
  const endpoints = buildEndpointOverrides(defaults, auth);
  const client = await buildClientOverrides(defaults, auth, providerType);
  const headers = buildHeaderOverrides(defaults, providerType);
  const tokenPortal = openBrowser ? buildTokenPortalConfig(providerType, tokenFilePath) : undefined;
  const overrides: Record<string, unknown> = {
    activationType: openBrowser ? 'auto_browser' : 'manual',
    endpoints,
    client,
    tokenFile: tokenFilePath,
    headers
  };
  if (tokenPortal) {
    (overrides as any).tokenPortal = tokenPortal;
  }
  return { overrides, endpoints, client };
}
