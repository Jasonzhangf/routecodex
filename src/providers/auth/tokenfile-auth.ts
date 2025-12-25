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
  expires_at?: number | string;
  ExpiresAt?: number | string;
};

function isTokenPayload(value: unknown): value is TokenPayload {
  return typeof value === 'object' && value !== null;
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
      // Lenient: allow initialize without token; ensureValidOAuthToken may create one later
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
    } else if (!this.token) {
      this.token = null;
    }

    if (!this.isInitialized || !this.token) {
      throw new Error('TokenFileAuthProvider not initialized');
    }

    // iFlow专用：优先使用API Key，回退到access_token
    const apiKey = this.extractApiKey(this.token);
    if (apiKey) {
      return { Authorization: `Bearer ${apiKey}` };
    }

    const access = this.extractAccessToken(this.token);
    if (!access) {
      throw new Error('TokenFileAuthProvider: no access_token or api_key in token file');
    }
    return { Authorization: `Bearer ${access}` };
  }

  async validateCredentials(): Promise<boolean> {
    if (!this.isInitialized || !this.token) {
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
    if (!this.isInitialized && !this.token) {
      return null;
    }
    return this.token ? { ...this.token } : null;
  }

  // ---- helpers ----
  private resolveTokenFile(): string | null {
    // Prefer explicit tokenFile from config
    const tf = typeof this.config.tokenFile === 'string' ? this.config.tokenFile.trim() : '';
    if (tf) {
      return this.expandHome(tf);
    }
    // Fallback order:
    // 1) RouteCodex default token path
    const rc = path.join(process.env.HOME || '', '.routecodex', 'tokens', 'qwen-default.json');
    try {
      if (fs.existsSync(rc)) {
        return rc;
      }
    } catch { /* ignore */ }
    // 2) CLIProxyAPI directory
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
    const cand = tok.api_key || tok.APIKey;
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
