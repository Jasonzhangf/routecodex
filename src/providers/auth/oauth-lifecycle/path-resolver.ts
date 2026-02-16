/**
 * Path Resolver
 *
 * Token file path resolution utilities.
 */

import fsSync from 'fs';
import path from 'path';
import os from 'os';

const GEMINI_CLI_PROVIDER_IDS = new Set(['gemini-cli', 'antigravity']);

export function isGeminiCliFamily(providerType: string): boolean {
  return GEMINI_CLI_PROVIDER_IDS.has(providerType.toLowerCase());
}

export function expandHome(p: string): string {
  return p.startsWith('~/') ? p.replace(/^~\//, `${process.env.HOME || ''}/`) : p;
}

export function defaultTokenFile(providerType: string): string {
  const home = process.env.HOME || '';
  if (providerType === 'iflow') {
    return path.join(home, '.routecodex', 'auth', 'iflow-oauth-1-default.json');
  }
  if (providerType === 'qwen') {
    return path.join(home, '.routecodex', 'auth', 'qwen-oauth-1-default.json');
  }
  if (isGeminiCliFamily(providerType)) {
    const file = providerType.toLowerCase() === 'antigravity'
      ? 'antigravity-oauth.json'
      : 'gemini-oauth.json';
    return path.join(home, '.routecodex', 'auth', file);
  }
  return path.join(home, '.routecodex', 'tokens', `${providerType}-default.json`);
}

export function resolveIflowCredentialCandidates(): string[] {
  const raw = String(process.env.IFLOW_OAUTH_TOKEN_FILE || '').trim();
  const fromEnv = raw ? expandHome(raw) : '';
  const candidates = [fromEnv].filter((item) => typeof item === 'string' && item.trim().length > 0) as string[];
  return [...new Set(candidates)];
}

import type { OAuthAuth } from '../../core/api/provider-config.js';

export type ExtendedOAuthAuth = OAuthAuth & {
  tokenFile?: string;
  authorizationUrl?: string;
  userInfoUrl?: string;
  redirectUri?: string;
};

export function resolveTokenFilePath(auth: ExtendedOAuthAuth, providerType: string): string {
  const raw = typeof auth.tokenFile === 'string' ? auth.tokenFile.trim() : '';

  if (!raw) {
    const fallback = defaultTokenFile(providerType);
    auth.tokenFile = fallback;
    return fallback;
  }

  if (raw.includes('/') || raw.includes('\\') || raw.endsWith('.json')) {
    const resolved = expandHome(raw);
    auth.tokenFile = resolved;
    return resolved;
  }

  const alias = raw;
  const homeDir = process.env.HOME || os.homedir();
  const authDir = path.join(homeDir, '.routecodex', 'auth');
  const pattern = new RegExp(`^${providerType}-oauth-(\\d+)(?:-(.+))?\\.json$`, 'i');

  const pt = providerType.toLowerCase();
  if (pt === 'qwen' && alias === 'default') {
    const pinned = path.join(authDir, 'qwen-oauth-1-default.json');
    try {
      if (fsSync.existsSync(pinned)) {
        auth.tokenFile = pinned;
        return pinned;
      }
    } catch {
      // ignore and fall back to scanning
    }
  }

  let existingPath: string | null = null;
  let bestSeqForAlias = 0;
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
      if (entryAlias === alias && seq >= bestSeqForAlias) {
        bestSeqForAlias = seq;
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

  const nextSeq = (pt === 'qwen' && alias === 'default') ? 1 : (maxSeq + 1);
  const fileName = `${providerType}-oauth-${nextSeq}-${alias}.json`;
  const fullPath = path.join(authDir, fileName);
  auth.tokenFile = fullPath;
  return fullPath;
}

export function resolveCamoufoxAliasForAuth(providerType: string, auth: ExtendedOAuthAuth): string {
  const raw = typeof auth.tokenFile === 'string' ? auth.tokenFile.trim() : '';
  if (raw && !raw.includes('/') && !raw.includes('\\') && !raw.endsWith('.json')) {
    return raw;
  }
  const base = raw ? path.basename(raw) : '';
  const pt = String(providerType || '').trim().toLowerCase();
  if (base && pt) {
    const re = new RegExp(`^${pt}-oauth-\\d+(?:-(.+))?\\.json$`, 'i');
    const m = base.match(re);
    const alias = m && m[1] ? String(m[1]).trim() : '';
    if (alias) {
      return alias;
    }
  }
  return 'default';
}
