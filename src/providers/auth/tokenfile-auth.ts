/**
 * TokenFile Authentication - reuse tokens produced by external login tools (e.g., CLIProxyAPI)
 *
 * For providers that don't expose public client credentials, we can piggyback on an
 * external login tool that stores OAuth tokens locally. This auth provider reads
 * the token JSON and injects `Authorization: Bearer <access_token>`.
 * 
 * 更新：支持iFlow的API Key模式 - 优先使用api_key字段，回退到access_token
 */

import fs from 'fs';
import path from 'path';
import type { IAuthProvider, AuthStatus } from './auth-interface.js';
import type { OAuthAuth } from '../core/api/provider-config.js';
import type { UnknownObject } from '../../modules/pipeline/types/common-types.js';

type TokenPayload = UnknownObject & {
  access_token?: string;
  AccessToken?: string;
  token?: string;
  api_key?: string;
  APIKey?: string;
  apiKey?: string;
  expires_at?: number | string;
  ExpiresAt?: number | string;
};

function isTokenPayload(value: unknown): value is TokenPayload {
  return typeof value === 'object' && value !== null;
}

function resolveAuthDir(): string {
  const override = String(process.env.ROUTECODEX_AUTH_DIR || process.env.RCC_AUTH_DIR || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(override);
  }
  const home = String(process.env.HOME || '').trim();
  return path.join(home, '.routecodex', 'auth');
}

const TOKEN_FILE_PATTERN = /^(.+)-oauth-(\d+)(?:-(.+))?\.json$/i;

function pickLatestTokenFile(opts: { providerPrefix: string; alias?: string }): string | null {
  const provider = opts.providerPrefix.trim().toLowerCase();
  const alias = (opts.alias || '').trim() || undefined;
  if (!provider) {
    return null;
  }
  const authDir = resolveAuthDir();
  try {
    const entries = fs.readdirSync(authDir);
    let best: { seq: number; file: string } | null = null;
    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue;
      }
      if (entry.includes('.bak')) {
        continue;
      }
      const match = entry.match(TOKEN_FILE_PATTERN);
      if (!match) {
        continue;
      }
      const [, prefix, seqRaw, entryAliasRaw] = match;
      if (String(prefix || '').trim().toLowerCase() !== provider) {
        continue;
      }
      const seq = parseInt(String(seqRaw || ''), 10);
      if (!Number.isFinite(seq) || seq <= 0) {
        continue;
      }
      const entryAlias = (String(entryAliasRaw || '').trim() || 'default');
      if (alias && entryAlias !== alias) {
        continue;
      }
      if (!best || seq > best.seq) {
        best = { seq, file: path.join(authDir, entry) };
      }
    }
    return best?.file ?? null;
  } catch {
    return null;
  }
}

export class TokenFileAuthProvider implements IAuthProvider {
  readonly type = 'oauth' as const;

  private readonly config: OAuthAuth;
  private status: AuthStatus;
  private isInitialized = false;
  private token: TokenPayload | null = null;

  constructor(config: OAuthAuth) {
    this.config = config;
    this.status = { isAuthenticated: false, isValid: false, lastValidated: 0 };
  }

  async initialize(): Promise<void> {
    const file = this.resolveTokenFile();
    if (!file) {
      this.token = null;
      this.isInitialized = true;
      this.updateStatus(false, false, 'token_file_missing');
      return;
    }
    this.token = this.readJson(file);
    if (!this.token) {
      this.isInitialized = true;
      this.updateStatus(false, false, 'token_file_unreadable');
      return;
    }
    const ok = this.hasAccessToken(this.token) || this.hasApiKey(this.token);
    this.isInitialized = true;
    this.updateStatus(ok, ok, ok ? undefined : 'missing_access_token_or_api_key');
  }

  buildHeaders(): Record<string, string> {
    // Always attempt to reload token from disk to pick up refreshed credentials
    const file = this.resolveTokenFile();
    if (file) {
      const latest = this.readJson(file);
      if (latest) {
        this.token = latest;
      }
    } else {
      this.token = null;
    }

    if (!this.isInitialized) {
      throw new Error('TokenFileAuthProvider not initialized');
    }
    if (!this.token) {
      this.updateStatus(false, false, 'token_file_missing');
      throw new Error('TokenFileAuthProvider not initialized');
    }
    const ok = this.hasAccessToken(this.token) || this.hasApiKey(this.token);
    if (!ok) {
      this.updateStatus(false, false, 'missing_access_token_or_api_key');
      throw new Error('TokenFileAuthProvider not initialized');
    }

    // iFlow专用：优先使用API Key，回退到access_token
    const apiKey = this.extractApiKey(this.token);
    if (apiKey) {
      this.updateStatus(true, true);
      return { Authorization: `Bearer ${apiKey}` };
    }

    const access = this.extractAccessToken(this.token);
    if (!access) {
      this.updateStatus(false, false, 'missing_access_token_or_api_key');
      throw new Error('TokenFileAuthProvider not initialized');
    }
    this.updateStatus(true, true);
    return { Authorization: `Bearer ${access}` };
  }

  async validateCredentials(): Promise<boolean> {
    if (!this.isInitialized) {
      return false;
    }
    // Best-effort: refresh token snapshot before validating.
    const file = this.resolveTokenFile();
    if (file) {
      const latest = this.readJson(file);
      if (latest) {
        this.token = latest;
      }
    }
    if (!this.token) {
      this.updateStatus(false, false, 'token_file_missing');
      return false;
    }
    const exp = this.extractExpiresAt(this.token);
    const ok = exp === null || Date.now() < exp - 5 * 60 * 1000;
    this.updateStatus(true, ok, ok ? undefined : 'token expired');
    return ok;
  }

  async cleanup(): Promise<void> {
    this.token = null;
    this.isInitialized = false;
    this.updateStatus(false, false, 'cleanup');
  }

  getStatus(): AuthStatus { return { ...this.status }; }

  /**
   * 返回当前缓存的 token 内容快照。
   * 会尝试与磁盘上的最新内容同步一次，但不会抛出异常。
   * 主要用于需要从 token 中读取附加字段（如 project_id）的 Provider。
   */
  public getTokenPayload(): TokenPayload | null {
    const file = this.resolveTokenFile();
    if (file) {
      const latest = this.readJson(file);
      if (latest) {
        this.token = latest;
      }
    }
    return this.token ? { ...this.token } : null;
  }

  // ---- helpers ----
  private pickTokenFileIfItContainsApiKey(candidatePath: string): string | null {
    try {
      if (!candidatePath) return null;
      if (!fs.existsSync(candidatePath)) return null;
      const parsed = this.readJson(candidatePath);
      const apiKey = this.extractApiKey(parsed);
      return apiKey ? candidatePath : null;
    } catch {
      return null;
    }
  }

  private resolveTokenFile(): string | null {
    // Prefer explicit tokenFile from config
    const tf = typeof this.config.tokenFile === 'string' ? this.config.tokenFile.trim() : '';
    if (tf) {
      // Alias (no path separators / no .json suffix): resolve to ~/.routecodex/auth/<provider>-oauth-<seq>-<alias>.json
      if (!tf.includes('/') && !tf.includes('\\') && !tf.endsWith('.json')) {
        const providerIdRaw =
          typeof (this.config as unknown as { oauthProviderId?: unknown }).oauthProviderId === 'string'
            ? String((this.config as unknown as { oauthProviderId: string }).oauthProviderId).trim()
            : '';
        const providerId = providerIdRaw ? providerIdRaw.toLowerCase() : '';
        if (providerId) {
          const match = pickLatestTokenFile({ providerPrefix: providerId, alias: tf });
          if (match) {
            return match;
          }
        }
        return null;
      }

      const resolved = this.expandHome(tf);
      // Qwen: allow legacy single-file token path, but fall back to auth dir token set when missing.
      const providerIdRaw =
        typeof (this.config as unknown as { oauthProviderId?: unknown }).oauthProviderId === 'string'
          ? String((this.config as unknown as { oauthProviderId: string }).oauthProviderId).trim()
          : '';
      const providerId = providerIdRaw ? providerIdRaw.toLowerCase() : '';
      if (providerId === 'qwen') {
        try {
          if (!fs.existsSync(resolved)) {
            const fallback = pickLatestTokenFile({ providerPrefix: 'qwen' });
            if (fallback) {
              return fallback;
            }
          }
        } catch {
          // ignore
        }
      }
      return resolved;
    }

    const providerIdRaw =
      typeof (this.config as unknown as { oauthProviderId?: unknown }).oauthProviderId === 'string'
        ? String((this.config as unknown as { oauthProviderId: string }).oauthProviderId).trim()
        : '';
    const providerId = providerIdRaw ? providerIdRaw.toLowerCase() : '';
    if (providerId === 'iflow') {
      // iFlow CLI stores an already-usable API key in ~/.iflow/settings.json (field: apiKey).
      // Prefer it and DO NOT fall back to access_token-only files (iFlow business calls require apiKey).
      const home = process.env.HOME || '';
      const settings = this.pickTokenFileIfItContainsApiKey(path.join(home, '.iflow', 'settings.json'));
      if (settings) {
        return settings;
      }
      const creds = this.pickTokenFileIfItContainsApiKey(path.join(home, '.iflow', 'oauth_creds.json'));
      if (creds) {
        return creds;
      }
      return null;
    }

    // Qwen: default to RouteCodex auth dir tokens (daemon-admin / oauth-lifecycle output)
    if (providerId === 'qwen') {
      const home = process.env.HOME || '';
      const legacySingle = path.join(home, '.routecodex', 'auth', 'qwen-oauth.json');
      try {
        if (fs.existsSync(legacySingle)) {
          return legacySingle;
        }
      } catch { /* ignore */ }
      const latest = pickLatestTokenFile({ providerPrefix: 'qwen' });
      if (latest) {
        return latest;
      }
      // Old fallback: RouteCodex tokens dir (legacy external tooling)
      const rc = path.join(home, '.routecodex', 'tokens', 'qwen-default.json');
      try {
        if (fs.existsSync(rc)) {
          return rc;
        }
      } catch { /* ignore */ }
    }

    // CLIProxyAPI directory (legacy external tooling)
    const home = process.env.HOME || '';
    const dir = path.join(home, '.cli-proxy-api');
    try {
      const list = fs.readdirSync(dir).filter(n => /^qwen-.*\.json$/i.test(n));
      if (list.length > 0) {
        return path.join(dir, list.sort()[0]);
      }
    } catch { /* ignore */ }
    return null;
  }

  private expandHome(p: string): string {
    return p.startsWith('~/') ? p.replace(/^~\//, `${process.env.HOME || ''}/`) : p;
  }

  private readJson(p: string): TokenPayload | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as unknown;
      return isTokenPayload(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private hasAccessToken(tok: TokenPayload | null): boolean {
    return !!this.extractAccessToken(tok);
  }

  private hasApiKey(tok: TokenPayload | null): boolean {
    return !!this.extractApiKey(tok);
  }

  private extractAccessToken(tok: TokenPayload | null): string | null {
    if (!tok) {
      return null;
    }
    const cand = tok.access_token || tok.AccessToken || tok.token;
    if (typeof cand === 'string' && cand.trim()) {
      return cand.trim();
    }
    return null;
  }

  private extractApiKey(tok: TokenPayload | null): string | null {
    if (!tok) {
      return null;
    }
    const cand = tok.api_key || tok.APIKey || tok.apiKey;
    if (typeof cand === 'string' && cand.trim()) {
      return cand.trim();
    }
    return null;
  }

  private extractExpiresAt(tok: TokenPayload | null): number | null {
    if (!tok) {
      return null;
    }
    const raw = tok.expires_at ?? tok.ExpiresAt;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw > 10_000_000_000 ? raw : raw * 1000;
    }
    if (typeof raw === 'string') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return parsed > 10_000_000_000 ? parsed : parsed * 1000;
      }
      const ts = Date.parse(raw);
      return Number.isFinite(ts) ? ts : null;
    }
    return null;
  }

  private updateStatus(isAuthenticated: boolean, isValid: boolean, message?: string): void {
    this.status = {
      isAuthenticated,
      isValid,
      lastValidated: Date.now(),
      error: message
    };
  }
}
