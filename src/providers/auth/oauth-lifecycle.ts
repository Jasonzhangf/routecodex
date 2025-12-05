import type { OAuthAuth } from '../core/api/provider-config.js';
import { createProviderOAuthStrategy, getProviderOAuthConfig } from '../core/config/provider-oauth-configs.js';
import { OAuthFlowType, type OAuthFlowConfig, type OAuthClientConfig, type OAuthEndpoints } from '../core/config/oauth-flows.js';
import fs from 'fs/promises';
import path from 'path';
import type { UnknownObject } from '../../modules/pipeline/types/common-types.js';
import { fetchIFlowUserInfo, mergeIFlowTokenData } from './iflow-userinfo-helper.js';
import { fetchQwenUserInfo, mergeQwenTokenData, hasQwenApiKey } from './qwen-userinfo-helper.js';

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
};

const TOKEN_REFRESH_SKEW_MS = 60_000;

const inFlight: Map<string, Promise<void>> = new Map();
const lastRunAt: Map<string, number> = new Map();

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
  return path.join(home, '.routecodex', 'tokens', `${providerType}-default.json`);
}

function resolveTokenFilePath(auth: ExtendedOAuthAuth, providerType: string): string {
  const tf = typeof auth.tokenFile === 'string' ? auth.tokenFile.trim() : '';
  const resolved = tf ? expandHome(tf) : defaultTokenFile(providerType);
  if (!tf) {
    auth.tokenFile = resolved;
  }
  return resolved;
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

function evaluateTokenState(token: StoredOAuthToken | null, providerType: string) {
  const hasApiKey = hasApiKeyField(token);
  const hasAccess = hasAccessToken(token);
  const expiresAt = getExpiresAt(token);
  const isExpiredOrNear = expiresAt !== null && Date.now() >= (expiresAt - TOKEN_REFRESH_SKEW_MS);
  let validAccess: boolean;
  if (providerType.toLowerCase() === 'iflow') {
    validAccess = hasApiKey || (!isExpiredOrNear && hasAccess);
  } else if (providerType.toLowerCase() === 'qwen') {
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
    console.log(`[OAuth] token.read: provider=${providerType} exists=${Boolean(token)} hasApiKey=${hasApiKey} hasAccess=${hasAccess} expRaw=${String(expRaw)}`);
    if (providerType === 'iflow') {
      console.log(`[OAuth] iflow endpoints: deviceCodeUrl=${String(endpoints.deviceCodeUrl)} tokenUrl=${String(endpoints.tokenUrl)}`);
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
  const overrides: Record<string, unknown> = {
    activationType: openBrowser ? 'auto_browser' : 'manual',
    endpoints,
    client,
    tokenFile: tokenFilePath,
    headers
  };
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
  console.log(`[OAuth] Token ${reason} saved: ${tokenFilePath}`);
}

async function maybeEnrichToken(providerType: string, tokenData: UnknownObject): Promise<UnknownObject> {
  if (providerType === 'iflow') {
    const accessToken = extractAccessToken(sanitizeToken(tokenData) ?? null);
    if (!accessToken) {
      console.warn('[OAuth] iFlow: no access_token found in auth result, skipping API Key fetch');
      return tokenData;
    }
    try {
      const userInfo = await fetchIFlowUserInfo(accessToken);
      console.log(`[OAuth] iFlow: successfully fetched API Key for ${userInfo.email}`);
      return mergeIFlowTokenData(tokenData, userInfo) as unknown as UnknownObject;
    } catch (error) {
      console.error(`[OAuth] iFlow: failed to fetch API Key - ${error instanceof Error ? error.message : String(error)}`);
      return tokenData;
    }
  }
  if (providerType === 'qwen' && !hasQwenApiKey(tokenData)) {
    const accessToken = extractAccessToken(sanitizeToken(tokenData) ?? null);
    if (!accessToken) {
      console.warn('[OAuth] Qwen: no access_token found in auth result, skipping API Key fetch');
      return tokenData;
    }
    try {
      const userInfo = await fetchQwenUserInfo(accessToken);
      if (userInfo.apiKey) {
        console.log('[OAuth] Qwen: fetched API Key via user info');
        return mergeQwenTokenData(tokenData, userInfo) as unknown as UnknownObject;
      }
    } catch (error) {
      console.error(`[OAuth] Qwen: failed to fetch API Key - ${error instanceof Error ? error.message : String(error)}`);
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
    console.log(
      `[OAuth] ensureValid: provider=${providerType} flow=${String(defaults.flowType)} activation=${String(
        overrides.activationType
      )} tokenFile=${tokenFilePath} openBrowser=${openBrowser} forceReauth=${forceReauth}`
    );
    if (endpoints.deviceCodeUrl || endpoints.authorizationUrl) {
      console.log(
        `[OAuth] endpoints: deviceCodeUrl=${String(endpoints.deviceCodeUrl || '')} tokenUrl=${String(
          endpoints.tokenUrl
        )} authUrl=${String(endpoints.authorizationUrl || '')} userInfoUrl=${String(endpoints.userInfoUrl || '')}`
      );
    }
    if (providerType === 'iflow') {
      console.log(
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
    console.warn(
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

  const openBrowser = opts.openBrowser ?? String(process.env.ROUTECODEX_OAUTH_AUTO_OPEN || '1') === '1';
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
    const token = await readTokenFromFile(tokenFilePath);
    logTokenSnapshot(providerType, token, endpoints);
    const tokenState = evaluateTokenState(token, providerType);

    if (!forceReauth && tokenState.validAccess) {
      console.log(
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
        console.log('[OAuth] refreshing token...');
        const refreshed = await strategy.refreshToken(token.refresh_token);
        await finalizeTokenWrite(providerType, strategy, tokenFilePath, refreshed, 'refreshed and saved');
        updateThrottle(cacheKey);
        return;
      } catch (error) {
        if (!opts.forceReacquireIfRefreshFails) {
          throw error;
        }
        console.log('[OAuth] refresh failed, attempting interactive authorization...');
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
  try {
    const msg = upstreamError instanceof Error ? upstreamError.message : String(upstreamError || '');
    const looksInvalid = /401|403|invalid[_-]?token|expired|40308/i.test(msg);
    if (!looksInvalid) {
      return false;
    }
    await ensureValidOAuthToken(providerType, auth, { forceReacquireIfRefreshFails: true });
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
