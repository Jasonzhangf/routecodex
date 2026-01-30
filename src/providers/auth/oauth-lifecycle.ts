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
import type { UnknownObject } from '../../modules/pipeline/types/common-types.js';
import { fetchIFlowUserInfo, mergeIFlowTokenData } from './iflow-userinfo-helper.js';
import {} from './qwen-userinfo-helper.js';
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

type EnsureOpts = {
  forceReacquireIfRefreshFails?: boolean;
  openBrowser?: boolean;
  forceReauthorize?: boolean;
};

type ExtendedOAuthAuth = OAuthAuth & {
  tokenFile?: string;
  authorizationUrl?: string;
  userInfoUrl?: string;
  redirectUri?: string;
};

type OAuthStrategy = {
  refreshToken?(refreshToken: string): Promise<UnknownObject>;
  authenticate?(options?: { openBrowser?: boolean; forceReauthorize?: boolean }): Promise<UnknownObject | void>;
  saveToken?(token: UnknownObject | null): Promise<void>;
};

type StoredOAuthToken = UnknownObject & {
  access_token?: string;
  AccessToken?: string;
  refresh_token?: string;
  api_key?: string;
  apiKey?: string;
  expires_at?: number | string;
  expired?: number | string;
  expiry_date?: number | string;
  // 可选：标记该 token 仅供读取，不做自动刷新或重新授权
  norefresh?: boolean;
};

const TOKEN_REFRESH_SKEW_MS = 60_000;

const inFlight: Map<string, Promise<void>> = new Map();
const lastRunAt: Map<string, number> = new Map();
let interactiveTail: Promise<void> = Promise.resolve();
const GEMINI_CLI_PROVIDER_IDS = new Set(['gemini-cli', 'antigravity']);

function isGeminiCliFamily(providerType: string): boolean {
  return GEMINI_CLI_PROVIDER_IDS.has(providerType.toLowerCase());
}

function keyFor(providerType: string, tokenFile?: string): string {
  return `${providerType}::${tokenFile || ''}`;
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? p.replace(/^~\//, `${process.env.HOME || ''}/`) : p;
}

function defaultTokenFile(providerType: string): string {
  const home = process.env.HOME || '';
  if (providerType === 'iflow') {
    return path.join(home, '.iflow', 'oauth_creds.json');
  }
  if (providerType === 'qwen') {
    return path.join(home, '.routecodex', 'auth', 'qwen-oauth.json');
  }
  if (isGeminiCliFamily(providerType)) {
    const file = providerType.toLowerCase() === 'antigravity'
      ? 'antigravity-oauth.json'
      : 'gemini-oauth.json';
    return path.join(home, '.routecodex', 'auth', file);
  }
  return path.join(home, '.routecodex', 'tokens', `${providerType}-default.json`);
}

function resolveTokenFilePath(auth: ExtendedOAuthAuth, providerType: string): string {
  const raw = typeof auth.tokenFile === 'string' ? auth.tokenFile.trim() : '';

  // 没有任何配置：使用 provider 默认 token 文件（兼容单 token 场景）
  if (!raw) {
    const fallback = defaultTokenFile(providerType);
    auth.tokenFile = fallback;
    return fallback;
  }

  // 显式路径（包含路径分隔符或 .json），直接扩展 ~ 并返回
  if (raw.includes('/') || raw.includes('\\') || raw.endsWith('.json')) {
    const resolved = expandHome(raw);
    auth.tokenFile = resolved;
    return resolved;
  }

  // 纯 alias：在 ~/.routecodex/auth 下按 <provider>-oauth-*-<alias>.json 规则匹配（同步版本）
  const alias = raw;
  const homeDir = process.env.HOME || os.homedir();
  const authDir = path.join(homeDir, '.routecodex', 'auth');
  const pattern = new RegExp(`^${providerType}-oauth-(\\d+)(?:-(.+))?\\.json$`, 'i');

  let existingPath: string | null = null;
  let maxSeq = 0;
  try {
    const entries = fsSync.readdirSync(authDir);
    for (const entry of entries) {
      const match = entry.match(pattern);
      if (!match) {
        continue;
      }
      const seq = parseInt(match[1], 10);
      if (!Number.isFinite(seq) || seq <= 0) {
        continue;
      }
      const entryAlias = (match[2] || 'default');
      if (entryAlias === alias && !existingPath) {
        existingPath = path.join(authDir, entry);
      }
      if (seq > maxSeq) {
        maxSeq = seq;
      }
    }
  } catch {
    // ignore directory errors; treat as no existing tokens
  }

  if (existingPath) {
    auth.tokenFile = existingPath;
    return existingPath;
  }

  const nextSeq = maxSeq + 1;
  const fileName = `${providerType}-oauth-${nextSeq}-${alias}.json`;
  const fullPath = path.join(authDir, fileName);
  auth.tokenFile = fullPath;
  return fullPath;
}

function shouldThrottle(k: string, ms = 60_000): boolean {
  const t = lastRunAt.get(k) || 0;
  return Date.now() - t < ms;
}

function updateThrottle(k: string): void {
  lastRunAt.set(k, Date.now());
}

function isOAuthConfig(auth: OAuthAuth): auth is ExtendedOAuthAuth {
  return Boolean(auth && typeof auth.type === 'string' && auth.type.toLowerCase().includes('oauth'));
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeGeminiCliAccountToken(token: UnknownObject): StoredOAuthToken | null {
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

function sanitizeToken(token: UnknownObject | null): StoredOAuthToken | null {
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

async function readTokenFromFile(file: string): Promise<StoredOAuthToken | null> {
  try {
    const txt = await fs.readFile(file, 'utf-8');
    return sanitizeToken(JSON.parse(txt) as UnknownObject);
  } catch {
    return null;
  }
}

async function backupTokenFile(file: string): Promise<string | null> {
  if (!file) {
    return null;
  }
  try {
    await fs.access(file);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  const backup = `${file}.${Date.now()}.bak`;
  try {
    await fs.copyFile(file, backup);
    logOAuthDebug(`[OAuth] token.backup: ${backup}`);
    return backup;
  } catch (error) {
    logOAuthDebug(
      `[OAuth] token.backup failed (${file}): ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

async function restoreTokenFileFromBackup(backupFile: string | null, target: string): Promise<void> {
  if (!backupFile) {
    return;
  }
  try {
    await fs.copyFile(backupFile, target);
    logOAuthDebug(`[OAuth] token.restore: ${target}`);
  } catch (error) {
    logOAuthDebug(
      `[OAuth] token.restore failed (${target}): ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    try {
      await fs.unlink(backupFile);
    } catch {
      // ignore cleanup failure
    }
  }
}

async function discardBackupFile(backupFile: string | null): Promise<void> {
  if (!backupFile) {
    return;
  }
  try {
    await fs.unlink(backupFile);
  } catch {
    // ignore
  }
}

function extractAccessToken(token: StoredOAuthToken | null): string | undefined {
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

function hasApiKeyField(token: StoredOAuthToken | null): boolean {
  if (!token) {
    return false;
  }
  const candidate = token.apiKey ?? token.api_key;
  return hasNonEmptyString(candidate);
}

function hasAccessToken(token: StoredOAuthToken | null): boolean {
  return hasNonEmptyString(token?.access_token) || hasNonEmptyString(token?.AccessToken);
}

function getExpiresAt(token: StoredOAuthToken | null): number | null {
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

function resolveProjectId(token: UnknownObject | null): string | undefined {
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

async function readRawTokenFile(file: string): Promise<UnknownObject | null> {
  if (!file) {
    return null;
  }
  try {
    const txt = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(txt) as UnknownObject;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function coerceExpiryTimestampSeconds(token: StoredOAuthToken | null): number | undefined {
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
  return tokenData;
}

function hasNoRefreshFlag(token: StoredOAuthToken | null): boolean {
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

function evaluateTokenState(token: StoredOAuthToken | null, providerType: string) {
  const hasApiKey = hasApiKeyField(token);
  const hasAccess = hasAccessToken(token);
  const expiresAt = getExpiresAt(token);
  const isExpiredOrNear = expiresAt !== null && Date.now() >= (expiresAt - TOKEN_REFRESH_SKEW_MS);
  let validAccess: boolean;
  const pt = providerType.toLowerCase();
  if (pt === 'iflow') {
    validAccess = hasApiKey || (!isExpiredOrNear && hasAccess);
  } else if (pt === 'qwen') {
    validAccess = (hasApiKey || hasAccess) && !isExpiredOrNear;
  } else {
    validAccess = (hasApiKey || hasAccess) && !isExpiredOrNear;
  }

  return { hasApiKey, hasAccess, expiresAt, isExpiredOrNear, validAccess };
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

  const envPort = Number(process.env.ROUTECODEX_PORT || process.env.RCC_PORT || NaN);
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
      console.error(`[OAuth] Antigravity: failed to fetch metadata - ${error instanceof Error ? error.message : String(error)}`);
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
  const queued = interactiveTail
    .catch(() => {
      // ignore previous rejection so queue continues
    })
    .then(async () => {
      logOAuthDebug(`[OAuth] interactive queue enter ${label}`);
      try {
        await execute();
      } finally {
        logOAuthDebug(`[OAuth] interactive queue leave ${label}`);
      }
    });
  interactiveTail = queued.then(
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
  const strategy = createStrategy(providerType, overrides, tokenFilePath);
  const authed = await strategy.authenticate?.({ openBrowser: true, forceReauthorize: forceReauth });
  await finalizeTokenWrite(
    providerType,
    strategy,
    tokenFilePath,
    authed,
    overrides.flowType ? `acquired (${String(overrides.flowType)})` : 'acquired'
  );
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
  // 当 opts.forceReauthorize 显式为 true 时，跳过节流检查，
  // 确保来自上游 401/406 等认证错误的修复请求不会被初始化阶段的调用吞掉。
  if (!opts.forceReauthorize && shouldThrottle(cacheKey)) {
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

  const envAutoOpen = String(process.env.ROUTECODEX_OAUTH_AUTO_OPEN || '1') === '1';
  const openBrowser = opts.openBrowser ?? envAutoOpen;
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
    const hadExistingTokenFile = token !== null;

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

    if (noRefresh) {
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
        if (!opts.forceReacquireIfRefreshFails) {
          throw error;
        }
        logOAuthDebug('[OAuth] refresh failed, attempting interactive authorization...');
      }
    }

    try {
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
  upstreamError: unknown
): Promise<boolean> {
  const pt = providerType.toLowerCase();
  try {
    const msg = upstreamError instanceof Error ? upstreamError.message : String(upstreamError || '');
    const lower = msg.toLowerCase();

    let statusCode: number | undefined;
    try {
      const anyErr = upstreamError as { statusCode?: unknown; status?: unknown } | null | undefined;
      if (anyErr) {
        if (typeof anyErr.statusCode === 'number') {
          statusCode = anyErr.statusCode;
        } else if (typeof anyErr.status === 'number') {
          statusCode = anyErr.status;
        }
      }
    } catch {
      // best-effort statusCode extraction
    }

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
    }

    if (!looksInvalid) {
      return false;
    }
    const opts: EnsureOpts = {
      forceReacquireIfRefreshFails: true,
      openBrowser: true,
      // 上游已经明确返回“认证失效”（包括 iflow 的 406/439），
      // 此时强制跳过节流并允许走完整 OAuth 流程。
      forceReauthorize: pt === 'gemini' || pt === 'gemini-cli' || pt === 'antigravity' || pt === 'iflow' || pt === 'qwen'
    };
    await ensureValidOAuthToken(providerType, auth, opts);
    return true;
  } catch {
    return false;
  }
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
