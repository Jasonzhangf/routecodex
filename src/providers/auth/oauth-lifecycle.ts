import type { OAuthAuth } from '../core/api/provider-config.js';
import { createProviderOAuthStrategy, getProviderOAuthConfig } from '../core/config/provider-oauth-configs.js';
import { OAuthFlowType, type OAuthFlowConfig, type OAuthClientConfig, type OAuthEndpoints } from '../core/config/oauth-flows.js';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import type { UnknownObject } from '../../modules/pipeline/types/common-types.js';
import { fetchIFlowUserInfo, mergeIFlowTokenData } from './iflow-userinfo-helper.js';
import { fetchQwenUserInfo, mergeQwenTokenData, hasQwenApiKey } from './qwen-userinfo-helper.js';
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
  authenticate?(options?: { openBrowser?: boolean }): Promise<UnknownObject | void>;
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

function sanitizeToken(token: UnknownObject | null): StoredOAuthToken | null {
  if (!token || typeof token !== 'object') {
    return null;
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

function hasGeminiProjectMetadata(token: StoredOAuthToken | null): boolean {
  if (!token || typeof token !== 'object') {
    return false;
  }
  const obj = token as UnknownObject;
  const directProjectId = (obj as any).project_id;
  if (typeof directProjectId === 'string' && directProjectId.trim().length > 0) {
    return true;
  }
  const projects = (obj as any).projects;
  if (Array.isArray(projects) && projects.length > 0) {
    return true;
  }
  try {
    const inferred = getDefaultProjectId(obj);
    return typeof inferred === 'string' && inferred.trim().length > 0;
  } catch {
    return false;
  }
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

  // 对 gemini-cli / antigravity，缺少 project 元数据视为无效凭证，
  // 行为上等价于 gcli2api 要求凭证里必须有 project_id。
  if (isGeminiCliFamily(providerType) && validAccess) {
    if (!hasGeminiProjectMetadata(token)) {
      validAccess = false;
    }
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
  const enriched = await maybeEnrichToken(providerType, tokenData);
  await strategy.saveToken(enriched);
  logOAuthDebug(`[OAuth] Token ${reason} saved: ${tokenFilePath}`);
}

async function maybeEnrichToken(providerType: string, tokenData: UnknownObject): Promise<UnknownObject> {
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
      const projectId = await fetchAntigravityProjectId(accessToken);
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
  openBrowser: boolean
): Promise<void> {
  if (providerType === 'iflow') {
    await runIflowAuthorizationSequence(providerType, overrides, tokenFilePath);
    return;
  }
  const strategy = createStrategy(providerType, overrides, tokenFilePath);
  const authed = await strategy.authenticate?.({ openBrowser });
  await finalizeTokenWrite(providerType, strategy, tokenFilePath, authed, 'acquired');
}

async function runIflowAuthorizationSequence(
  providerType: string,
  overrides: Record<string, unknown>,
  tokenFilePath: string
): Promise<void> {
  const authCodeOverrides = { ...overrides, flowType: OAuthFlowType.AUTHORIZATION_CODE };
  try {
    await executeAuthFlow(providerType, authCodeOverrides, tokenFilePath);
    return;
  } catch (firstError) {
    logOAuthDebug(
      `[OAuth] auth_code flow failed: ${firstError instanceof Error ? firstError.message : String(firstError || '')}`
    );
  }
  const deviceOverrides = { ...overrides, flowType: OAuthFlowType.DEVICE_CODE };
  await executeAuthFlow(providerType, deviceOverrides, tokenFilePath);
}

async function executeAuthFlow(
  providerType: string,
  overrides: Record<string, unknown>,
  tokenFilePath: string
): Promise<void> {
  const strategy = createStrategy(providerType, overrides, tokenFilePath);
  const authed = await strategy.authenticate?.({ openBrowser: true });
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
  if (shouldThrottle(cacheKey)) {
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

  const openBrowser = opts.openBrowser ?? true;
  const forceReauth =
    opts.forceReauthorize === true || String(process.env.ROUTECODEX_OAUTH_FORCE_REAUTH || '0') === '1';

	  const runPromise = (async () => {
	    const defaults = getProviderOAuthConfig(providerType);
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

	    // Gemini CLI 家族：如果现有 token 缺少 project 元数据，尝试在不触发完整 OAuth 授权的前提下
	    // 使用当前 access_token 补全 UserInfo + Projects（对齐 gcli2api 的行为），并立即写回。
	    if (isGeminiCliFamily(providerType) && token) {
	      try {
	        const hasProjectMetadata = Boolean(getDefaultProjectId(token as UnknownObject));
	        if (!hasProjectMetadata) {
	          const enriched = await maybeEnrichToken(providerType, token as UnknownObject);
	          if (enriched && typeof strategy.saveToken === 'function') {
	            await strategy.saveToken(enriched);
	            token = enriched as StoredOAuthToken;
	          }
	        }
	      } catch (error) {
	        const msg = error instanceof Error ? error.message : String(error);
	        console.error(
	          `[OAuth] ${providerType}: failed to enrich existing token with project metadata - ${msg}`
	        );
	        // 若明确是 401 / invalid token 类错误，将 token 视为无效，后续强制走重新授权流程。
	        const lower = msg.toLowerCase();
	        if (
	          /invalid[_-]?token|invalid[_-]?grant|unauthenticated|unauthorized/.test(lower) ||
	          lower.includes('http 401')
	        ) {
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

    await runInteractiveAuthorizationFlow(providerType, overrides, tokenFilePath, openBrowser);
    updateThrottle(cacheKey);
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

    // 基本令牌失效判定：只看典型 OAuth 文案
    let looksInvalid =
      /invalid[_-]?token|invalid[_-]?grant|unauthenticated|unauthorized|token has expired|access token expired/.test(
        lower
      );

    // 对于 iflow / qwen，保留基于 401/403 的宽松判定，避免破坏既有行为
    if (!looksInvalid && (pt === 'iflow' || pt === 'qwen')) {
      if (/\b401\b|\b403\b|40308/.test(msg)) {
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
    const opts: EnsureOpts = { forceReacquireIfRefreshFails: true };
    // 对于 Gemini CLI 家族，一旦检测到 project_id 缺失类错误，强制发起交互式 OAuth 以拉起 Portal。
    if (pt === 'gemini' || pt === 'gemini-cli' || pt === 'antigravity') {
      opts.forceReauthorize = true;
    }
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
