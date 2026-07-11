/**
 * Independent Grok provider session auth (multi-token).
 *
 * - Provider id: `grok`
 * - Wire auth headers: Grok Build / cli-chat-proxy (Authorization + X-XAI-Token-Auth + x-grok-*)
 * - OAuth/login/refresh: aligned with opencode xAI plugin (public Grok-CLI client)
 * - Token store: `~/.rcc/provider/grok/auth/*.json` multi-token pool
 * - Multi-token: config entries or auto-scan authDir; default selectionMode = priority
 * - Refresh: OIDC refresh_token + JWT exp skew + single-flight
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ApiKeyAuth } from '../core/api/provider-config.js';
import type { AuthStatus, IAuthProvider } from './auth-interface.js';
import { AuthErrorType } from './auth-interface.js';

export const GROK_PROVIDER_ID = 'grok';
export const GROK_AUTH_RAW_TYPE = 'grok';
/** Wire header required by Grok Build / cli-chat-proxy session middleware. */
export const GROK_TOKEN_AUTH_HEADER_VALUE = 'xai-grok-cli';
export const DEFAULT_GROK_PROVIDER_ROOT = '~/.rcc/provider/grok';
export const DEFAULT_GROK_AUTH_DIR = '~/.rcc/provider/grok/auth';
export const DEFAULT_GROK_TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token';
export const DEFAULT_GROK_OIDC_ISSUER = 'https://auth.x.ai';
export const DEFAULT_GROK_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';

/** Public Grok-CLI OAuth client (same as opencode xAI plugin). */
export const GROK_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const GROK_OAUTH_AUTHORIZE_URL = 'https://auth.x.ai/oauth2/authorize';
export const GROK_OAUTH_TOKEN_URL = DEFAULT_GROK_TOKEN_ENDPOINT;
export const GROK_OAUTH_DEVICE_AUTHORIZATION_URL = 'https://auth.x.ai/oauth2/device/code';
export const GROK_OAUTH_DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
export const GROK_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
export const GROK_OAUTH_HOST = '127.0.0.1';
export const GROK_OAUTH_PORT = 56121;
export const GROK_OAUTH_REDIRECT_PATH = '/callback';
export const GROK_OAUTH_REDIRECT_URI = `http://${GROK_OAUTH_HOST}:${GROK_OAUTH_PORT}${GROK_OAUTH_REDIRECT_PATH}`;

/** opencode ACCESS_TOKEN_REFRESH_SKEW_MS: refresh a little before real expiry. */
const DEFAULT_EARLY_REFRESH_MS = 120_000;

export interface GrokTokenSlot {
  alias: string;
  authFile: string;
  disabled?: boolean;
  disabledUntil?: number;
}

export type GrokAuthConfig = ApiKeyAuth & {
  /** Provider root (default ~/.rcc/provider/grok). Used to resolve relative token paths. */
  providerRoot?: string;
  /** Auth directory (default ~/.rcc/provider/grok/auth). Auto-scanned when entries empty. */
  authDir?: string;
  authFile?: string;
  tokenFile?: string;
  entries?: Array<{
    alias?: string;
    tokenFile?: string;
    authFile?: string;
    apiKey?: string;
    env?: string;
    secretRef?: string;
    disabled?: boolean;
    disabledUntil?: number;
  }>;
  /** Default: priority (first enabled token preferred; rotate only on exhaust). */
  selectionMode?: 'round-robin' | 'priority';
  tokenUrl?: string;
  earlyRefreshMs?: number;
  clientSurface?: string;
  clientVersion?: string;
};

export interface GrokAuthEntry {
  key: string;
  refresh_token?: string;
  expires_at?: string;
  auth_mode?: string;
  oidc_issuer?: string;
  oidc_client_id?: string;
  user_id?: string;
  team_id?: string;
  email?: string;
  [field: string]: unknown;
}

export type GrokAuthFile = Record<string, GrokAuthEntry>;

export interface CapturedGrokSession {
  authFile: string;
  entryKey: string;
  email?: string;
  userId?: string;
  teamId?: string;
  clientId?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  accessTokenLength: number;
}

function expandHome(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed === '~') {
    return os.homedir();
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function resolvePath(raw: string, providerRoot: string): string {
  const expanded = expandHome(raw);
  if (!expanded) {
    return expanded;
  }
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  return path.resolve(providerRoot, expanded);
}

function parseExpiryMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.floor(value * 1000) : Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return asNumber < 1e12 ? Math.floor(asNumber * 1000) : Math.floor(asNumber);
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * Parse JWT exp without verifying signature (proactive refresh only; never trust decisions).
 * Mirrors opencode accessTokenIsExpiring.
 */
export function accessTokenIsExpiring(
  token: string | undefined,
  skewMs: number = DEFAULT_EARLY_REFRESH_MS,
  now = Date.now()
): boolean {
  if (!token || typeof token !== 'string') {
    return false;
  }
  const parts = token.split('.');
  if (parts.length < 2) {
    return false;
  }
  try {
    let payload = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    while (payload.length % 4 !== 0) {
      payload += '=';
    }
    const claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as { exp?: unknown };
    if (typeof claims?.exp !== 'number') {
      return false;
    }
    return claims.exp * 1000 <= now + Math.max(0, skewMs);
  } catch {
    return false;
  }
}

export interface GrokOAuthPkceCodes {
  verifier: string;
  challenge: string;
}

export interface GrokOAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

export interface GrokDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

function base64UrlEncode(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const binary = String.fromCharCode(...bytes);
  return Buffer.from(binary, 'binary').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function generateGrokOAuthPkce(): Promise<GrokOAuthPkceCodes> {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const random = crypto.getRandomValues(new Uint8Array(64));
  const verifier = Array.from(random).map((b) => chars[b % chars.length]!).join('');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(hash) };
}

export function buildGrokAuthorizeUrl(
  pkce: GrokOAuthPkceCodes,
  state: string,
  nonce: string,
  options?: { authorizeUrl?: string; referrer?: string }
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: GROK_OAUTH_CLIENT_ID,
    redirect_uri: GROK_OAUTH_REDIRECT_URI,
    scope: GROK_OAUTH_SCOPE,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state,
    nonce,
    plan: 'generic',
    referrer: options?.referrer || 'routecodex'
  });
  return `${options?.authorizeUrl || GROK_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeGrokOAuthCode(
  code: string,
  pkce: GrokOAuthPkceCodes,
  options?: { tokenUrl?: string }
): Promise<GrokOAuthTokenResponse> {
  const response = await fetch(options?.tokenUrl || GROK_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: GROK_OAUTH_REDIRECT_URI,
      client_id: GROK_OAUTH_CLIENT_ID,
      code_verifier: pkce.verifier
    }).toString()
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`grok oauth token exchange failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  return response.json() as Promise<GrokOAuthTokenResponse>;
}

export async function requestGrokDeviceCode(options?: {
  deviceAuthorizationUrl?: string;
}): Promise<GrokDeviceCodeResponse> {
  const response = await fetch(options?.deviceAuthorizationUrl || GROK_OAUTH_DEVICE_AUTHORIZATION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: new URLSearchParams({
      client_id: GROK_OAUTH_CLIENT_ID,
      scope: GROK_OAUTH_SCOPE
    }).toString()
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`grok device code request failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  const json = (await response.json()) as GrokDeviceCodeResponse;
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error('grok device code response missing device_code / user_code / verification_uri');
  }
  return json;
}

function positiveSecondsToMs(value: unknown, defaultMs: number): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : defaultMs;
}

export async function pollGrokDeviceCodeToken(
  device: GrokDeviceCodeResponse,
  options?: {
    tokenUrl?: string;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  }
): Promise<GrokOAuthTokenResponse> {
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options?.now ?? (() => Date.now());
  const expiresInMs = positiveSecondsToMs(device.expires_in, 5 * 60 * 1000);
  const deadline = now() + expiresInMs;
  let intervalMs = Math.max(positiveSecondsToMs(device.interval, 5_000), 1_000);

  while (now() < deadline) {
    const response = await fetch(options?.tokenUrl || GROK_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: new URLSearchParams({
        grant_type: GROK_OAUTH_DEVICE_CODE_GRANT_TYPE,
        client_id: GROK_OAUTH_CLIENT_ID,
        device_code: device.device_code
      }).toString()
    });
    if (response.ok) {
      return (await response.json()) as GrokOAuthTokenResponse;
    }
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      error_description?: string;
    };
    const remaining = Math.max(0, deadline - now());
    if (body.error === 'authorization_pending') {
      await sleep(Math.min(intervalMs + 3_000, remaining));
      continue;
    }
    if (body.error === 'slow_down') {
      intervalMs += 5_000;
      await sleep(Math.min(intervalMs + 3_000, remaining));
      continue;
    }
    if (body.error === 'access_denied' || body.error === 'authorization_denied') {
      throw new Error('grok device authorization was denied');
    }
    if (body.error === 'expired_token') {
      throw new Error('grok device code expired; re-run login');
    }
    const detail = body.error_description ?? body.error ?? '';
    throw new Error(`grok device token exchange failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  throw new Error('grok device authorization timed out');
}

/** Persist OAuth token response into multi-token auth file shape. */
export function writeGrokOAuthTokenFile(
  authFilePath: string,
  tokens: GrokOAuthTokenResponse,
  extras?: Partial<GrokAuthEntry>
): void {
  const access =
    (typeof tokens.access_token === 'string' && tokens.access_token.trim())
    || '';
  if (!access) {
    throw new Error('grok oauth response missing access_token');
  }
  const refresh =
    (typeof tokens.refresh_token === 'string' && tokens.refresh_token.trim())
    || (typeof extras?.refresh_token === 'string' ? extras.refresh_token : undefined);
  const expiresIn =
    typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in)
      ? Math.floor(tokens.expires_in)
      : 3600;
  const entryKey = `${DEFAULT_GROK_OIDC_ISSUER}::${GROK_OAUTH_CLIENT_ID}`;
  const entry: GrokAuthEntry = {
    ...(extras || {}),
    key: access,
    refresh_token: refresh,
    expires_at: new Date(Date.now() + Math.max(60, expiresIn) * 1000).toISOString(),
    auth_mode: 'oidc',
    oidc_issuer: DEFAULT_GROK_OIDC_ISSUER,
    oidc_client_id: GROK_OAUTH_CLIENT_ID
  };
  const resolved = expandHome(authFilePath);
  let file: GrokAuthFile = {};
  if (fs.existsSync(resolved)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        file = parsed as GrokAuthFile;
      }
    } catch {
      // overwrite unreadable file with fresh oauth entry
    }
  }
  file[entryKey] = {
    ...(file[entryKey] || {}),
    ...entry
  };
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const tmp = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, resolved);
  try {
    fs.chmodSync(resolved, 0o600);
  } catch {
    // best-effort
  }
}

function pickPreferredEntry(file: GrokAuthFile): { entryKey: string; entry: GrokAuthEntry } {
  const entries = Object.entries(file).filter(([, entry]) => entry && typeof entry === 'object');
  if (entries.length === 0) {
    throw new Error('grok auth file has no credential entries');
  }

  const ranked = entries
    .map(([entryKey, entry]) => {
      const access = typeof entry.key === 'string' ? entry.key.trim() : '';
      const hasAccess = access.length > 0;
      const isOidc = String(entry.auth_mode || '').toLowerCase() === 'oidc'
        || String(entry.oidc_issuer || '').includes('auth.x.ai')
        || entryKey.includes('auth.x.ai')
        || entryKey.includes('accounts.x.ai');
      const expiresAt = parseExpiryMs(entry.expires_at) ?? 0;
      return { entryKey, entry, hasAccess, isOidc, expiresAt };
    })
    .filter((row) => row.hasAccess || (typeof row.entry.refresh_token === 'string' && row.entry.refresh_token.trim()));

  if (ranked.length === 0) {
    throw new Error('grok auth file has no usable access/refresh token');
  }

  ranked.sort((a, b) => {
    if (a.isOidc !== b.isOidc) {
      return a.isOidc ? -1 : 1;
    }
    return b.expiresAt - a.expiresAt;
  });

  const best = ranked[0]!;
  return { entryKey: best.entryKey, entry: best.entry };
}

export function captureGrokSessionFromAuthFile(authFilePath: string): CapturedGrokSession {
  const resolved = expandHome(authFilePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`grok token file not found: ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`grok token file is not valid JSON (${resolved}): ${message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`grok token file must be a JSON object of credential entries (${resolved})`);
  }
  const preferred = pickPreferredEntry(parsed as GrokAuthFile);
  const access = typeof preferred.entry.key === 'string' ? preferred.entry.key.trim() : '';
  if (!access) {
    throw new Error(`grok token file missing access token key (${resolved})`);
  }
  return {
    authFile: resolved,
    entryKey: preferred.entryKey,
    email: typeof preferred.entry.email === 'string' ? preferred.entry.email : undefined,
    userId: typeof preferred.entry.user_id === 'string' ? preferred.entry.user_id : undefined,
    teamId: typeof preferred.entry.team_id === 'string' ? preferred.entry.team_id : undefined,
    clientId:
      (typeof preferred.entry.oidc_client_id === 'string' && preferred.entry.oidc_client_id.trim())
      || preferred.entryKey.split('::')[1],
    accessToken: access,
    refreshToken:
      typeof preferred.entry.refresh_token === 'string' ? preferred.entry.refresh_token : undefined,
    expiresAt: typeof preferred.entry.expires_at === 'string' ? preferred.entry.expires_at : undefined,
    accessTokenLength: access.length
  };
}

export function isGrokAuthCandidate(input: {
  rawType?: string;
  providerId?: string;
  tokenFile?: string;
  authFile?: string;
  authDir?: string;
  entries?: Array<{ tokenFile?: string; authFile?: string }>;
}): boolean {
  const raw = typeof input.rawType === 'string' ? input.rawType.trim().toLowerCase() : '';
  if (raw === GROK_AUTH_RAW_TYPE || raw === 'grok-cli' || raw === 'grok-cli-session' || raw === 'supergrok') {
    return true;
  }
  const providerId = typeof input.providerId === 'string' ? input.providerId.trim().toLowerCase() : '';
  if (
    providerId === GROK_PROVIDER_ID
    || providerId === 'grok-cli'
    || providerId === 'supergrok'
    || providerId.startsWith('grok-')
  ) {
    return true;
  }
  const paths = [
    String(input.tokenFile || ''),
    String(input.authFile || ''),
    String(input.authDir || ''),
    ...(Array.isArray(input.entries)
      ? input.entries.flatMap((e) => [String(e.tokenFile || ''), String(e.authFile || '')])
      : [])
  ]
    .map((p) => p.toLowerCase())
    .filter(Boolean);
  return paths.some(
    (p) =>
      p.includes('/provider/grok/')
      || p.includes('provider/grok/auth')
      || p.includes('.grok/auth.json')
      || p.includes('grok/auth')
  );
}

function listAuthDirTokenFiles(authDir: string): string[] {
  if (!fs.existsSync(authDir)) {
    return [];
  }
  const stat = fs.statSync(authDir);
  if (!stat.isDirectory()) {
    return [];
  }
  return fs
    .readdirSync(authDir)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.tmp') && !name.startsWith('.'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .map((name) => path.join(authDir, name));
}

function buildTokenSlots(config: GrokAuthConfig): GrokTokenSlot[] {
  const providerRoot = resolvePath(config.providerRoot || DEFAULT_GROK_PROVIDER_ROOT, os.homedir());
  const authDir = resolvePath(config.authDir || DEFAULT_GROK_AUTH_DIR, providerRoot);
  const slots: GrokTokenSlot[] = [];
  const seen = new Set<string>();

  const pushSlot = (slot: GrokTokenSlot): void => {
    const key = path.resolve(slot.authFile);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    slots.push({ ...slot, authFile: key });
  };

  // 1) Explicit multi-token entries (config-driven, priority order = array order).
  if (Array.isArray(config.entries) && config.entries.length > 0) {
    for (let i = 0; i < config.entries.length; i += 1) {
      const row = config.entries[i]!;
      const file = row.authFile || row.tokenFile;
      if (!file || !String(file).trim()) {
        continue;
      }
      const resolved = resolvePath(String(file), providerRoot);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        for (const tokenPath of listAuthDirTokenFiles(resolved)) {
          pushSlot({
            alias: path.basename(tokenPath, '.json'),
            authFile: tokenPath,
            disabled: row.disabled === true,
            disabledUntil: typeof row.disabledUntil === 'number' ? row.disabledUntil : undefined
          });
        }
        continue;
      }
      pushSlot({
        alias: (typeof row.alias === 'string' && row.alias.trim()) || `token-${i + 1}`,
        authFile: resolved,
        disabled: row.disabled === true,
        disabledUntil: typeof row.disabledUntil === 'number' ? row.disabledUntil : undefined
      });
    }
  }

  // 2) Single tokenFile / authFile (may be a directory = multi-token pool).
  if (slots.length === 0) {
    const single = config.authFile || config.tokenFile;
    if (single && String(single).trim()) {
      const resolved = resolvePath(String(single), providerRoot);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        for (const tokenPath of listAuthDirTokenFiles(resolved)) {
          pushSlot({
            alias: path.basename(tokenPath, '.json'),
            authFile: tokenPath
          });
        }
      } else {
        pushSlot({
          alias: path.basename(resolved, '.json') || 'token-1',
          authFile: resolved
        });
      }
    }
  }

  // 3) Default / merge: scan provider-local auth dir for remaining tokens (priority by filename).
  //    When config listed some entries, only add not-yet-listed files so multi-token pool grows
  //    without requiring every token to be enumerated in bootstrap config.
  for (const tokenPath of listAuthDirTokenFiles(authDir)) {
    pushSlot({
      alias: path.basename(tokenPath, '.json'),
      authFile: tokenPath
    });
  }

  return slots;
}

export class GrokAuthProvider implements IAuthProvider {
  readonly type = 'apikey' as const;

  private readonly config: GrokAuthConfig;
  private readonly tokens: GrokTokenSlot[];
  private readonly selectionMode: 'round-robin' | 'priority';
  private readonly tokenEndpoint: string;
  private readonly earlyRefreshMs: number;
  private readonly clientSurface?: string;
  private readonly clientVersion?: string;

  private isInitialized = false;
  private status: AuthStatus;
  private currentIndex = 0;
  private entryKey = '';
  private entry: GrokAuthEntry | null = null;
  private refreshInFlight: Promise<void> | null = null;

  constructor(config: GrokAuthConfig) {
    this.config = config;
    this.tokens = buildTokenSlots(config);
    // Default priority: prefer first configured/scanned token; only rotate on exhaust.
    this.selectionMode = config.selectionMode === 'round-robin' ? 'round-robin' : 'priority';
    this.tokenEndpoint = (config.tokenUrl || DEFAULT_GROK_TOKEN_ENDPOINT).trim();
    this.earlyRefreshMs =
      typeof config.earlyRefreshMs === 'number' && Number.isFinite(config.earlyRefreshMs)
        ? Math.max(0, Math.floor(config.earlyRefreshMs))
        : DEFAULT_EARLY_REFRESH_MS;
    this.clientSurface =
      typeof config.clientSurface === 'string' && config.clientSurface.trim()
        ? config.clientSurface.trim()
        : undefined;
    this.clientVersion =
      typeof config.clientVersion === 'string' && config.clientVersion.trim()
        ? config.clientVersion.trim()
        : undefined;
    this.status = {
      isAuthenticated: false,
      isValid: false,
      lastValidated: 0
    };
  }

  async initialize(): Promise<void> {
    if (this.tokens.length === 0) {
      throw new Error(
        `grok auth has no token files under ${expandHome(DEFAULT_GROK_AUTH_DIR)}; place session json files there first`
      );
    }

    const errors: string[] = [];
    // priority: try from index 0; round-robin: same on init
    const start = this.findNextEnabledIndex(0);
    if (start < 0) {
      throw new Error('grok auth has no enabled tokens');
    }
    this.currentIndex = start;

    for (let attempt = 0; attempt < this.tokens.length; attempt += 1) {
      const idx = this.selectionMode === 'priority'
        ? this.findNextEnabledIndex(attempt)
        : (start + attempt) % this.tokens.length;
      if (idx < 0) {
        break;
      }
      if (this.selectionMode === 'priority' && this.isSlotDisabled(this.tokens[idx]!)) {
        continue;
      }
      this.currentIndex = idx;
      const slot = this.tokens[idx]!;
      if (this.isSlotDisabled(slot)) {
        continue;
      }
      try {
        this.loadFromDisk();
        await this.ensureFreshToken();
        this.isInitialized = true;
        this.updateStatus(true, true);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${slot.alias}(${slot.authFile}): ${message}`);
      }
    }

    this.updateStatus(false, false, errors.join(' | '));
    throw new Error(`grok auth failed to capture a usable token: ${errors.join(' | ')}`);
  }

  buildHeaders(): Record<string, string> {
    if (!this.isInitialized) {
      throw new Error('GrokAuthProvider is not initialized');
    }
    const accessToken = this.getAccessToken();
    if (!accessToken) {
      throw new Error('GrokAuthProvider has no access token after initialize/refresh');
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'X-XAI-Token-Auth': GROK_TOKEN_AUTH_HEADER_VALUE
    };
    if (this.clientSurface) {
      headers['x-grok-client-surface'] = this.clientSurface;
    }
    if (this.clientVersion) {
      headers['x-grok-client-version'] = this.clientVersion;
    }
    const userId = typeof this.entry?.user_id === 'string' ? this.entry.user_id.trim() : '';
    if (userId) {
      headers['x-grok-user-id'] = userId;
    }
    return headers;
  }

  async validateCredentials(): Promise<boolean> {
    try {
      await this.ensureFreshToken();
      const ok = Boolean(this.getAccessToken());
      this.updateStatus(ok, ok, ok ? undefined : 'missing access token');
      return ok;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateStatus(true, false, message);
      return false;
    }
  }

  async refreshCredentials(): Promise<void> {
    await this.ensureFreshToken({ force: false });
  }

  async forceRefresh(): Promise<void> {
    await this.ensureFreshToken({ force: true });
  }

  /**
   * Disable current token (quota/auth exhausted) and switch to next enabled token.
   * priority: next enabled after current; round-robin: next index.
   */
  async rotateToken(reason: 'permanent' | 'cooldown' = 'cooldown', cooldownMs = 15 * 60 * 1000): Promise<boolean> {
    const current = this.tokens[this.currentIndex];
    if (current) {
      if (reason === 'permanent') {
        current.disabled = true;
        current.disabledUntil = Number.MAX_SAFE_INTEGER;
      } else {
        current.disabled = true;
        current.disabledUntil = Date.now() + Math.max(0, Math.floor(cooldownMs));
      }
    }

    const next = this.findNextEnabledIndex((this.currentIndex + 1) % this.tokens.length);
    if (next < 0) {
      this.updateStatus(true, false, 'all grok tokens exhausted');
      return false;
    }
    this.currentIndex = next;
    this.loadFromDisk();
    await this.ensureFreshToken({ force: false });
    this.isInitialized = true;
    this.updateStatus(true, true);
    return true;
  }

  /** @deprecated use rotateToken */
  async rotateAccount(reason: 'permanent' | 'cooldown' = 'cooldown', cooldownMs = 15 * 60 * 1000): Promise<boolean> {
    return this.rotateToken(reason, cooldownMs);
  }

  async cleanup(): Promise<void> {
    this.entry = null;
    this.entryKey = '';
    this.isInitialized = false;
    this.updateStatus(false, false, 'cleaned up');
  }

  getStatus(): AuthStatus {
    return { ...this.status };
  }

  getAuthFilePath(): string {
    return this.tokens[this.currentIndex]?.authFile || '';
  }

  getActiveEntryKey(): string {
    return this.entryKey;
  }

  getActiveTokenAlias(): string {
    return this.tokens[this.currentIndex]?.alias || 'token-1';
  }

  /** @deprecated use getActiveTokenAlias */
  getActiveAccountAlias(): string {
    return this.getActiveTokenAlias();
  }

  listTokens(): Array<{ alias: string; authFile: string; disabled: boolean }> {
    return this.tokens.map((slot) => ({
      alias: slot.alias,
      authFile: slot.authFile,
      disabled: this.isSlotDisabled(slot)
    }));
  }

  captureAllSessions(): Array<{ alias: string; ok: boolean; session?: CapturedGrokSession; error?: string }> {
    return this.tokens.map((slot) => {
      try {
        return {
          alias: slot.alias,
          ok: true,
          session: captureGrokSessionFromAuthFile(slot.authFile)
        };
      } catch (error) {
        return {
          alias: slot.alias,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    });
  }

  private isSlotDisabled(slot: GrokTokenSlot): boolean {
    if (slot.disabledUntil && slot.disabledUntil > 0 && Date.now() >= slot.disabledUntil) {
      slot.disabled = false;
      slot.disabledUntil = 0;
      return false;
    }
    if (slot.disabled === true) {
      return true;
    }
    if (typeof slot.disabledUntil === 'number' && slot.disabledUntil > Date.now()) {
      return true;
    }
    return false;
  }

  private findNextEnabledIndex(startIndex: number): number {
    if (this.tokens.length === 0) {
      return -1;
    }
    for (let i = 0; i < this.tokens.length; i += 1) {
      const idx = (startIndex + i) % this.tokens.length;
      if (!this.isSlotDisabled(this.tokens[idx]!)) {
        return idx;
      }
    }
    return -1;
  }

  private getAccessToken(): string {
    return typeof this.entry?.key === 'string' ? this.entry.key.trim() : '';
  }

  private needsRefresh(now = Date.now(), force = false): boolean {
    if (force) {
      return true;
    }
    const access = this.getAccessToken();
    if (!access) {
      return true;
    }
    // opencode-aligned: stored expires near OR JWT exp claim near.
    const expiresAt = parseExpiryMs(this.entry?.expires_at);
    if (expiresAt && now >= expiresAt - this.earlyRefreshMs) {
      return true;
    }
    if (accessTokenIsExpiring(access, this.earlyRefreshMs, now)) {
      return true;
    }
    // Opaque token without usable expires_at: keep as-is until force/401 path.
    return false;
  }

  private loadFromDisk(): void {
    const slot = this.tokens[this.currentIndex];
    if (!slot) {
      throw new Error('grok auth has no current token slot');
    }
    const raw = fs.readFileSync(slot.authFile, 'utf8');
    const file = JSON.parse(raw) as GrokAuthFile;
    const preferred = pickPreferredEntry(file);
    this.entryKey = preferred.entryKey;
    this.entry = { ...preferred.entry };
  }

  private async ensureFreshToken(options?: { force?: boolean }): Promise<void> {
    if (!this.entry) {
      this.loadFromDisk();
    }
    if (!this.needsRefresh(Date.now(), options?.force === true)) {
      return;
    }
    if (this.refreshInFlight) {
      await this.refreshInFlight;
      return;
    }
    this.refreshInFlight = this.performRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    await this.refreshInFlight;
  }

  private async performRefresh(): Promise<void> {
    this.loadFromDisk();
    if (this.getAccessToken() && !this.needsRefresh()) {
      return;
    }

    const refreshToken =
      typeof this.entry?.refresh_token === 'string' ? this.entry.refresh_token.trim() : '';
    if (!refreshToken) {
      throw Object.assign(
        new Error(`grok token has no refresh_token in ${this.getAuthFilePath()}`),
        { type: AuthErrorType.TOKEN_EXPIRED, retryable: false }
      );
    }

    const clientId =
      (typeof this.entry?.oidc_client_id === 'string' && this.entry.oidc_client_id.trim())
      || this.entryKey.split('::')[1]
      || '';
    if (!clientId) {
      throw new Error('grok token missing oidc_client_id; cannot refresh');
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId
    });

    const response = await fetch(this.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body
    });

    const text = await response.text();
    let payload: Record<string, unknown> = {};
    if (text.trim()) {
      try {
        payload = JSON.parse(text) as Record<string, unknown>;
      } catch {
        payload = { raw: text };
      }
    }

    if (!response.ok) {
      const detail =
        typeof payload.error_description === 'string'
          ? payload.error_description
          : typeof payload.error === 'string'
            ? payload.error
            : text.slice(0, 300);
      throw Object.assign(
        new Error(
          `grok token refresh failed for ${this.getActiveTokenAlias()}: HTTP ${response.status}${detail ? ` (${detail})` : ''}`
        ),
        {
          type: response.status === 401 || response.status === 400
            ? AuthErrorType.TOKEN_EXPIRED
            : AuthErrorType.NETWORK_ERROR,
          retryable: response.status >= 500,
          details: { status: response.status, payload, token: this.getActiveTokenAlias() }
        }
      );
    }

    const accessToken =
      (typeof payload.access_token === 'string' && payload.access_token.trim())
      || (typeof payload.key === 'string' && payload.key.trim())
      || '';
    if (!accessToken) {
      throw new Error('grok token refresh response missing access_token');
    }

    const nextRefresh =
      (typeof payload.refresh_token === 'string' && payload.refresh_token.trim())
      || refreshToken;
    const expiresIn =
      typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)
        ? Math.floor(payload.expires_in)
        : typeof payload.expires_in === 'string' && Number.isFinite(Number(payload.expires_in))
          ? Math.floor(Number(payload.expires_in))
          : 3600;
    const expiresAtIso = new Date(Date.now() + Math.max(60, expiresIn) * 1000).toISOString();

    this.entry = {
      ...(this.entry || {}),
      key: accessToken,
      refresh_token: nextRefresh,
      expires_at: expiresAtIso,
      auth_mode: this.entry?.auth_mode || 'oidc',
      oidc_issuer: this.entry?.oidc_issuer || DEFAULT_GROK_OIDC_ISSUER,
      oidc_client_id: clientId
    };

    this.persistEntry();
    this.updateStatus(true, true);
  }

  private persistEntry(): void {
    if (!this.entryKey || !this.entry) {
      return;
    }
    const authFilePath = this.getAuthFilePath();
    let file: GrokAuthFile = {};
    if (fs.existsSync(authFilePath)) {
      try {
        const raw = fs.readFileSync(authFilePath, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          file = parsed as GrokAuthFile;
        }
      } catch {
        throw new Error(`cannot persist grok refresh: unreadable token file (${authFilePath})`);
      }
    }
    file[this.entryKey] = {
      ...(file[this.entryKey] || {}),
      ...this.entry
    };
    const dir = path.dirname(authFilePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${authFilePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, authFilePath);
    try {
      fs.chmodSync(authFilePath, 0o600);
    } catch {
      // best-effort
    }
  }

  private updateStatus(isAuthenticated: boolean, isValid: boolean, error?: string): void {
    this.status = {
      isAuthenticated,
      isValid,
      lastValidated: Date.now(),
      expiresAt: parseExpiryMs(this.entry?.expires_at),
      error: isValid ? undefined : error
    };
  }
}

// Back-compat aliases while callers migrate from grok-cli naming.
export {
  GrokAuthProvider as GrokCliAuthProvider,
  isGrokAuthCandidate as isGrokCliAuthCandidate,
  GROK_AUTH_RAW_TYPE as GROK_CLI_AUTH_RAW_TYPE,
  GROK_TOKEN_AUTH_HEADER_VALUE as GROK_CLI_TOKEN_AUTH_VALUE,
  DEFAULT_GROK_AUTH_DIR as DEFAULT_GROK_AUTH_FILE
};
export type { GrokAuthConfig as GrokCliAuthConfig, GrokTokenSlot as GrokCliAccountSlot };
