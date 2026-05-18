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
import { fetchQwenUserInfo, mergeQwenTokenData, validateQwenAccessToken } from './qwen-userinfo-helper.js';
import { parseTokenSequenceFromPath } from './token-scanner/index.js';
import { logOAuthDebug } from './oauth-logger.js';
import { formatOAuthErrorMessage } from './oauth-error-message.js';
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
  hasStableQwenApiKey,
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
  clearTokenFile,
  readRawTokenFile
} from './oauth-lifecycle/token-io.js';
import { resolveRccAuthDir } from '../../config/user-data-paths.js';
import { isPermanentOAuthRefreshErrorMessage } from '../core/strategies/oauth-refresh-errors.js';

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
  buildEndpointOverrides,
  buildClientOverrides,
  buildHeaderOverrides,
  resolveTokenPortalBaseUrl,
  buildTokenPortalConfig,
  buildOverrides,
} from './oauth-lifecycle/token-overrides-builder.js';
import { resolveTokenAliasFromPath } from './oauth-lifecycle/path-resolver.js';
import {
  prepareTokenForStorage,
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

async function maybeMarkTokenFileNoRefresh(filePath: string): Promise<void> {
  if (!filePath) {
    return;
  }
  try {
    const parsed = await readRawTokenFile(filePath);
    if (!parsed || typeof parsed !== 'object') {
      return;
    }
    const token = sanitizeToken(parsed);
    const providerType = inferProviderTypeFromTokenFilePath(token, filePath);
    if (providerType === 'qwen' && !hasStableQwenApiKey(token)) {
      return;
    }
    const current =
      (parsed as UnknownObject).norefresh ??
      (parsed as UnknownObject).noRefresh;
    if (
      current === true ||
      current === 'true' ||
      current === '1' ||
      current === 'yes'
    ) {
      return;
    }
    const next = {
      ...(parsed as Record<string, unknown>),
      norefresh: true,
      noRefresh: true
    };
    await fs.writeFile(filePath, JSON.stringify(next, null, 2) + '\n', {
      mode: 0o600
    });
  } catch (error) {
    logOAuthLifecycleNonBlocking('maybeMarkTokenFileNoRefresh', error, { filePath });
  }
}

async function hasTokenFileNoRefresh(filePath: string): Promise<boolean> {
  if (!filePath) {
    return false;
  }
  const parsed = await readRawTokenFile(filePath);
  const token = sanitizeToken(parsed);
  const providerType = inferProviderTypeFromTokenFilePath(token, filePath);
  const direct =
    (parsed as UnknownObject | null)?.norefresh ??
    (parsed as UnknownObject | null)?.noRefresh;
  const flagged =
    typeof direct === 'boolean'
      ? direct
      : typeof direct === 'string'
        ? ['1', 'true', 'yes'].includes(direct.trim().toLowerCase())
        : false;
  if (!flagged) {
    return false;
  }
  if (providerType === 'qwen') {
    return hasStableQwenApiKey(token);
  }
  return true;
}

function shouldHonorNoRefresh(providerType: string, token: StoredOAuthToken | null): boolean {
  if (!hasNoRefreshFlag(token)) {
    return false;
  }
  return providerType.trim().toLowerCase() === 'qwen' ? hasStableQwenApiKey(token) : true;
}

function inferProviderTypeFromTokenFilePath(
  token: StoredOAuthToken | null,
  tokenFilePath: string
): string {
  const fromToken =
    token && typeof (token as UnknownObject).type === 'string'
      ? String((token as UnknownObject).type).trim().toLowerCase()
      : '';
  if (fromToken) {
    return fromToken;
  }
  const base = path.basename(String(tokenFilePath || '').trim()).toLowerCase();
  if (base.startsWith('qwen-')) {
    return 'qwen';
  }
  if (base.startsWith('gemini-')) {
    return 'gemini';
  }
  return '';
}

function isQwenDefaultAliasTokenFile(providerType: string, tokenFilePath: string): boolean {
  if (providerType.trim().toLowerCase() !== 'qwen') {
    return false;
  }
  const alias = resolveTokenAliasFromPath(tokenFilePath) ?? 'default';
  return alias.trim().toLowerCase() === 'default';
}

function resolveOfficialQwenCodeTokenFile(): string {
  const homeDir = String(process.env.HOME || '').trim() || os.homedir();
  return path.join(homeDir, '.qwen', 'oauth_creds.json');
}

function extractRefreshTokenString(token: StoredOAuthToken | null): string {
  const value = token?.refresh_token;
  return typeof value === 'string' ? value.trim() : '';
}

async function maybeAdoptOfficialQwenCodeToken(args: {
  providerType: string;
  tokenFilePath: string;
  currentToken: StoredOAuthToken | null;
  strategy: OAuthStrategy;
  force?: boolean;
}): Promise<StoredOAuthToken | null> {
  if (!isQwenDefaultAliasTokenFile(args.providerType, args.tokenFilePath)) {
    return null;
  }

  const officialTokenFile = resolveOfficialQwenCodeTokenFile();
  if (!officialTokenFile || officialTokenFile === args.tokenFilePath) {
    return null;
  }

  const officialRaw = await readRawTokenFile(officialTokenFile);
  const officialToken = sanitizeToken(officialRaw);
  if (!officialToken) {
    return null;
  }

  const officialAccessToken = extractAccessToken(officialToken);
  const officialRefreshToken = extractRefreshTokenString(officialToken);
  if (!officialAccessToken && !officialRefreshToken) {
    return null;
  }

  const currentAccessToken = extractAccessToken(args.currentToken);
  const currentRefreshToken = extractRefreshTokenString(args.currentToken);
  if (
    currentAccessToken === officialAccessToken &&
    currentRefreshToken === officialRefreshToken
  ) {
    return args.currentToken ?? officialToken;
  }

  if (!args.force && args.currentToken) {
    return null;
  }

  const prepared = await prepareTokenForStorage(
    args.providerType,
    args.tokenFilePath,
    (officialRaw as UnknownObject | null) ?? (officialToken as UnknownObject)
  );

  if (typeof args.strategy.saveToken === 'function') {
    await args.strategy.saveToken(prepared);
  } else {
    await fs.writeFile(args.tokenFilePath, JSON.stringify(prepared, null, 2) + '\n', {
      mode: 0o600
    });
  }

  logOAuthDebug(
    `[OAuth] Qwen default: adopted official qwen code token ${officialTokenFile} -> ${args.tokenFilePath}`
  );
  return sanitizeToken(prepared) ?? officialToken;
}




function applyRefreshFailureBackoff(_cacheKey: string, _providerType: string, _message: string): void {
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

function isAutoOAuthDisabledProvider(providerType: string): boolean {
  const normalized = String(providerType || '').trim().toLowerCase();
  return normalized.length > 0 && false;
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
    if (isAutoOAuthDisabledProvider(normalizedProviderType)) {
      console.warn(
        `[OAuth] Camoufox auto OAuth failed (${providerType}, autoMode=${autoModeAtStart}): ${msg}. Auto OAuth is disabled for this provider; manual re-auth is required.`
      );
      throw error;
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

/**
 * Qwen: api_key 可能被降级为 access_token（userInfo 404 时的兼容写法），这种情况不应被视为"稳定 API Key"。
 * 只有当 api_key 存在且与 access_token 不同（或缺失 access_token）时，才认为可以长期复用并跳过刷新。
 */
async function finalizeTokenWrite(
  providerType: string,
  strategy: OAuthStrategy,
  tokenFilePath: string,
  tokenData: UnknownObject | void,
  reason: string,
  options?: {
    strictQwenValidation?: boolean;
  }
): Promise<void> {
  if (!tokenData || typeof strategy.saveToken !== 'function') {
    return;
  }
  const enriched = await maybeEnrichToken(providerType, tokenData, tokenFilePath, options);
  const prepared = await prepareTokenForStorage(providerType, tokenFilePath, enriched);
  await strategy.saveToken(prepared);
  logOAuthDebug(`[OAuth] Token ${reason} saved: ${tokenFilePath}`);
}

async function maybeEnrichToken(
  providerType: string,
  tokenData: UnknownObject,
  tokenFilePath?: string,
  options?: {
    strictQwenValidation?: boolean;
  }
): Promise<UnknownObject> {
  if (providerType === 'qwen') {
    const sanitized = sanitizeToken(tokenData) ?? (tokenData as StoredOAuthToken);
    const tokenRecord = tokenData as Record<string, unknown>;
    if (hasStableQwenApiKey(sanitized)) {
      return tokenData;
    }
    const accessToken = extractAccessToken(sanitized);
    if (!accessToken) {
      logOAuthDebug('[OAuth] Qwen: no access_token found in auth result, skipping API Key fetch');
      return tokenData;
    }
    if (options?.strictQwenValidation) {
      try {
        const resourceUrl =
          typeof sanitized.resource_url === 'string' && sanitized.resource_url.trim()
            ? sanitized.resource_url.trim()
            : typeof tokenRecord.resource_url === 'string' && tokenRecord.resource_url.trim()
              ? tokenRecord.resource_url.trim()
              : typeof tokenRecord.resourceUrl === 'string' && tokenRecord.resourceUrl.trim()
                ? tokenRecord.resourceUrl.trim()
                : undefined;
        const model =
          typeof tokenRecord.model === 'string' && tokenRecord.model.trim()
            ? tokenRecord.model.trim()
            : undefined;
        await validateQwenAccessToken({
          accessToken,
          resourceUrl,
          model
        });
      } catch (error) {
        const msg = formatOAuthErrorMessage(error);
        throw new Error(`[OAuth] Qwen token validation failed after refresh/acquire: ${msg}`);
      }
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
      logOAuthLifecycleNonBlocking(
        'maybeEnrichToken.qwenUserInfo',
        error,
        { tokenFilePath, fallback: 'keep_token_data' }
      );
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
      await finalizeTokenWrite(providerType, strategy, tokenFilePath, authed, 'acquired', {
        strictQwenValidation: providerType === 'qwen'
      });
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
    if (!token) {
      token = await maybeAdoptOfficialQwenCodeToken({
        providerType,
        tokenFilePath,
        currentToken: null,
        strategy
      });
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
    logTokenSnapshot(providerType, token, endpoints);
    const tokenState = evaluateTokenState(token, providerType);
    const noRefresh = shouldHonorNoRefresh(providerType, token);

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
      token?.refresh_token &&
      typeof strategy.refreshToken === 'function'
    ) {
      try {
        logOAuthDebug(
          forceRefreshRequested
            ? '[OAuth] refreshing token (forced by upstream invalid-token repair)...'
            : '[OAuth] refreshing token...'
        );
        const refreshed = await strategy.refreshToken(token.refresh_token);
        await finalizeTokenWrite(providerType, strategy, tokenFilePath, refreshed, 'refreshed and saved', {
          strictQwenValidation: providerType === 'qwen'
        });
        updateThrottle(cacheKey);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || '');
        if (
          providerType === 'qwen' &&
          isPermanentOAuthRefreshErrorMessage(message)
        ) {
          try {
            const adopted = await maybeAdoptOfficialQwenCodeToken({
              providerType,
              tokenFilePath,
              currentToken: token,
              strategy,
              force: true
            });
            const adoptedRefreshToken = extractRefreshTokenString(adopted);
            if (adoptedRefreshToken && adoptedRefreshToken !== extractRefreshTokenString(token)) {
              logOAuthDebug('[OAuth] Qwen default: refresh failed, retrying with official qwen code token');
              const refreshed = await strategy.refreshToken(adoptedRefreshToken);
              await finalizeTokenWrite(
                providerType,
                strategy,
                tokenFilePath,
                refreshed,
                'repaired from official qwen code token and saved',
                {
                  strictQwenValidation: true
                }
              );
              updateThrottle(cacheKey);
              return;
            }
          } catch (repairError) {
            logOAuthLifecycleNonBlocking(
              'qwen_default_official_token_repair',
              repairError,
              { tokenFilePath }
            );
          }
        }
        applyRefreshFailureBackoff(cacheKey, providerType, message);
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
  const autoOAuthDisabled = isAutoOAuthDisabledProvider(providerType);

  const attemptSilentRefreshOnly = async (
    lowerMessage: string
  ): Promise<boolean> => {

    try {
      await withOAuthRepairEnv(providerType, async () => {
        await ensureValid(providerType, auth, {
          forceReacquireIfRefreshFails: false,
          openBrowser: false,
          forceReauthorize: false,
          forceRefresh: pt === 'qwen'
        });
      });
      if (tokenFilePath) {
        await markInteractiveOAuthRepairSuccess({
          providerType,
          tokenFile: tokenFilePath
        });
      }
      return true;
    } catch (error) {
      const refreshMsg = error instanceof Error ? error.message : String(error);
      if (pt === 'qwen' && isPermanentOAuthRefreshErrorMessage(refreshMsg)) {
        await maybeMarkTokenFileNoRefresh(tokenFilePath || '');
        logOAuthLifecycleNonBlocking(
          'handleUpstreamInvalidOAuthToken.qwenPermanentRefreshFailure',
          new Error('qwen silent refresh permanently failed; standard re-auth required'),
          { providerType, tokenFilePath, reason: refreshMsg },
          { warn: true, throttleKey: `qwen-permanent-refresh:${tokenFilePath || 'unknown'}` }
        );
        return false;
      }
      if (pt === 'qwen') {
        logOAuthLifecycleNonBlocking(
          'handleUpstreamInvalidOAuthToken.qwenSilentRefreshFailure',
          new Error('qwen silent refresh failed; standard re-auth required'),
          { providerType, tokenFilePath, reason: refreshMsg },
          { warn: true, throttleKey: `qwen-silent-refresh:${tokenFilePath || 'unknown'}` }
        );
        return false;
      }
      logOAuthLifecycleNonBlocking(
        'handleUpstreamInvalidOAuthToken.autoOAuthDisabled',
        new Error('auto OAuth has been removed for this provider; manual re-auth required'),
        { providerType, tokenFilePath, reason: refreshMsg },
        { warn: true, throttleKey: `oauth-auto-disabled:${providerType}:${tokenFilePath || 'unknown'}` }
      );
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
    if (pt === 'qwen' && await hasTokenFileNoRefresh(tokenFilePath)) {
      logOAuthLifecycleNonBlocking(
        'handleUpstreamInvalidOAuthToken.qwenNoRefresh',
        new Error('qwen auto-refresh disabled; standard re-auth required'),
        { providerType, tokenFilePath },
        { warn: true, throttleKey: `qwen-norefresh:${tokenFilePath}` }
      );
      return false;
    }
    if (autoOAuthDisabled) {
      return await attemptSilentRefreshOnly(lower);
    }
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
            forceRefresh: pt === 'qwen'
          });
        });
        await markInteractiveOAuthRepairSuccess({
          providerType,
          tokenFile: tokenFilePath
        });
        return true;
      } catch (error) {
        const refreshMsg = error instanceof Error ? error.message : String(error);
        if (pt === 'qwen' && isPermanentOAuthRefreshErrorMessage(refreshMsg)) {
          await maybeMarkTokenFileNoRefresh(tokenFilePath);
          logOAuthLifecycleNonBlocking(
            'handleUpstreamInvalidOAuthToken.qwenPermanentRefreshFailure',
            new Error('qwen silent refresh permanently failed; standard re-auth required'),
            { providerType, tokenFilePath, reason: refreshMsg },
            { warn: true, throttleKey: `qwen-permanent-refresh:${tokenFilePath}` }
          );
          return false;
        }
        if (pt === 'qwen') {
          logOAuthLifecycleNonBlocking(
            'handleUpstreamInvalidOAuthToken.qwenSilentRefreshFailure',
            new Error('qwen silent refresh failed; standard re-auth required'),
            { providerType, tokenFilePath, reason: refreshMsg },
            { warn: true, throttleKey: `qwen-silent-refresh:${tokenFilePath}` }
          );
          return false;
        }
        logOAuthDebug(
          `[OAuth] silent refresh failed; falling back to background interactive repair (provider=${providerType}) - ${refreshMsg}`
        );
      }
      const interactiveOpts: EnsureOpts = {
        forceReacquireIfRefreshFails: true,
        openBrowser: true,
        // 此时强制跳过节流并允许走完整 OAuth 流程。
        forceReauthorize: pt === 'qwen'
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
      // 此时强制跳过节流并允许走完整 OAuth 流程。
      forceReauthorize: pt === 'qwen'
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
  if (pt === 'qwen' && statusCode === 403 && isGoogleAccountVerificationRequiredMessage(lower)) {
    looksInvalid = true;
  }

  return looksInvalid;
}

export const __oauthLifecycleTestables = {
  isProcessAlive
};
