/**
 * Token Overrides Builder
 *
 * Extracted from oauth-lifecycle.ts. Builds endpoint/client/header overrides for OAuth token refresh.
 */

import type { OAuthAuth } from '../../core/api/provider-config.js';
import type { OAuthFlowConfig, OAuthClientConfig, OAuthEndpoints } from '../../core/config/oauth-flows.js';
import type { StoredOAuthToken } from './token-helpers.js';
import { logOAuthLifecycleNonBlocking } from './oauth-lifecycle-logger.js';
import { logOAuthDebug } from '../oauth-logger.js';
import { isGeminiCliFamily } from './path-resolver.js';
import { fetchGeminiCLIProjects, getDefaultProjectId } from '../gemini-cli-userinfo-helper.js';
import { normalizeGeminiCliAccountToken } from './token-io.js';
import type { ExtendedOAuthAuth } from './path-resolver.js';
import { hasNonEmptyString } from './token-helpers.js';
import { parseTokenSequenceFromPath } from '../token-scanner/index.js';
import { LOCAL_HOSTS, HTTP_PROTOCOLS } from '../../../constants/index.js';
import { resolveTokenAliasFromPath } from './path-resolver.js';


// We'll also need some functions currently defined in the block themselves
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

export async function buildClientOverrides(defaults: OAuthFlowConfig, auth: ExtendedOAuthAuth, providerType: string): Promise<OAuthClientConfig> {
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

export async function ensureGeminiCLIServicesEnabled(accessToken: string, projectId: string): Promise<void> {
  if (!hasNonEmptyString(accessToken) || !hasNonEmptyString(projectId)) {
    return;
  }

  const baseUrl = 'https://serviceusage.googleapis.com';
  const requiredServices = ['cloudaicompanion.googleapis.com'];

  for (const service of requiredServices) {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    };

    // 1) 检查当前启用状态
    try {
      const checkUrl = `${baseUrl}/v1/projects/${projectId}/services/${service}`;
      const checkResp = await fetch(checkUrl, { method: 'GET', headers });
      if (checkResp.ok) {
        const text = await checkResp.text();
        try {
          const data = JSON.parse(text) as { state?: string };
          if (data.state === 'ENABLED') {
            continue;
          }
        } catch (error) {
          logOAuthLifecycleNonBlocking(
            'ensureGeminiCLIServicesEnabled.parseCheckResponse',
            error,
            { service, projectId }
          );
        }
      } else {
        // drain body
        await checkResp.text().catch((error) => {
          logOAuthDebug(
            `[OAuth] Gemini CLI: failed to drain service check body for ${service} on ${projectId} - ${error instanceof Error ? error.message : String(error)}`
          );
        });
      }
    } catch (error) {
      logOAuthLifecycleNonBlocking(
        'ensureGeminiCLIServicesEnabled.checkService',
        error,
        { service, projectId }
      );
      // best-effort; continue to try enable
    }

    // 2) 尝试启用服务
    const enableUrl = `${baseUrl}/v1/projects/${projectId}/services/${service}:enable`;
    let enableResp: Response | null = null;
    let bodyText = '';
    try {
      enableResp = await fetch(enableUrl, {
        method: 'POST',
        headers,
        body: '{}'
      });
      bodyText = await enableResp.text().catch((error) => {
        logOAuthDebug(
          `[OAuth] Gemini CLI: failed to read enable response body for ${service} on ${projectId} - ${error instanceof Error ? error.message : String(error)}`
        );
        return '';
      });
    } catch (error) {
      throw new Error(
        `Gemini CLI: failed to enable ${service} for project ${projectId} - ${error instanceof Error ? error.message : String(error)}`
      );
    }

    let errMessage = bodyText;
    try {
      const parsed = JSON.parse(bodyText) as { error?: { message?: string } };
      if (parsed?.error?.message) {
        errMessage = parsed.error.message;
      }
    } catch (error) {
      logOAuthLifecycleNonBlocking(
        'ensureGeminiCLIServicesEnabled.parseEnableResponse',
        error,
        { service, projectId }
      );
    }

    if (enableResp && (enableResp.ok || enableResp.status === 201)) {
      logOAuthDebug(
        `[OAuth] Gemini CLI: service ${service} enabled for project ${projectId} (status=${enableResp.status})`
      );
      continue;
    }

    if (enableResp && enableResp.status === 400 && errMessage.toLowerCase().includes('already enabled')) {
      logOAuthDebug(
        `[OAuth] Gemini CLI: service ${service} already enabled for project ${projectId}`
      );
      continue;
    }

    throw new Error(
      `Gemini CLI: project activation required for ${service} on ${projectId}: ${errMessage || 'unknown error'}`
    );
  }
}

export function buildHeaderOverrides(defaults: OAuthFlowConfig, providerType: string): Record<string, string> {
  const baseHeaders = { ...(defaults.headers || {}) };
  return baseHeaders;
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
    // No reliable server port detected; disable portal and fall back to direct OAuth URL
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
  if (providerType === 'antigravity' && !process.env.ROUTECODEX_OAUTH_BROWSER) {
    process.env.ROUTECODEX_OAUTH_BROWSER = 'camoufox';
  }
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

