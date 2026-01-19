import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
import type { TokenFileMatch } from '../providers/auth/token-scanner/index.js';
import {
  type OAuthProviderId,
  type RawTokenPayload,
  type TokenDescriptor,
  type TokenState,
  SUPPORTED_OAUTH_PROVIDERS
} from './token-types.js';
import { scanProviderTokenFiles } from '../providers/auth/token-scanner/index.js';

export function resolveAuthDir(): string {
  const override = String(process.env.ROUTECODEX_AUTH_DIR || process.env.RCC_AUTH_DIR || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(override);
  }
  const home = String(process.env.HOME || '').trim() || homedir();
  return path.join(home, '.routecodex', 'auth');
}

export const DEFAULT_AUTH_DIR = resolveAuthDir();

export async function readTokenFile(filePath: string): Promise<RawTokenPayload | null> {
  try {
    const txt = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(txt) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const token = parsed as RawTokenPayload;
    if (!token.apiKey && token.api_key) {
      token.apiKey = token.api_key;
    }
    return token;
  } catch {
    return null;
  }
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
    const ts = Date.parse(trimmed);
    return Number.isFinite(ts) ? ts : null;
  }
  return null;
}

export function getExpiresAtMillis(token: RawTokenPayload | null): number | null {
  if (!token) {
    return null;
  }
  const raw = token.expires_at ?? token.expired ?? token.expiry_date;
  const millis = asNumber(raw);
  return millis && millis > 0 ? millis : null;
}

export function hasAccessToken(token: RawTokenPayload | null): boolean {
  if (!token) {
    return false;
  }
  const cand = token.access_token ?? token.AccessToken;
  return typeof cand === 'string' && cand.trim().length > 0;
}

export function hasApiKey(token: RawTokenPayload | null): boolean {
  if (!token) {
    return false;
  }
  const cand = token.apiKey ?? token.api_key;
  return typeof cand === 'string' && cand.trim().length > 0;
}

export function hasRefreshToken(token: RawTokenPayload | null): boolean {
  if (!token) {
    return false;
  }
  const cand = token.refresh_token;
  return typeof cand === 'string' && cand.trim().length > 0;
}

export function evaluateTokenState(token: RawTokenPayload | null, now: number): TokenState {
  const access = hasAccessToken(token);
  const apiKey = hasApiKey(token);
  const refresh = hasRefreshToken(token);
  const expiresAt = getExpiresAtMillis(token);
  const msUntilExpiry = expiresAt !== null ? expiresAt - now : null;
  const noRefresh =
    token !== null && (token.norefresh === true || (typeof token.noRefresh === 'boolean' && token.noRefresh));

  let status: TokenState['status'] = 'invalid';
  if (!access && !apiKey) {
    status = 'invalid';
  } else if (expiresAt === null) {
    status = 'valid';
  } else if (msUntilExpiry !== null && msUntilExpiry <= 0) {
    status = 'expired';
  } else if (msUntilExpiry !== null && msUntilExpiry <= 30 * 60_000) {
    status = 'expiring';
  } else {
    status = 'valid';
  }

  return {
    hasAccessToken: access,
    hasRefreshToken: refresh,
    hasApiKey: apiKey,
    expiresAt,
    msUntilExpiry,
    status,
    noRefresh
  };
}

function resolveDisplayName(match: TokenFileMatch, token: RawTokenPayload | null): string {
  const base = path.basename(match.filePath);
  const alias = match.alias && match.alias !== 'default' ? match.alias : undefined;
  const email = typeof token?.email === 'string' && token.email.trim() ? token.email.trim() : undefined;
  const account = typeof token?.account === 'string' && token.account.trim() ? token.account.trim() : undefined;
  const name = typeof token?.name === 'string' && token.name.trim() ? token.name.trim() : undefined;

  if (alias) {
    return alias;
  }
  if (email) {
    return email;
  }
  if (name) {
    return name;
  }
  if (account) {
    return account;
  }
  return base;
}

export interface ProviderTokenSnapshot {
  provider: OAuthProviderId;
  tokens: TokenDescriptor[];
}

export interface TokenDaemonSnapshot {
  timestamp: number;
  providers: ProviderTokenSnapshot[];
}

export async function collectTokenSnapshot(): Promise<TokenDaemonSnapshot> {
  const now = Date.now();
  const providers: ProviderTokenSnapshot[] = [];

  for (const provider of SUPPORTED_OAUTH_PROVIDERS) {
    let matches: TokenFileMatch[] = [];
    try {
      matches = await scanProviderTokenFiles(provider);
    } catch {
      matches = [];
    }
    const tokens: TokenDescriptor[] = [];
    for (const match of matches) {
      const token = await readTokenFile(match.filePath);
      const state = evaluateTokenState(token, now);
      const displayName = resolveDisplayName(match, token);
      tokens.push({
        provider,
        filePath: match.filePath,
        sequence: match.sequence,
        alias: match.alias || 'default',
        state,
        displayName
      });
    }
    providers.push({ provider, tokens });
  }

  return { timestamp: now, providers };
}
