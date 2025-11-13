/**
 * TokenFile Authentication - reuse tokens produced by external login tools (e.g., CLIProxyAPI)
 *
 * For providers that don't expose public client credentials, we can piggyback on an
 * external login tool that stores OAuth tokens locally. This auth provider reads
 * the token JSON and injects `Authorization: Bearer <access_token>`.
 */

import fs from 'fs';
import path from 'path';
import type { IAuthProvider, AuthStatus } from './auth-interface.js';
import type { OAuthAuth } from '../api/provider-config.js';

export class TokenFileAuthProvider implements IAuthProvider {
  readonly type = 'oauth' as const;

  private config: OAuthAuth;
  private status: AuthStatus;
  private isInitialized = false;
  private token: any | null = null;

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
    const ok = this.hasAccessToken(this.token);
    this.isInitialized = true;
    this.updateStatus(ok, ok, ok ? undefined : 'missing_access_token');
  }

  buildHeaders(): Record<string, string> {
    // Lazy reload if token not available yet
    if (!this.token) {
      const file = this.resolveTokenFile();
      if (file) this.token = this.readJson(file);
    }
    if (!this.isInitialized || !this.token) throw new Error('TokenFileAuthProvider not initialized');
    const access = this.extractAccessToken(this.token);
    if (!access) throw new Error('TokenFileAuthProvider: no access_token in token file');
    return { 'Authorization': `Bearer ${access}` };
  }

  async validateCredentials(): Promise<boolean> {
    if (!this.isInitialized) return false;
    const exp = this.extractExpiresAt(this.token);
    const ok = !exp || Date.now() < exp - 5 * 60 * 1000;
    this.updateStatus(true, ok, ok ? undefined : 'token expired');
    return ok;
  }

  async cleanup(): Promise<void> {
    this.token = null;
    this.isInitialized = false;
    this.updateStatus(false, false, 'cleanup');
  }

  getStatus(): AuthStatus { return { ...this.status }; }

  // ---- helpers ----
  private resolveTokenFile(): string | null {
    // Prefer explicit tokenFile from config
    const tf = (this.config as any).tokenFile as string | undefined;
    if (tf && tf.trim()) return this.expandHome(tf.trim());
    // Fallback order:
    // 1) RouteCodex default token path
    const rc = path.join(process.env.HOME || '', '.routecodex', 'tokens', 'qwen-default.json');
    try { if (fs.existsSync(rc)) return rc; } catch {}
    // 2) CLIProxyAPI directory
    const home = process.env.HOME || '';
    const dir = path.join(home, '.cli-proxy-api');
    try {
      const list = fs.readdirSync(dir).filter(n => /^qwen-.*\.json$/i.test(n));
      if (list.length > 0) return path.join(dir, list.sort()[0]);
    } catch { /* ignore */ }
    return null;
  }

  private expandHome(p: string): string { return p.startsWith('~/') ? p.replace(/^~\//, `${process.env.HOME || ''}/`) : p; }

  private readJson(p: string): any | null { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } }

  private hasAccessToken(tok: any): boolean { return !!this.extractAccessToken(tok); }

  private extractAccessToken(tok: any): string | null {
    if (!tok || typeof tok !== 'object') return null;
    const cand = (tok as any).access_token || (tok as any).AccessToken || (tok as any).token || '';
    return typeof cand === 'string' && cand.trim() ? cand.trim() : null;
  }

  private extractExpiresAt(tok: any): number | null {
    // Accept either absolute ms (expires_at) or seconds since epoch
    const a = (tok as any).expires_at || (tok as any).ExpiresAt;
    const n = Number(a);
    if (Number.isFinite(n) && n > 0) return n > 10_000_000_000 ? n : n * 1000;
    return null;
  }

  private updateStatus(isAuthenticated: boolean, isValid: boolean, message?: string): void {
    this.status = { isAuthenticated, isValid, lastValidated: Date.now(), error: message };
  }
}
