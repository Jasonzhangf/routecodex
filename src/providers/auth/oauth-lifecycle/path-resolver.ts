/**
 * Path Resolver
 */

import fsSync from 'fs';
import path from 'path';
import {
  resolveRccAuthDir,
  resolveRccAuthDirForRead,
  resolveRccTokensDir
} from '../../../config/user-data-paths.js';
import { expandHome } from '../../../utils/common-utils.js';
export { expandHome };
import type { OAuthAuth } from '../../core/api/provider-config.js';

export function defaultTokenFile(providerType: string): string {
  if (providerType === 'deepseek-account') {
    return path.join(resolveRccAuthDir(), 'deepseek-account-oauth-1-default.json');
  }
  return path.join(resolveRccTokensDir(), `${providerType}-default.json`);
}

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
  const authDir = resolveRccAuthDirForRead();
  const pattern = new RegExp(`^${providerType}-oauth-(\\d+)(?:-(.+))?\\.json$`, 'i');

  const directStemPath = path.join(authDir, `${raw}.json`);
  try {
    if (fsSync.existsSync(directStemPath)) {
      auth.tokenFile = directStemPath;
      return directStemPath;
    }
  } catch {
    // ignore
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
      const entryAlias = match[2] || 'default';
      if (entryAlias === alias && seq >= bestSeqForAlias) {
        bestSeqForAlias = seq;
        existingPath = path.join(authDir, entry);
      }
      if (seq > maxSeq) {
        maxSeq = seq;
      }
    }
  } catch {
    // ignore
  }

  if (existingPath) {
    auth.tokenFile = existingPath;
    return existingPath;
  }

  const nextSeq = alias === 'default' ? 1 : maxSeq + 1;
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
    const match = base.match(re);
    const alias = match && match[1] ? String(match[1]).trim() : '';
    if (alias) {
      return alias;
    }
  }
  return 'default';
}

export function resolveTokenAliasFromPath(tokenFilePath: string): string | undefined {
  if (!tokenFilePath) {
    return undefined;
  }
  const base = path.basename(tokenFilePath);
  const match = base.match(/^[a-z0-9_.-]+-oauth-\d+(?:-(.+))?\.json$/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  return undefined;
}
