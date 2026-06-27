import type { OAuthAuth } from '../core/api/provider-config.js';
import {
  createProviderOAuthStrategy,
  getProviderOAuthConfig
} from '../core/config/provider-oauth-configs.js';
import { OAuthFlowType, type OAuthFlowConfig, type OAuthClientConfig, type OAuthEndpoints } from '../core/config/oauth-flows.js';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'node:child_process';
import type { UnknownObject } from '../../types/common-types.js';
import { parseTokenSequenceFromPath } from './token-scanner/index.js';
import { logOAuthDebug } from './oauth-logger.js';
import { HTTP_PROTOCOLS, LOCAL_HOSTS } from '../../constants/index.js';
import { withOAuthRepairEnv } from './oauth-repair-env.js';
import { openAuthInCamoufox } from '../core/config/camoufox-launcher.js';
import {
  type ExtendedOAuthAuth,
  resolveTokenFilePath,
  resolveCamoufoxAliasForAuth
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
  hasAccessToken,
  getExpiresAt,
  resolveProjectId,
  coerceExpiryTimestampSeconds,
  hasNoRefreshFlag,
  evaluateTokenState
} from './oauth-lifecycle/token-helpers.js';
import {
  sanitizeToken,
  readTokenFromFile,
  backupTokenFile,
  restoreTokenFileFromBackup,
  discardBackupFile,
  clearTokenFile
} from './oauth-lifecycle/token-io.js';
import { resolveRccAuthDir } from '../../config/user-data-paths.js';

import { logOAuthLifecycleNonBlocking } from './oauth-lifecycle/oauth-lifecycle-logger.js';
import {
  readInteractiveOAuthLock,
  isSameInteractiveOAuthLock,
  isProcessAlive,
  forceReclaimInteractiveOAuthLock,
  notifyOAuthLockCancel,
  acquireInteractiveOAuthLock,
} from './oauth-lifecycle/interactive-oauth-lock.js';
import {
  logTokenSnapshot,
} from './oauth-lifecycle/token-preparation.js';


type InteractiveOAuthLockRecord = {
  pid: number;
  providerType: string;
  tokenFile: string;
  startedAt: number;
  callbackPort?: number;
};


const OAUTH_INTERACTIVE_LOCK_FILE = path.join(resolveRccAuthDir(), '.oauth-interactive.lock.json');
const OAUTH_THROTTLE_WINDOW_MS = 60_000;

type EnsureOpts = {
  forceReacquireIfRefreshFails?: boolean;
  openBrowser?: boolean;
  forceReauthorize?: boolean;
  forceRefresh?: boolean;
};

type OAuthStrategy = {
  refreshToken?(refreshToken: string): Promise<UnknownObject>;
  authenticate?(options?: { openBrowser?: boolean; forceReauthorize?: boolean }): Promise<UnknownObject | void>;
  saveToken?(token: UnknownObject | null): Promise<void>;
};

const TOKEN_REFRESH_SKEW_MS = 60_000;


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
  } catch (error) {
    logOAuthLifecycleNonBlocking(
      'openGoogleAccountVerificationInCamoufox',
      error,
      { providerType, alias, url },
      { warn: true }
    );
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

function shouldHonorNoRefresh(providerType: string, token: StoredOAuthToken | null): boolean {
  if (!hasNoRefreshFlag(token)) {
    return false;
  }
  void providerType;
  return true;
}

function extractEcoDevJwtPayload(token: StoredOAuthToken | null): Record<string, unknown> | null {
  const jwtToken = token && typeof (token as UnknownObject).jwt_token === 'string'
    ? String((token as UnknownObject).jwt_token).trim()
    : '';
  if (!jwtToken) {
    return null;
  }
  const parts = jwtToken.split('.');
  if (parts.length !== 3) {
    return null;
  }
  try {
    const normalized = (parts[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function resolveRefreshTokenForProvider(providerType: string, token: StoredOAuthToken | null): string {
  const direct = typeof token?.refresh_token === 'string' ? token.refresh_token.trim() : '';
  if (direct) {
    return direct;
  }
  if (providerType.trim().toLowerCase() !== 'ecodev') {
    return '';
  }
  const payload = extractEcoDevJwtPayload(token);
  const fromJwt = payload && typeof payload.refresh_token === 'string' ? payload.refresh_token.trim() : '';
  return fromJwt;
}

function isElementMissingAutomationFailure(message: string): boolean {
  const normalized = String(message || '').toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes('element not found') ||
    normalized.includes('element_not_found') ||
    normalized.includes('required but not matched')
  );
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
    const normalizedProviderType = String(providerType || '').trim().toLowerCase();
    const msg = error instanceof Error ? error.message : String(error || '');
    const selectorFailure = isElementMissingAutomationFailure(msg);
    let tokenFilePath = '';
    try {
      tokenFilePath = resolveTokenFilePath(auth as ExtendedOAuthAuth, providerType);
    } catch (error) {
      logOAuthLifecycleNonBlocking(
        'runInteractiveRepairWithAutoFallback.resolveTokenFilePath',
        error,
        { providerType }
      );
      tokenFilePath = '';
    }
    if (tokenFilePath) {
      closeOAuthAuthResources(providerType, tokenFilePath);
    }
    console.warn(
      `[OAuth] Camoufox auto OAuth failed (${providerType}, autoMode=${autoModeAtStart}): ${msg}. Falling back to headful manual mode once.`
    );
    if (selectorFailure) {
      console.warn(
        `[OAuth] Camoufox auto selector step failed; switched to headful manual mode (provider=${providerType}${tokenFilePath ? ` tokenFile=${tokenFilePath}` : ''}).`
      );
    }
  }

  const prevAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
  const prevAutoConfirm = process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
  const prevDevMode = process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
  const prevOpenOnly = process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY;
  try {
    delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    delete process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
    process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = '1';
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

function isOAuthConfig(auth: OAuthAuth): auth is ExtendedOAuthAuth {
  return Boolean(auth && typeof auth.type === 'string' && auth.type.toLowerCase().includes('oauth'));
}

async function finalizeTokenWrite(
  providerType: string,
  strategy: OAuthStrategy,
  tokenFilePath: string,
  tokenData: UnknownObject | void,
  reason: string,
  options?: Record<string, never>
): Promise<void> {
  if (!tokenData || typeof strategy.saveToken !== 'function') {
    return;
  }
  await strategy.saveToken(tokenData);
  logOAuthDebug(`[OAuth] Token ${reason} saved: ${tokenFilePath}`);
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
  } catch (error) {
    logOAuthLifecycleNonBlocking('logEnsureContext', error, { providerType, tokenFilePath });
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


function resolveOAuthProfileId(providerType: string, tokenFilePath: string): string {
  const parsed = parseTokenSequenceFromPath(tokenFilePath);
  const alias = String(parsed?.alias || 'default').trim().toLowerCase();
  const normalizedAlias = alias.replace(/[^a-z0-9._-]+/gi, '-');
  const normalizedProvider = String(providerType || '').trim().toLowerCase();
  const providerFamily = normalizedProvider;
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
      const strategy = createStrategy(providerType, overrides, tokenFilePath);
      const authed = await strategy.authenticate?.({ openBrowser, forceReauthorize: forceReauth });
      await finalizeTokenWrite(providerType, strategy, tokenFilePath, authed, 'acquired');
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
    .catch((error) => {
      logOAuthDebug(
        `[OAuth] interactive queue recovered from previous rejection for ${label}: ${error instanceof Error ? error.message : String(error)}`
      );
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
  const forceRefreshRequested = opts.forceRefresh === true;
  // 当 opts.forceReauthorize 显式为 true 时，跳过节流检查，
  // 确保来自上游 401/406 等认证错误的修复请求不会被初始化阶段的调用吞掉。
  // Explicit user-triggered OAuth (openBrowser=true) must also bypass throttle,
  // otherwise repeated "Authorize" clicks in WebUI can become a silent no-op.
  if (!opts.forceReauthorize && !openBrowserRequested && !forceRefreshRequested && shouldThrottle(cacheKey)) {
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
    const endpoints = (() => {
      const overridden: OAuthEndpoints = { ...(defaults.endpoints || {}) };
      if (typeof auth.tokenUrl === 'string' && auth.tokenUrl.trim()) {
        overridden.tokenUrl = auth.tokenUrl.trim();
      }
      if (typeof auth.deviceCodeUrl === 'string' && auth.deviceCodeUrl.trim()) {
        overridden.deviceCodeUrl = auth.deviceCodeUrl.trim();
      }
      if (typeof auth.authorizationUrl === 'string' && auth.authorizationUrl.trim()) {
        overridden.authorizationUrl = auth.authorizationUrl.trim();
      }
      if (typeof auth.userInfoUrl === 'string' && auth.userInfoUrl.trim()) {
        overridden.userInfoUrl = auth.userInfoUrl.trim();
      }
      return overridden;
    })();
    const client = await (async () => {
      const base: OAuthClientConfig = { ...(defaults.client || {}) };
      if (typeof auth.clientId === 'string' && auth.clientId.trim()) {
        base.clientId = auth.clientId.trim();
      }
      if (typeof auth.clientSecret === 'string' && auth.clientSecret.trim()) {
        base.clientSecret = auth.clientSecret.trim();
      }
      if (Array.isArray(auth.scopes) && auth.scopes.length > 0) {
        base.scopes = [...auth.scopes];
      }
      if (typeof auth.redirectUri === 'string' && auth.redirectUri.trim()) {
        base.redirectUri = auth.redirectUri.trim();
      }
      return base;
    })();
    const headers = { ...(defaults.headers || {}) };
    const tokenPortal = (() => {
      if (!openBrowser) {
        return undefined;
      }
      const configured = String(process.env.ROUTECODEX_TOKEN_PORTAL_BASE || '').trim();
      const baseUrl = configured || (() => {
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
      })();
      if (!baseUrl) {
        return undefined;
      }
      const rawTokenFile = tokenFilePath ? path.basename(tokenFilePath) : '';
      const alias = (() => {
        if (rawTokenFile && !rawTokenFile.includes('/') && !rawTokenFile.includes('\\') && !rawTokenFile.endsWith('.json')) {
          return rawTokenFile;
        }
        const base = rawTokenFile ? path.basename(rawTokenFile) : '';
        const pt = String(providerType || '').trim().toLowerCase();
        if (base && pt) {
          const re = new RegExp(`^${pt}-oauth-\\d+(?:-(.+))?\\.json$`, 'i');
          const match = base.match(re);
          const candidate = match && match[1] ? String(match[1]).trim() : '';
          if (candidate) {
            return candidate;
          }
        }
        return 'default';
      })();
      return { baseUrl, provider: providerType, alias, tokenFile: tokenFilePath } as NonNullable<OAuthFlowConfig['tokenPortal']>;
    })();
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
    logOAuthSetup(providerType, defaults, overrides, endpoints, client, tokenFilePath, openBrowser, forceReauth);
    const strategy = createStrategy(providerType, overrides, tokenFilePath);
    let token = await readTokenFromFile(tokenFilePath);
    const hadExistingTokenFile = token !== null;

    logTokenSnapshot(providerType, token, endpoints);
    const tokenState = evaluateTokenState(token, providerType);
    const noRefresh = shouldHonorNoRefresh(providerType, token);
    const refreshToken = resolveRefreshTokenForProvider(providerType, token);

    if (noRefresh && !forceReauth && !openBrowserRequested && !forceRefreshRequested) {
      logOAuthDebug(
        `[OAuth] norefresh flag set for provider=${providerType} tokenFile=${tokenFilePath} - skip auto-refresh and re-authorization.`
      );
      updateThrottle(cacheKey);
      return;
    }

    if (!forceReauth && !forceRefreshRequested && tokenState.validAccess) {
      logOAuthDebug(
        `[OAuth] Using existing token (${tokenState.hasApiKey ? 'apiKey' : 'access_token'} valid). No authorization required.`
      );
      updateThrottle(cacheKey);
      return;
    }

    if (
      !forceReauth &&
      (forceRefreshRequested || tokenState.isExpiredOrNear) &&
      refreshToken &&
      typeof strategy.refreshToken === 'function'
    ) {
      try {
        logOAuthDebug(
          forceRefreshRequested
            ? '[OAuth] refreshing token (forced by upstream invalid-token repair)...'
            : '[OAuth] refreshing token...'
        );
        const refreshed = await strategy.refreshToken(refreshToken);
        await finalizeTokenWrite(providerType, strategy, tokenFilePath, refreshed, 'refreshed and saved');
        updateThrottle(cacheKey);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || '');
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
  let tokenFilePath: string | undefined;

  const attemptSilentRefreshOnly = async (
    lowerMessage: string
  ): Promise<boolean> => {

    try {
      await withOAuthRepairEnv(providerType, async () => {
        await ensureValid(providerType, auth, {
          forceReacquireIfRefreshFails: false,
          openBrowser: false,
          forceReauthorize: false,
          forceRefresh: false
        });
      });
      return true;
    } catch (error) {
      const refreshMsg = error instanceof Error ? error.message : String(error);
      logOAuthDebug(`[OAuth] upstream invalid token refresh failed (${providerType}): ${refreshMsg}`);
      return false;
    }
  };
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
    tokenFilePath = resolveTokenFilePath(auth as ExtendedOAuthAuth, providerType);
    const repairReason =
      statusCode === 403 && isGoogleAccountVerificationRequiredMessage(lower) ? 'google_verify' : 'generic';

    // Non-blocking server semantics:
    // - Try silent refresh first (fast path).
    // - If refresh fails or interactive is required (e.g. 403 verify), kick off interactive flow in background.
    // - Return false so Virtual Router can failover immediately.
    if (!allowBlocking) {
      if (statusCode === 403 && repairReason === 'google_verify') {
        const url = extractGoogleAccountVerificationUrl(msg);
        if (url) {
          void openGoogleAccountVerificationInCamoufox({
            providerType,
            auth: auth as ExtendedOAuthAuth,
            url
          }).catch((error) => {
            logOAuthDebug(
              `[OAuth] failed to open Google account verification in Camoufox (provider=${providerType}) - ${error instanceof Error ? error.message : String(error)}`
            );
          });
        }
        return false;
      }
      try {
        await withOAuthRepairEnv(providerType, async () => {
          await ensureValid(providerType, auth, {
            forceReacquireIfRefreshFails: false,
            openBrowser: false,
            forceReauthorize: false,
            forceRefresh: false
          });
        });
        return true;
      } catch (error) {
        const refreshMsg = error instanceof Error ? error.message : String(error);
        logOAuthDebug(
          `[OAuth] silent refresh failed; falling back to background interactive repair (provider=${providerType}) - ${refreshMsg}`
        );
      }
      const interactiveOpts: EnsureOpts = {
        forceReacquireIfRefreshFails: true,
        openBrowser: true,
        forceReauthorize: false
      };
      void withOAuthRepairEnv(providerType, async () => {
        await runInteractiveRepairWithAutoFallback({
          providerType,
          auth,
          ensureValid,
          opts: interactiveOpts
        });
      }).catch((error) => {
        logOAuthDebug(
          `[OAuth] background interactive repair failed (provider=${providerType}) - ${error instanceof Error ? error.message : String(error)}`
        );
      });
      return false;
    }

    const opts: EnsureOpts = {
      forceReacquireIfRefreshFails: true,
      openBrowser: true,
      forceReauthorize: false
    };
    await withOAuthRepairEnv(providerType, async () => {
      await runInteractiveRepairWithAutoFallback({
        providerType,
        auth,
        ensureValid,
        opts
      });
    });
    return true;
  } catch (error) {
    logOAuthLifecycleNonBlocking('interactiveRepairFlow', error, {
      providerType,
      tokenFilePath
    });
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
  return looksInvalid;
}

export const __oauthLifecycleTestables = {
  isProcessAlive
};
