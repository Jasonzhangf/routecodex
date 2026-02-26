import type { OAuthAuth } from '../core/api/provider-config.js';
import {
  createProviderOAuthStrategy,
  getProviderOAuthConfig
} from '../core/config/provider-oauth-configs.js';
import { OAuthFlowType, type OAuthFlowConfig, type OAuthClientConfig, type OAuthEndpoints } from '../core/config/oauth-flows.js';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'node:child_process';
import type { UnknownObject } from '../../modules/pipeline/types/common-types.js';
import { fetchIFlowUserInfo, mergeIFlowTokenData } from './iflow-userinfo-helper.js';
import { fetchQwenUserInfo, mergeQwenTokenData } from './qwen-userinfo-helper.js';
import {
  fetchGeminiCLIUserInfo,
  fetchGeminiCLIProjects,
  mergeGeminiCLITokenData,
  getDefaultProjectId
} from './gemini-cli-userinfo-helper.js';
import { parseTokenSequenceFromPath } from './token-scanner/index.js';
import { logOAuthDebug } from './oauth-logger.js';
import { fetchAntigravityProjectId } from './antigravity-userinfo-helper.js';
import { HTTP_PROTOCOLS, LOCAL_HOSTS } from '../../constants/index.js';
import { withOAuthRepairEnv } from './oauth-repair-env.js';
import {
  markInteractiveOAuthRepairAttempt,
  markInteractiveOAuthRepairSuccess,
  shouldSkipInteractiveOAuthRepair,
  type OAuthRepairCooldownReason
} from './oauth-repair-cooldown.js';
import { openAuthInCamoufox } from '../core/config/camoufox-launcher.js';
import {
  isGeminiCliFamily,
  type ExtendedOAuthAuth,
  resolveTokenFilePath,
  resolveCamoufoxAliasForAuth,
  resolveIflowCredentialCandidates
} from './oauth-lifecycle/path-resolver.js';
import {
  keyFor,
  shouldThrottle,
  updateThrottle,
  lastRunAt,
  inFlight,
  interactiveTail
} from './oauth-lifecycle/throttle.js';
import {
  extractStatusCode,
  isGoogleAccountVerificationRequiredMessage,
  extractGoogleAccountVerificationUrl
} from './oauth-lifecycle/error-detection.js';
import {
  type StoredOAuthToken,
  hasNonEmptyString,
  extractAccessToken,
  extractApiKey,
  hasApiKeyField,
  hasStableQwenApiKey,
  hasAccessToken,
  getExpiresAt,
  resolveProjectId,
  coerceExpiryTimestampSeconds,
  hasNoRefreshFlag,
  evaluateTokenState
} from './oauth-lifecycle/token-helpers.js';
import {
  normalizeGeminiCliAccountToken,
  sanitizeToken,
  readTokenFromFile,
  backupTokenFile,
  restoreTokenFileFromBackup,
  discardBackupFile,
  clearTokenFile,
  readRawTokenFile
} from './oauth-lifecycle/token-io.js';

type InteractiveOAuthLockRecord = {
  pid: number;
  providerType: string;
  tokenFile: string;
  startedAt: number;
  callbackPort?: number;
};

type IflowAutoFailureRecord = {
  count: number;
  manualRequired: boolean;
  updatedAt: number;
  lastError?: string;
};

const OAUTH_INTERACTIVE_LOCK_FILE = path.join(os.homedir(), '.routecodex', 'auth', '.oauth-interactive.lock.json');
const IFLOW_AUTO_FAILURE_FILE = path.join(os.homedir(), '.routecodex', 'auth', '.iflow-auto-failures.json');
const OAUTH_THROTTLE_WINDOW_MS = 60_000;
const IFLOW_REFRESH_FAILURE_BACKOFF_MS = 5 * 60_000;

type EnsureOpts = {
  forceReacquireIfRefreshFails?: boolean;
  openBrowser?: boolean;
  forceReauthorize?: boolean;
};

type OAuthStrategy = {
  refreshToken?(refreshToken: string): Promise<UnknownObject>;
  authenticate?(options?: { openBrowser?: boolean; forceReauthorize?: boolean }): Promise<UnknownObject | void>;
  saveToken?(token: UnknownObject | null): Promise<void>;
};

const TOKEN_REFRESH_SKEW_MS = 60_000;

type IflowTokenCandidate = {
  token: StoredOAuthToken;
  sourcePath: string;
  expiresAt: number | null;
};

async function selectBestIflowTokenCandidate(targetTokenFilePath: string): Promise<IflowTokenCandidate | null> {
  const targetResolved = path.resolve(targetTokenFilePath);
  const candidates = resolveIflowCredentialCandidates();
  let best: IflowTokenCandidate | null = null;

  for (const candidatePath of candidates) {
    if (!candidatePath) {
      continue;
    }
    const resolved = path.resolve(candidatePath);
    if (resolved === targetResolved) {
      continue;
    }
    const token = await readTokenFromFile(candidatePath);
    if (!token) {
      continue;
    }
    const state = evaluateTokenState(token, 'iflow');
    if (!state.validAccess) {
      continue;
    }
    const expiresAt = state.expiresAt ?? null;
    if (!best) {
      best = { token, sourcePath: candidatePath, expiresAt };
      continue;
    }
    const bestExpiry = best.expiresAt ?? -1;
    const currentExpiry = expiresAt ?? -1;
    if (currentExpiry > bestExpiry) {
      best = { token, sourcePath: candidatePath, expiresAt };
    }
  }

  return best;
}

async function maybeAdoptIflowExternalToken(
  strategy: OAuthStrategy,
  tokenFilePath: string,
  existingToken: StoredOAuthToken | null
): Promise<StoredOAuthToken | null> {
  const currentState = evaluateTokenState(existingToken, 'iflow');
  if (currentState.validAccess) {
    return existingToken;
  }
  const bestCandidate = await selectBestIflowTokenCandidate(tokenFilePath);
  if (!bestCandidate) {
    return existingToken;
  }

  // Keep per-alias token files in RouteCodex, but adopt fresh credentials from iFlow-native stores when available.
  const prepared = await prepareTokenForStorage('iflow', tokenFilePath, bestCandidate.token as UnknownObject);
  if (typeof strategy.saveToken === 'function') {
    await strategy.saveToken(prepared);
  } else {
    await fs.mkdir(path.dirname(tokenFilePath), { recursive: true });
    await fs.writeFile(tokenFilePath, `${JSON.stringify(prepared, null, 2)}\n`, 'utf8');
  }
  const normalized = sanitizeToken(prepared as UnknownObject) ?? bestCandidate.token;
  logOAuthDebug(
    `[OAuth] iflow token adopted from ${bestCandidate.sourcePath} -> ${tokenFilePath}`
  );
  return normalized;
}

async function openGoogleAccountVerificationInCamoufox(args: {
  providerType: string;
  auth: ExtendedOAuthAuth;
  url: string;
}): Promise<void> {
  const providerType = args.providerType;
  const url = args.url;
  if (!url) {
    return;
  }
  const alias = resolveCamoufoxAliasForAuth(providerType, args.auth);

  const prevBrowser = process.env.ROUTECODEX_OAUTH_BROWSER;
  const prevAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
  const prevDevMode = process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
  const prevOpenOnly = process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY;

  process.env.ROUTECODEX_OAUTH_BROWSER = 'camoufox';
  delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
  process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = '1';
  process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY = '1';
  try {
    const ok = await openAuthInCamoufox({ url, provider: providerType, alias });
    if (ok) {
      console.warn(`[OAuth] Google account verification opened in Camoufox (provider=${providerType} alias=${alias}).`);
    }
  } catch {
    // best-effort; never block requests
  } finally {
    if (prevBrowser === undefined) {
      delete process.env.ROUTECODEX_OAUTH_BROWSER;
    } else {
      process.env.ROUTECODEX_OAUTH_BROWSER = prevBrowser;
    }
    if (prevAutoMode === undefined) {
      delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    } else {
      process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = prevAutoMode;
    }
    if (prevDevMode === undefined) {
      delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
    } else {
      process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = prevDevMode;
    }
    if (prevOpenOnly === undefined) {
      delete process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY;
    } else {
      process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY = prevOpenOnly;
    }
  }
}

function isIflowRefreshEndpointRejectionMessage(message: string): boolean {
  const normalized = (message || '').toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes('oauth token endpoint rejected request') ||
    (normalized.includes('token refresh failed') && normalized.includes('iflow.cn/oauth/token'))
  );
}

function applyRefreshFailureBackoff(cacheKey: string, providerType: string, message: string): void {
  if (providerType !== 'iflow' || !isIflowRefreshEndpointRejectionMessage(message)) {
    return;
  }
  // For iFlow refresh endpoint 500/generic failures, avoid hammering token endpoint
  // from preflight/retry loops. Keep a longer cooldown before next refresh attempt.
  lastRunAt.set(cacheKey, Date.now() + IFLOW_REFRESH_FAILURE_BACKOFF_MS - OAUTH_THROTTLE_WINDOW_MS);
}

async function runInteractiveRepairWithAutoFallback(args: {
  providerType: string;
  auth: OAuthAuth;
  ensureValid: typeof ensureValidOAuthToken;
  opts: EnsureOpts;
}): Promise<void> {
  const { providerType, auth, ensureValid, opts } = args;
  const autoModeAtStart = String(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE || '').trim();
  try {
    await ensureValid(providerType, auth, opts);
    return;
  } catch (error) {
    if (!autoModeAtStart) {
      throw error;
    }
    const msg = error instanceof Error ? error.message : String(error || '');
    console.warn(
      `[OAuth] Camoufox auto OAuth failed (${providerType}, autoMode=${autoModeAtStart}): ${msg}. Falling back to manual mode.`
    );
  }

  const prevAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
  const prevAutoConfirm = process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
  const prevOpenOnly = process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY;
  try {
    delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    delete process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
    process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY = '1';
    await ensureValid(providerType, auth, opts);
  } finally {
    if (prevAutoMode === undefined) {
      delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    } else {
      process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = prevAutoMode;
    }
    if (prevAutoConfirm === undefined) {
      delete process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
    } else {
      process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM = prevAutoConfirm;
    }
    if (prevOpenOnly === undefined) {
      delete process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY;
    } else {
      process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY = prevOpenOnly;
    }
  }
}

function isOAuthConfig(auth: OAuthAuth): auth is ExtendedOAuthAuth {
  return Boolean(auth && typeof auth.type === 'string' && auth.type.toLowerCase().includes('oauth'));
}

/**
 * Qwen: api_key 可能被降级为 access_token（userInfo 404 时的兼容写法），这种情况不应被视为"稳定 API Key"。
 * 只有当 api_key 存在且与 access_token 不同（或缺失 access_token）时，才认为可以长期复用并跳过刷新。
 */
async function wrapGeminiCliTokenForStorage(
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

async function prepareTokenForStorage(
  providerType: string,
  tokenFilePath: string,
  tokenData: UnknownObject
): Promise<UnknownObject> {
  if (isGeminiCliFamily(providerType)) {
    return await wrapGeminiCliTokenForStorage(tokenData, tokenFilePath);
  }
  if (providerType === 'iflow') {
    const token = sanitizeToken(tokenData) ?? (tokenData as StoredOAuthToken);
    const expiresAt = getExpiresAt(token);
    if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) {
      const expiresAtMs = expiresAt > 10_000_000_000 ? Math.floor(expiresAt) : Math.floor(expiresAt * 1000);
      return {
        ...(tokenData as Record<string, unknown>),
        expires_at: expiresAtMs,
        expired: new Date(expiresAtMs).toISOString()
      } as UnknownObject;
    }
  }
  return tokenData;
}

function logTokenSnapshot(providerType: string, token: StoredOAuthToken | null, endpoints: OAuthEndpoints): void {
  try {
    const hasApiKey = hasApiKeyField(token);
    const hasAccess = hasAccessToken(token);
    const expRaw = token?.expires_at ?? token?.expired ?? token?.expiry_date ?? null;
    logOAuthDebug(
      `[OAuth] token.read: provider=${providerType} exists=${Boolean(token)} hasApiKey=${hasApiKey} hasAccess=${hasAccess} expRaw=${String(expRaw)}`
    );
    if (providerType === 'iflow') {
      logOAuthDebug(`[OAuth] iflow endpoints: deviceCodeUrl=${String(endpoints.deviceCodeUrl)} tokenUrl=${String(endpoints.tokenUrl)}`);
    }
  } catch {
    // ignore logging failures
  }
}

function buildEndpointOverrides(defaults: OAuthFlowConfig, auth: ExtendedOAuthAuth): OAuthEndpoints {
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

async function enrichIflowClientConfig(client: OAuthClientConfig): Promise<OAuthClientConfig> {
  const next = { ...client };
  if (hasNonEmptyString(process.env.IFLOW_CLIENT_ID)) {
    next.clientId = process.env.IFLOW_CLIENT_ID!.trim();
  }
  if (hasNonEmptyString(process.env.IFLOW_CLIENT_SECRET)) {
    next.clientSecret = process.env.IFLOW_CLIENT_SECRET!.trim();
  }
  if (!hasNonEmptyString(next.clientId) || !hasNonEmptyString(next.clientSecret)) {
    const inferred = await inferIflowClientCredsFromLog();
    if (inferred?.clientId && !hasNonEmptyString(next.clientId)) {
      next.clientId = inferred.clientId;
    }
    if (inferred?.clientSecret && !hasNonEmptyString(next.clientSecret)) {
      next.clientSecret = inferred.clientSecret;
    }
  }
  return next;
}

async function buildClientOverrides(defaults: OAuthFlowConfig, auth: ExtendedOAuthAuth, providerType: string): Promise<OAuthClientConfig> {
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
  if (providerType === 'iflow') {
    return await enrichIflowClientConfig(base);
  }
  return base;
}

async function ensureGeminiCLIServicesEnabled(accessToken: string, projectId: string): Promise<void> {
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
        } catch {
          // ignore parse errors; fall through to enable
        }
      } else {
        // drain body
        await checkResp.text().catch(() => {});
      }
    } catch (error) {
      logOAuthDebug(
        `[OAuth] Gemini CLI: failed to check service ${service} for project ${projectId} - ${error instanceof Error ? error.message : String(error)}`
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
      bodyText = await enableResp.text().catch(() => '');
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
    } catch {
      // ignore parse errors
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

function buildHeaderOverrides(defaults: OAuthFlowConfig, providerType: string): Record<string, string> {
  const baseHeaders = { ...(defaults.headers || {}) };
  if (providerType === 'iflow') {
    return {
      ...baseHeaders,
      'User-Agent': 'iflow-cli/2.0',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://iflow.cn',
      'Referer': 'https://iflow.cn/oauth',
      'Accept': 'application/json'
    };
  }
  return baseHeaders;
}

function resolveTokenAliasFromPath(tokenFilePath: string): string | undefined {
  const parsed = parseTokenSequenceFromPath(tokenFilePath);
  return parsed?.alias;
}

function resolveTokenPortalBaseUrl(): string | null {
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

function buildTokenPortalConfig(
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

async function buildOverrides(
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

async function finalizeTokenWrite(
  providerType: string,
  strategy: OAuthStrategy,
  tokenFilePath: string,
  tokenData: UnknownObject | void,
  reason: string
): Promise<void> {
  if (!tokenData || typeof strategy.saveToken !== 'function') {
    return;
  }
  const enriched = await maybeEnrichToken(providerType, tokenData, tokenFilePath);
  const prepared = await prepareTokenForStorage(providerType, tokenFilePath, enriched);
  await strategy.saveToken(prepared);
  logOAuthDebug(`[OAuth] Token ${reason} saved: ${tokenFilePath}`);
}

async function maybeEnrichToken(
  providerType: string,
  tokenData: UnknownObject,
  tokenFilePath?: string
): Promise<UnknownObject> {
  if (providerType === 'qwen') {
    const sanitized = sanitizeToken(tokenData) ?? (tokenData as StoredOAuthToken);
    if (hasStableQwenApiKey(sanitized)) {
      return tokenData;
    }
    const accessToken = extractAccessToken(sanitized);
    if (!accessToken) {
      logOAuthDebug('[OAuth] Qwen: no access_token found in auth result, skipping API Key fetch');
      return tokenData;
    }
    try {
      const userInfo = await fetchQwenUserInfo(accessToken);
      if (userInfo.apiKey) {
        logOAuthDebug(`[OAuth] Qwen: successfully fetched API Key${userInfo.email ? ` for ${userInfo.email}` : ''}`);
      } else {
        logOAuthDebug('[OAuth] Qwen: user info fetched but apiKey missing; continuing with access_token only');
      }
      return mergeQwenTokenData(tokenData, userInfo) as unknown as UnknownObject;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // If userInfo endpoint is unavailable (404), treat access_token as api_key to avoid repeated lookups.
      if (/\bHTTP\s+404\b/i.test(msg) || /\bnot\s+found\b/i.test(msg)) {
        logOAuthDebug('[OAuth] Qwen: userInfo endpoint unavailable (404); using access_token as api_key fallback');
        return mergeQwenTokenData(tokenData, { apiKey: accessToken }) as unknown as UnknownObject;
      }
      logOAuthDebug(`[OAuth] Qwen: failed to fetch user info - ${msg}`);
      return tokenData;
    }
  }
  if (providerType === 'iflow') {
    const accessToken = extractAccessToken(sanitizeToken(tokenData) ?? null);
    if (!accessToken) {
      logOAuthDebug('[OAuth] iFlow: no access_token found in auth result, skipping API Key fetch');
      return tokenData;
    }
    try {
      const userInfo = await fetchIFlowUserInfo(accessToken);
      logOAuthDebug(`[OAuth] iFlow: successfully fetched API Key for ${userInfo.email}`);
      return mergeIFlowTokenData(tokenData, userInfo) as unknown as UnknownObject;
    } catch (error) {
      console.error(`[OAuth] iFlow: failed to fetch API Key - ${error instanceof Error ? error.message : String(error)}`);
      return tokenData;
    }
  }
  if (providerType === 'antigravity') {
    const accessToken = extractAccessToken(sanitizeToken(tokenData) ?? null);
    if (!accessToken) {
      logOAuthDebug('[OAuth] Antigravity: no access_token found in auth result, skipping metadata fetch');
      return tokenData;
    }
    try {
      const userInfo = await fetchGeminiCLIUserInfo(accessToken);
      const projectId = await fetchAntigravityProjectId(accessToken, undefined, { tokenFilePath });
      const projects = projectId ? [{ projectId }] : [];
      const merged = mergeGeminiCLITokenData(tokenData, userInfo, projects) as unknown as UnknownObject;
      if (projectId) {
        merged.project_id = projectId;
      }
      return merged;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[OAuth] Antigravity: failed to fetch metadata - ${msg}`);
      const normalized = msg.toLowerCase();
      const isAuthError =
        normalized.includes('401') ||
        normalized.includes('unauthorized') ||
        normalized.includes('invalid_grant') ||
        normalized.includes('invalid_token') ||
        normalized.includes('permission denied');
      if (isAuthError) {
        throw error instanceof Error ? error : new Error(msg);
      }
    }
  } else if (isGeminiCliFamily(providerType)) {
    const label = 'Gemini CLI';
    const accessToken = extractAccessToken(sanitizeToken(tokenData) ?? null);
    if (!accessToken) {
      logOAuthDebug(`[OAuth] ${label}: no access_token found in auth result, skipping UserInfo fetch`);
      return tokenData;
    }

    try {
      const userInfo = await fetchGeminiCLIUserInfo(accessToken);

      // 项目信息是可选增强：失败时不应阻塞整个 provider 初始化。
      let projects: ReturnType<typeof fetchGeminiCLIProjects> extends Promise<infer P>
        ? P
        : unknown[] = [] as unknown as ReturnType<typeof fetchGeminiCLIProjects> extends Promise<infer P>
        ? P
        : unknown[];
      try {
        projects = await fetchGeminiCLIProjects(accessToken);
      } catch (projectsError) {
        const msg = projectsError instanceof Error ? projectsError.message : String(projectsError);
        console.error(`[OAuth] ${label}: failed to fetch Projects - ${msg}`);
        projects = [];
      }

      logOAuthDebug(`[OAuth] ${label}: fetched UserInfo for ${userInfo.email} and ${projects.length} projects`);

      const merged = mergeGeminiCLITokenData(tokenData, userInfo, projects) as unknown as UnknownObject;
      const projectId = getDefaultProjectId(merged);

      if (projectId) {
        try {
          await ensureGeminiCLIServicesEnabled(accessToken, projectId);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logOAuthDebug(`[OAuth] ${label}: service enablement failed for project ${projectId} - ${msg}`);
          // 服务启用失败不再视为致命错误，后续真实调用时再由 providerErrorCenter 处理。
        }
      }
      return merged;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[OAuth] ${label}: failed to fetch UserInfo - ${msg}`);

      // 将明确的 401/invalid token 视为凭证失效，由调用方决定是否触发重新授权。
      const normalized = msg.toLowerCase();
      const isAuthError =
        normalized.includes('401') ||
        normalized.includes('unauthorized') ||
        normalized.includes('invalid_grant') ||
        normalized.includes('invalid_token') ||
        normalized.includes('permission denied');

      if (isAuthError) {
        throw error instanceof Error ? error : new Error(msg);
      }

      // 其余错误仅记录日志，不再阻止 provider 初始化，回退到未 enrich 的 token。
      return tokenData;
    }
  }
  return tokenData;
}

function logOAuthSetup(
  providerType: string,
  defaults: OAuthFlowConfig,
  overrides: Record<string, unknown>,
  endpoints: OAuthEndpoints,
  client: OAuthClientConfig,
  tokenFilePath: string,
  openBrowser: boolean,
  forceReauth: boolean
): void {
  try {
    logOAuthDebug(
      `[OAuth] ensureValid: provider=${providerType} flow=${String(defaults.flowType)} activation=${String(
        overrides.activationType
      )} tokenFile=${tokenFilePath} openBrowser=${openBrowser} forceReauth=${forceReauth}`
    );
    if (endpoints.deviceCodeUrl || endpoints.authorizationUrl) {
      logOAuthDebug(
        `[OAuth] endpoints: deviceCodeUrl=${String(endpoints.deviceCodeUrl || '')} tokenUrl=${String(
          endpoints.tokenUrl
        )} authUrl=${String(endpoints.authorizationUrl || '')} userInfoUrl=${String(endpoints.userInfoUrl || '')}`
      );
    }
    if (providerType === 'iflow') {
      logOAuthDebug(
        `[OAuth] iflow client: id=${String(client.clientId || '(missing)')} secret=${
          client.clientSecret ? '(present)' : '(missing)'
        } redirect=${String(client.redirectUri || '(default)')}`
      );
    }
  } catch {
    // ignore log errors
  }
}

function createStrategy(
  providerType: string,
  overrides: Record<string, unknown>,
  tokenFilePath: string
): OAuthStrategy {
  return createProviderOAuthStrategy(providerType, overrides, tokenFilePath) as OAuthStrategy;
}

function resolveCamoCommand(): string {
  const configured = String(process.env.ROUTECODEX_CAMO_CLI_PATH || process.env.RCC_CAMO_CLI_PATH || '').trim();
  return configured || 'camo';
}

function isTruthyFlag(value: string | undefined): boolean {
  const raw = String(value || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function resolveOAuthProfileId(providerType: string, tokenFilePath: string): string {
  const parsed = parseTokenSequenceFromPath(tokenFilePath);
  const alias = String(parsed?.alias || 'default').trim().toLowerCase();
  const normalizedAlias = alias.replace(/[^a-z0-9._-]+/gi, '-');
  const normalizedProvider = String(providerType || '').trim().toLowerCase();
  const providerFamily = normalizedProvider === 'gemini-cli' || normalizedProvider === 'antigravity'
    ? 'gemini'
    : normalizedProvider;
  const base = providerFamily ? `${providerFamily}.${normalizedAlias || 'default'}` : (normalizedAlias || 'default');
  const profile = `rc-${base}`;
  return profile.length > 64 ? profile.slice(0, 64) : profile;
}

function closeOAuthAuthResources(providerType: string, tokenFilePath: string): void {
  const profileId = resolveOAuthProfileId(providerType, tokenFilePath);
  try {
    const result = spawnSync(resolveCamoCommand(), ['stop', profileId], {
      stdio: 'ignore',
      env: process.env
    });
    if (result.status === 0) {
      logOAuthDebug(`[OAuth] auth cleanup: stopped camo profile=${profileId}`);
    } else {
      logOAuthDebug(`[OAuth] auth cleanup: camo stop profile=${profileId} status=${result.status ?? 'n/a'}`);
    }
  } catch (error) {
    logOAuthDebug(
      `[OAuth] auth cleanup failed profile=${profileId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function shouldAutoCloseOAuthBrowserSession(): boolean {
  const raw = String(
    process.env.ROUTECODEX_OAUTH_AUTO_CLOSE_BROWSER ??
    process.env.RCC_OAUTH_AUTO_CLOSE_BROWSER ??
    ''
  ).trim().toLowerCase();
  if (!raw) {
    // Default: keep browser session alive and rely on camo idle-timeout cleanup.
    return false;
  }
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function readInteractiveOAuthLock(): InteractiveOAuthLockRecord | null {
  try {
    if (!fsSync.existsSync(OAUTH_INTERACTIVE_LOCK_FILE)) {
      return null;
    }
    const raw = fsSync.readFileSync(OAUTH_INTERACTIVE_LOCK_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const node = parsed as Record<string, unknown>;
    if (typeof node.pid !== 'number' || typeof node.tokenFile !== 'string' || typeof node.providerType !== 'string') {
      return null;
    }
    return {
      pid: node.pid,
      tokenFile: node.tokenFile,
      providerType: node.providerType,
      startedAt: typeof node.startedAt === 'number' ? node.startedAt : Date.now(),
      callbackPort: typeof node.callbackPort === 'number' ? node.callbackPort : undefined
    };
  } catch {
    return null;
  }
}

function isSameInteractiveOAuthLock(
  left: Pick<InteractiveOAuthLockRecord, 'pid' | 'providerType' | 'tokenFile'>,
  right: Pick<InteractiveOAuthLockRecord, 'pid' | 'providerType' | 'tokenFile'>
): boolean {
  return (
    left.pid === right.pid &&
    left.providerType === right.providerType &&
    path.resolve(left.tokenFile) === path.resolve(right.tokenFile)
  );
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function forceReclaimInteractiveOAuthLock(lock: InteractiveOAuthLockRecord): Promise<boolean> {
  try {
    const existing = readInteractiveOAuthLock();
    if (!existing || !isSameInteractiveOAuthLock(existing, lock)) {
      return false;
    }
    await fs.unlink(OAUTH_INTERACTIVE_LOCK_FILE);
    logOAuthDebug(
      `[OAuth] interactive lock reclaimed pid=${lock.pid} token=${lock.tokenFile} provider=${lock.providerType}`
    );
    return true;
  } catch {
    return false;
  }
}

async function notifyOAuthLockCancel(lock: InteractiveOAuthLockRecord): Promise<void> {
  if (!lock.callbackPort || !Number.isFinite(lock.callbackPort) || lock.callbackPort <= 0) {
    return;
  }
  const url = `http://127.0.0.1:${lock.callbackPort}/oauth2callback?error=cancelled_by_new_auth`;
  try {
    await fetch(url, { method: 'GET' });
    logOAuthDebug(`[OAuth] interactive lock cancel signal sent port=${lock.callbackPort}`);
  } catch (error) {
    logOAuthDebug(
      `[OAuth] interactive lock cancel signal failed port=${lock.callbackPort}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function acquireInteractiveOAuthLock(providerType: string, tokenFilePath: string): Promise<() => void> {
  await fs.mkdir(path.dirname(OAUTH_INTERACTIVE_LOCK_FILE), { recursive: true });
  const current: InteractiveOAuthLockRecord = {
    pid: process.pid,
    providerType,
    tokenFile: path.resolve(tokenFilePath),
    startedAt: Date.now()
  };

  const maxAttempts = 20;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await fs.writeFile(OAUTH_INTERACTIVE_LOCK_FILE, `${JSON.stringify(current, null, 2)}\n`, { flag: 'wx' });
      process.env.ROUTECODEX_OAUTH_INTERACTIVE_LOCK_FILE = OAUTH_INTERACTIVE_LOCK_FILE;
      return () => {
        try {
          const lock = readInteractiveOAuthLock();
          if (lock && lock.pid === process.pid && path.resolve(lock.tokenFile) === current.tokenFile) {
            fsSync.unlinkSync(OAUTH_INTERACTIVE_LOCK_FILE);
          }
        } catch {
          // ignore release errors
        } finally {
          if (process.env.ROUTECODEX_OAUTH_INTERACTIVE_LOCK_FILE === OAUTH_INTERACTIVE_LOCK_FILE) {
            delete process.env.ROUTECODEX_OAUTH_INTERACTIVE_LOCK_FILE;
          }
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code || '';
      if (code !== 'EEXIST') {
        throw error;
      }
      const existing = readInteractiveOAuthLock();
      if (!existing) {
        try {
          await fs.unlink(OAUTH_INTERACTIVE_LOCK_FILE);
        } catch {
          // ignore
        }
        continue;
      }
      if (!isProcessAlive(existing.pid)) {
        try {
          await fs.unlink(OAUTH_INTERACTIVE_LOCK_FILE);
        } catch {
          // ignore
        }
        continue;
      }
      const sameToken = path.resolve(existing.tokenFile) === current.tokenFile;
      if (sameToken) {
        await notifyOAuthLockCancel(existing);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const afterCancel = readInteractiveOAuthLock();
        const stuckOnSameLock =
          !!afterCancel && isSameInteractiveOAuthLock(afterCancel, existing);
        if (stuckOnSameLock) {
          const lockAgeMs = Math.max(0, Date.now() - (afterCancel.startedAt || Date.now()));
          const shouldForceReclaim = attempt >= 3 || lockAgeMs >= 15_000;
          if (shouldForceReclaim) {
            await forceReclaimInteractiveOAuthLock(afterCancel);
          }
        }
        continue;
      }
      throw new Error(
        `Interactive OAuth is already running for token=${existing.tokenFile}. Concurrent auth is disabled.`
      );
    }
  }
  throw new Error('Failed to acquire interactive OAuth lock after multiple attempts');
}

function readIflowAutoFailureState(): Record<string, IflowAutoFailureRecord> {
  try {
    if (!fsSync.existsSync(IFLOW_AUTO_FAILURE_FILE)) {
      return {};
    }
    const raw = fsSync.readFileSync(IFLOW_AUTO_FAILURE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, IflowAutoFailureRecord>;
  } catch {
    return {};
  }
}

function writeIflowAutoFailureState(state: Record<string, IflowAutoFailureRecord>): void {
  try {
    fsSync.mkdirSync(path.dirname(IFLOW_AUTO_FAILURE_FILE), { recursive: true });
    fsSync.writeFileSync(IFLOW_AUTO_FAILURE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    // ignore persistence failures
  }
}

function resolveIflowFailureKey(tokenFilePath: string): string {
  return path.resolve(tokenFilePath);
}

function clearIflowAutoFailureState(tokenFilePath: string): void {
  const state = readIflowAutoFailureState();
  const key = resolveIflowFailureKey(tokenFilePath);
  if (!state[key]) {
    return;
  }
  delete state[key];
  writeIflowAutoFailureState(state);
}

function markIflowAutoFailureState(tokenFilePath: string, maxAttempts: number, errorText: string): IflowAutoFailureRecord {
  const state = readIflowAutoFailureState();
  const key = resolveIflowFailureKey(tokenFilePath);
  const previous = state[key];
  const nextCount = (previous?.count || 0) + 1;
  const record: IflowAutoFailureRecord = {
    count: nextCount,
    manualRequired: nextCount >= maxAttempts,
    updatedAt: Date.now(),
    lastError: errorText
  };
  state[key] = record;
  writeIflowAutoFailureState(state);
  return record;
}

function getIflowAutoFailureState(tokenFilePath: string): IflowAutoFailureRecord | null {
  const state = readIflowAutoFailureState();
  const key = resolveIflowFailureKey(tokenFilePath);
  return state[key] || null;
}

async function runInteractiveAuthorizationFlow(
  providerType: string,
  overrides: Record<string, unknown>,
  tokenFilePath: string,
  openBrowser: boolean,
  forceTokenReset: boolean,
  forceReauth: boolean
): Promise<void> {
  const execute = async (): Promise<void> => {
    let backupFile: string | null = null;
    if (forceTokenReset) {
      // 仅做备份，不再删除原始 token 文件，避免在用户中断流程时造成不可恢复的丢失。
      // 对于强制重新授权的场景，ensureValidOAuthToken 会忽略现有 token 状态并直接进入交互式流程。
      backupFile = await backupTokenFile(tokenFilePath);
    }
    try {
      if (providerType === 'iflow') {
        await runIflowAuthorizationSequence(providerType, overrides, tokenFilePath, forceReauth);
      } else {
        const strategy = createStrategy(providerType, overrides, tokenFilePath);
        const authed = await strategy.authenticate?.({ openBrowser, forceReauthorize: forceReauth });
        await finalizeTokenWrite(providerType, strategy, tokenFilePath, authed, 'acquired');
      }
      await discardBackupFile(backupFile);
      if (openBrowser && shouldAutoCloseOAuthBrowserSession()) {
        // Optional: close only after token is fully written; never close browser on failed auth.
        closeOAuthAuthResources(providerType, tokenFilePath);
      }
    } catch (error) {
      await restoreTokenFileFromBackup(backupFile, tokenFilePath);
      throw error;
    }
  };

  if (!openBrowser) {
    await execute();
    return;
  }

  const label = `${providerType}:${tokenFilePath}`;
  const queued = interactiveTail.current
    .catch(() => {
      // ignore previous rejection so queue continues
    })
    .then(async () => {
      logOAuthDebug(`[OAuth] interactive queue enter ${label}`);
      const releaseLock = await acquireInteractiveOAuthLock(providerType, tokenFilePath);
      try {
        await execute();
      } finally {
        releaseLock();
        logOAuthDebug(`[OAuth] interactive queue leave ${label}`);
      }
    });
  interactiveTail.next = queued.then(
    () => undefined,
    () => undefined
  );
  await queued;
}

async function runIflowAuthorizationSequence(
  providerType: string,
  overrides: Record<string, unknown>,
  tokenFilePath: string,
  forceReauth: boolean
): Promise<void> {
  const authCodeOverrides = { ...overrides, flowType: OAuthFlowType.AUTHORIZATION_CODE };
  const autoMode = String(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE || '').trim().toLowerCase();
  if (autoMode === 'iflow') {
    // Auto mode should stay single-path to keep retry lifecycle deterministic.
    await executeAuthFlow(providerType, authCodeOverrides, tokenFilePath, forceReauth);
    return;
  }
  try {
    await executeAuthFlow(providerType, authCodeOverrides, tokenFilePath, forceReauth);
    return;
  } catch (firstError) {
    logOAuthDebug(
      `[OAuth] auth_code flow failed: ${firstError instanceof Error ? firstError.message : String(firstError || '')}`
    );
  }
  const deviceOverrides = { ...overrides, flowType: OAuthFlowType.DEVICE_CODE };
  await executeAuthFlow(providerType, deviceOverrides, tokenFilePath, forceReauth);
}

async function executeAuthFlow(
  providerType: string,
  overrides: Record<string, unknown>,
  tokenFilePath: string,
  forceReauth: boolean
): Promise<void> {
  const runOnce = async (): Promise<void> => {
    const strategy = createStrategy(providerType, overrides, tokenFilePath);
    const authed = await strategy.authenticate?.({ openBrowser: true, forceReauthorize: forceReauth });
    await finalizeTokenWrite(
      providerType,
      strategy,
      tokenFilePath,
      authed,
      overrides.flowType ? `acquired (${String(overrides.flowType)})` : 'acquired'
    );
  };

  const autoMode = String(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE || '').trim().toLowerCase();
  const iflowAutoEnabled = providerType === 'iflow' && autoMode === 'iflow';
  if (!iflowAutoEnabled) {
    await runOnce();
    if (providerType === 'iflow') {
      clearIflowAutoFailureState(tokenFilePath);
    }
    return;
  }
  const headfulMode = isTruthyFlag(process.env.ROUTECODEX_CAMOUFOX_DEV_MODE);
  const maxAutoAttemptsRaw = Number.parseInt(String(process.env.ROUTECODEX_IFLOW_AUTO_MAX_ATTEMPTS || '').trim(), 10);
  const maxAutoAttempts = Number.isFinite(maxAutoAttemptsRaw) && maxAutoAttemptsRaw > 0 ? maxAutoAttemptsRaw : 3;
  const retryDelayRaw = Number.parseInt(String(process.env.ROUTECODEX_IFLOW_AUTO_RETRY_DELAY_MS || '').trim(), 10);
  const retryDelayMs = Number.isFinite(retryDelayRaw) && retryDelayRaw >= 0 ? retryDelayRaw : 1000;

  // Headful run is considered manual trigger; successful manual run clears auto failure gate.
  if (headfulMode) {
    await runOnce();
    clearIflowAutoFailureState(tokenFilePath);
    return;
  }

  const existingFailure = getIflowAutoFailureState(tokenFilePath);
  if (existingFailure?.manualRequired) {
    throw new Error(
      `[OAuth] iflow auto auth is disabled for token=${tokenFilePath} after ${existingFailure.count} failures. Manual trigger required.`
    );
  }

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAutoAttempts; attempt += 1) {
    try {
      await runOnce();
      clearIflowAutoFailureState(tokenFilePath);
      return;
    } catch (error) {
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error || '');
      const record = markIflowAutoFailureState(tokenFilePath, maxAutoAttempts, msg);
      logOAuthDebug(
        `[OAuth] iflow auto auth attempt ${attempt}/${maxAutoAttempts} failed: ${msg} ` +
          `(failureCount=${record.count} manualRequired=${record.manualRequired ? '1' : '0'})`
      );
      if (attempt < maxAutoAttempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  const finalRecord = getIflowAutoFailureState(tokenFilePath);
  if (finalRecord?.manualRequired) {
    throw new Error(
      `[OAuth] iflow auto auth failed ${finalRecord.count} times; manual trigger is required and auto retries are suspended.`
    );
  }
  throw (lastError instanceof Error ? lastError : new Error(String(lastError || 'iflow auto auth failed')));
}

export async function ensureValidOAuthToken(
  providerType: string,
  auth: OAuthAuth,
  opts: EnsureOpts = {}
): Promise<void> {
  if (!isOAuthConfig(auth)) {
    return;
  }

  const tokenFilePath = resolveTokenFilePath(auth, providerType);
  const cacheKey = keyFor(providerType, tokenFilePath);
  if (inFlight.has(cacheKey)) {
    await inFlight.get(cacheKey)!;
    return;
  }
  // Only treat "open browser" as explicit user intent when caller passed it explicitly.
  // This prevents background flows (daemon/provider init) from bypassing noRefresh due to env defaults.
  const openBrowserRequested = opts.openBrowser === true;
  // 当 opts.forceReauthorize 显式为 true 时，跳过节流检查，
  // 确保来自上游 401/406 等认证错误的修复请求不会被初始化阶段的调用吞掉。
  // Explicit user-triggered OAuth (openBrowser=true) must also bypass throttle,
  // otherwise repeated "Authorize" clicks in WebUI can become a silent no-op.
  if (!opts.forceReauthorize && !openBrowserRequested && shouldThrottle(cacheKey)) {
    return;
  }

  const aliasInfo = parseTokenSequenceFromPath(tokenFilePath);
  const isStaticAlias = aliasInfo?.alias === 'static';
  if (isStaticAlias) {
    logOAuthDebug(
      `[OAuth] static alias token detected, skipping refresh/reauth (provider=${providerType} tokenFile=${tokenFilePath})`
    );
    updateThrottle(cacheKey);
    return;
  }

  // Browser-based OAuth must be opt-in by caller.
  // This prevents server startup / preflight paths from accidentally entering interactive flow.
  const openBrowser = opts.openBrowser === true;
  const forceReauth =
    opts.forceReauthorize === true || String(process.env.ROUTECODEX_OAUTH_FORCE_REAUTH || '0') === '1';

  const runPromise = (async () => {
    const defaults = getProviderOAuthConfig(providerType, {});
    const { overrides, endpoints, client } = await buildOverrides(
      providerType,
      defaults,
      auth,
      openBrowser,
      tokenFilePath
    );
    logOAuthSetup(providerType, defaults, overrides, endpoints, client, tokenFilePath, openBrowser, forceReauth);
    const strategy = createStrategy(providerType, overrides, tokenFilePath);
    let token = await readTokenFromFile(tokenFilePath);
    if (providerType === 'iflow') {
      token = await maybeAdoptIflowExternalToken(strategy, tokenFilePath, token);
    }
    const hadExistingTokenFile = token !== null;

    // Qwen: ensure api_key is present even when access_token is still valid.
    // Qwen OpenAI-compatible endpoints may require api_key (not access_token) for business requests.
    if (providerType === 'qwen' && token && !hasStableQwenApiKey(token)) {
      try {
        const enriched = await maybeEnrichToken(providerType, token as UnknownObject);
        if (enriched && typeof strategy.saveToken === 'function') {
          const prepared = await prepareTokenForStorage(providerType, tokenFilePath, enriched);
          await strategy.saveToken(prepared);
          token = sanitizeToken(enriched) ?? (enriched as StoredOAuthToken);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[OAuth] Qwen: failed to enrich existing token with api_key - ${msg}`);
      }
    }

    // Gemini CLI family: if existing token lacks project metadata, try to enrich it without
    // forcing a full OAuth flow. Use current access_token to fetch userinfo/projects and write back.
    if (isGeminiCliFamily(providerType) && token) {
      try {
        const hasProjectMetadata = providerType === 'antigravity'
          ? hasNonEmptyString(resolveProjectId(token as UnknownObject))
          : Boolean(getDefaultProjectId(token as UnknownObject));
        if (!hasProjectMetadata) {
          const enriched = await maybeEnrichToken(providerType, token as UnknownObject);
          if (enriched && typeof strategy.saveToken === 'function') {
            const prepared = await prepareTokenForStorage(providerType, tokenFilePath, enriched);
            await strategy.saveToken(prepared);
            token = sanitizeToken(enriched) ?? (enriched as StoredOAuthToken);
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(
          `[OAuth] ${providerType}: failed to enrich existing token with project metadata - ${msg}`
        );
        // 若明确是 401 / invalid token 类错误，将 token 视为无效，后续强制走重新授权流程。
        const lower = msg.toLowerCase();
        const authError =
          /invalid[_-]?token|invalid[_-]?grant|unauthenticated|unauthorized/.test(lower) ||
          lower.includes('http 401');
        if (authError && forceReauth) {
          token = null;
        }
      }
    }

    logTokenSnapshot(providerType, token, endpoints);
    const tokenState = evaluateTokenState(token, providerType);
    const noRefresh = hasNoRefreshFlag(token);

    if (noRefresh && !forceReauth && !openBrowserRequested) {
      logOAuthDebug(
        `[OAuth] norefresh flag set for provider=${providerType} tokenFile=${tokenFilePath} - skip auto-refresh and re-authorization.`
      );
      updateThrottle(cacheKey);
      return;
    }

    if (!forceReauth && tokenState.validAccess) {
      logOAuthDebug(
        `[OAuth] Using existing token (${tokenState.hasApiKey ? 'apiKey' : 'access_token'} valid). No authorization required.`
      );
      updateThrottle(cacheKey);
      return;
    }

    if (
      !forceReauth &&
      tokenState.isExpiredOrNear &&
      token?.refresh_token &&
      typeof strategy.refreshToken === 'function'
    ) {
      try {
        logOAuthDebug('[OAuth] refreshing token...');
        const refreshed = await strategy.refreshToken(token.refresh_token);
        await finalizeTokenWrite(providerType, strategy, tokenFilePath, refreshed, 'refreshed and saved');
        updateThrottle(cacheKey);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || '');
        applyRefreshFailureBackoff(cacheKey, providerType, message);
        if (providerType === 'iflow') {
          // Align iFlow CLI behavior: refresh failure invalidates local token cache first.
          await clearTokenFile(tokenFilePath);
        }
        if (!opts.forceReacquireIfRefreshFails) {
          throw error;
        }
        logOAuthDebug(`[OAuth] refresh failed (${providerType}): ${message}`);
        logOAuthDebug('[OAuth] refresh failed, attempting interactive authorization...');
      }
    }

    try {
      const flowTypeRaw = String(overrides.flowType || defaults.flowType || '').trim().toLowerCase();
      const authorizationCodeFlow =
        flowTypeRaw === String(OAuthFlowType.AUTHORIZATION_CODE).trim().toLowerCase();
      if (!openBrowser && authorizationCodeFlow) {
        // Non-interactive contexts must never enter auth-code callback/manual prompts.
        // Let callers decide whether to retry in explicit interactive mode.
        throw new Error(
          `[OAuth] interactive authorization requires openBrowser=true for ${providerType} (flow=${flowTypeRaw || 'authorization_code'})`
        );
      }
      await runInteractiveAuthorizationFlow(
        providerType,
        overrides,
        tokenFilePath,
        openBrowser,
        forceReauth || hadExistingTokenFile,
        forceReauth
      );
      updateThrottle(cacheKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || '');
      // 当本地回调端口已被占用（例如已有其他 OAuth 工具在监听同一端口）时，
      // 将其视为“暂时无法进行交互式授权”，不再向上抛出致命错误，以免阻塞整个服务器启动。
      // 保持现有 token 不变，让后续真实请求决定是否需要修复。
      if (message.includes('Failed to start callback server')) {
        console.error(`[OAuth] interactive authorization skipped (callback server error): ${message}`);
        updateThrottle(cacheKey);
        return;
      }
      throw error;
    }
  })();

  inFlight.set(cacheKey, runPromise);
  try {
    await runPromise;
  } finally {
    inFlight.delete(cacheKey);
  }
}

export async function handleUpstreamInvalidOAuthToken(
  providerType: string,
  auth: OAuthAuth,
  upstreamError: unknown,
  options?: {
    /**
     * When false, interactive OAuth repair must not block the current request.
     * The repair flow will be started in the background (subject to cooldown),
     * and this function will return `false` so the router can failover.
     */
    allowBlocking?: boolean;
    /**
     * Test-only injection: override ensureValidOAuthToken implementation.
     */
    ensureValidOAuthToken?: typeof ensureValidOAuthToken;
  }
): Promise<boolean> {
  const pt = providerType.toLowerCase();
  const allowBlocking = options?.allowBlocking !== false;
  const ensureValid = options?.ensureValidOAuthToken ?? ensureValidOAuthToken;
  try {
    if (!shouldTriggerInteractiveOAuthRepair(providerType, upstreamError)) {
      return false;
    }
    const msg =
      upstreamError instanceof Error
        ? upstreamError.message
        : upstreamError && typeof upstreamError === 'object' && typeof (upstreamError as any).message === 'string'
          ? String((upstreamError as any).message)
          : String(upstreamError || '');
    const lower = msg.toLowerCase();
    const statusCode = extractStatusCode(upstreamError);
    const tokenFilePath = resolveTokenFilePath(auth as ExtendedOAuthAuth, providerType);
    const cooldownReason: OAuthRepairCooldownReason =
      statusCode === 403 && isGoogleAccountVerificationRequiredMessage(lower) ? 'google_verify' : 'generic';
    const gate = await shouldSkipInteractiveOAuthRepair({
      providerType,
      tokenFile: tokenFilePath,
      reason: cooldownReason
    });
    if (gate.skip) {
      const msLeft = typeof gate.msLeft === 'number' ? gate.msLeft : 0;
      const attempts = typeof gate.record?.attemptCount === 'number' ? gate.record.attemptCount : 0;
      console.warn(
        `[OAuth] interactive repair skipped (provider=${providerType} status=${statusCode ?? 'unknown'} reason=${cooldownReason} attempts=${attempts} msLeft=${msLeft} tokenFile=${tokenFilePath})`
      );
      return false;
    }
    // Mark immediately so repeated auth failures don't cause infinite auth loops within a short window.
    await markInteractiveOAuthRepairAttempt({
      providerType,
      tokenFile: tokenFilePath,
      reason: cooldownReason
    });

    // Non-blocking server semantics:
    // - Try silent refresh first (fast path).
    // - If refresh fails or interactive is required (e.g. 403 verify), kick off interactive flow in background.
    // - Return false so Virtual Router can failover immediately.
    if (!allowBlocking) {
      if (statusCode === 403 && cooldownReason === 'google_verify') {
        const url = extractGoogleAccountVerificationUrl(msg);
        if (url) {
          void openGoogleAccountVerificationInCamoufox({
            providerType,
            auth: auth as ExtendedOAuthAuth,
            url
          }).catch(() => {});
        }
        return false;
      }
      const refreshRejectedForIflow = pt === 'iflow' && isIflowRefreshEndpointRejectionMessage(lower);
      if (!refreshRejectedForIflow) {
        try {
          await withOAuthRepairEnv(providerType, async () => {
            await ensureValid(providerType, auth, {
              forceReacquireIfRefreshFails: false,
              openBrowser: false,
              forceReauthorize: false
            });
          });
          await markInteractiveOAuthRepairSuccess({
            providerType,
            tokenFile: tokenFilePath
          });
          return true;
        } catch {
          // ignore silent refresh errors; fall through to background interactive flow
        }
      }
      const interactiveOpts: EnsureOpts = {
        forceReacquireIfRefreshFails: true,
        openBrowser: true,
        // 上游已经明确返回“认证失效”（包括 iflow 的 406/439），
        // 此时强制跳过节流并允许走完整 OAuth 流程。
        forceReauthorize: pt === 'gemini' || pt === 'gemini-cli' || pt === 'antigravity' || pt === 'iflow' || pt === 'qwen'
      };
      void withOAuthRepairEnv(providerType, async () => {
        await runInteractiveRepairWithAutoFallback({
          providerType,
          auth,
          ensureValid,
          opts: interactiveOpts
        });
      }).catch(() => {
        // background repair failure must never block requests
      });
      return false;
    }

    const opts: EnsureOpts = {
      forceReacquireIfRefreshFails: true,
      openBrowser: true,
      // 上游已经明确返回“认证失效”（包括 iflow 的 406/439），
      // 此时强制跳过节流并允许走完整 OAuth 流程。
      forceReauthorize: pt === 'gemini' || pt === 'gemini-cli' || pt === 'antigravity' || pt === 'iflow' || pt === 'qwen'
    };
    await withOAuthRepairEnv(providerType, async () => {
      await runInteractiveRepairWithAutoFallback({
        providerType,
        auth,
        ensureValid,
        opts
      });
    });
    await markInteractiveOAuthRepairSuccess({
      providerType,
      tokenFile: tokenFilePath
    });
    return true;
  } catch {
    return false;
  }
}

export function shouldTriggerInteractiveOAuthRepair(providerType: string, upstreamError: unknown): boolean {
  const pt = providerType.toLowerCase();
  const msg =
    upstreamError instanceof Error
      ? upstreamError.message
      : upstreamError && typeof upstreamError === 'object' && typeof (upstreamError as any).message === 'string'
        ? String((upstreamError as any).message)
        : String(upstreamError || '');
  const lower = msg.toLowerCase();
  const statusCode = extractStatusCode(upstreamError);

  // 基本令牌失效判定：只看典型 OAuth 文案
  let looksInvalid =
    /invalid[_-]?token|invalid[_-]?grant|unauthenticated|unauthorized|token has expired|access token expired/.test(
      lower
    );

  // 对于 iflow / qwen，保留基于 401/403 的宽松判定，避免破坏既有行为。
  if (!looksInvalid && (pt === 'iflow' || pt === 'qwen')) {
    if (
      statusCode === 401 ||
      statusCode === 403 ||
      /\b401\b|\b403\b|40308/.test(msg)
    ) {
      looksInvalid = true;
    }
  }
  if (!looksInvalid && pt === 'iflow' && isIflowRefreshEndpointRejectionMessage(lower)) {
    looksInvalid = true;
  }

  // 对于 gemini / gemini-cli / antigravity，排除纯服务开关类错误，
  // 但如果明确提示缺少 project_id 或需要重新 OAuth，则视为令牌失效。
  if (pt === 'gemini' || pt === 'gemini-cli' || pt === 'antigravity') {
    if (/service_disabled/.test(lower) || lower.includes('has not been used in project')) {
      looksInvalid = false;
    }
    if (
      lower.includes('project_id not found in token') ||
      lower.includes('please authenticate with google oauth first')
    ) {
      looksInvalid = true;
    }
    // Antigravity/Gemini may return 403 "verify your account" / validation_required.
    // This is not a token-expired case, but it still requires an interactive OAuth/browser flow
    // to unblock the account. Treat it as "needs interactive reauth".
    if (
      statusCode === 403 &&
      isGoogleAccountVerificationRequiredMessage(lower)
    ) {
      looksInvalid = true;
    }
  }

  return looksInvalid;
}

async function inferIflowClientCredsFromLog(): Promise<{ clientId?: string; clientSecret?: string } | null> {
  try {
    const home = process.env.HOME || '';
    const file = path.join(home, '.routecodex', 'auth', 'iflow-oauth.log');
    const txt = await fs.readFile(file, 'utf-8').catch(() => '');
    if (!txt) {
      return null;
    }
    const lines = txt.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      return null;
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      try {
        const obj = JSON.parse(line) as { decoded?: string };
        const decoded = typeof obj.decoded === 'string' ? obj.decoded : '';
        if (!decoded.includes(':')) {
          continue;
        }
        const idx = decoded.indexOf(':');
        const id = decoded.slice(0, idx).trim();
        const secret = decoded.slice(idx + 1).trim();
        if (id && secret) {
          return { clientId: id, clientSecret: secret };
        }
      } catch {
        // skip parse errors
      }
    }
    return null;
  } catch {
    return null;
  }
}
