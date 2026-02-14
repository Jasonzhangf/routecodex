/**
 * Token File Resolver
 *
 * Resolves token file paths for OAuth providers.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseTokenSequenceFromPath } from '../token-scanner/index.js';

const GEMINI_CLI_PROVIDER_IDS = new Set(['gemini-cli', 'antigravity']);

export function isGeminiCliFamily(providerType: string): boolean {
  return GEMINI_CLI_PROVIDER_IDS.has(providerType.toLowerCase());
}

/**
 * Expand ~ to home directory
 */
function expandHome(p: string): string {
  return p.startsWith('~/') ? p.replace(/^~/, `${process.env.HOME || ''}/`) : p;
}

/**
 * Get default token file path for provider type
 */
function defaultTokenFile(providerType: string): string {
  const home = process.env.HOME || '';
  if (providerType === 'iflow') {
    return path.join(home, '.iflow', 'oauth_creds.json');
  }
  if (providerType === 'qwen') {
    // Align with TokenFileAuthProvider + token-daemon defaults:
    // keep a stable, well-known Qwen token file for alias="default".
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

/**
 * Resolve token file path from auth configuration
 */
export function resolveTokenFilePath(
  auth: { tokenFile?: string },
  providerType: string
): string {
  const raw = typeof auth.tokenFile === 'string' ? auth.tokenFile.trim() : '';

  // No configuration: use provider default token file (single-token scenario)
  if (!raw) {
    const fallback = defaultTokenFile(providerType);
    (auth as any).tokenFile = fallback;
    return fallback;
  }

  // Explicit path (contains path separator or .json), expand ~ and return
  if (raw.includes('/') || raw.includes('\\') || raw.endsWith('.json')) {
    const resolved = expandHome(raw);
    (auth as any).tokenFile = resolved;
    return resolved;
  }

  // Pure alias: search under ~/.routecodex/auth for <provider>-oauth-*-<alias>.json (sync version)
  const alias = raw;
  const homeDir = process.env.HOME || os.homedir();
  const authDir = path.join(homeDir, '.routecodex', 'auth');
  const pattern = new RegExp(`^${providerType}-oauth-(\\d+)(?:-(.+))?\\.json$`, 'i');

  const pt = providerType.toLowerCase();
  // Qwen: keep a stable "default" file name whenever possible.
  if (pt === 'qwen' && alias === 'default') {
    const pinned = path.join(authDir, 'qwen-oauth-1-default.json');
    try {
      if (fs.existsSync(pinned)) {
        (auth as any).tokenFile = pinned;
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
    const entries = fs.readdirSync(authDir);
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
    (auth as any).tokenFile = existingPath;
    return existingPath;
  }

  // When we don't have any existing token for this alias:
  // - Qwen default alias should always map to seq=1 for stability.
  // - Otherwise, allocate next seq to avoid collisions.
  const nextSeq = (pt === 'qwen' && alias === 'default') ? 1 : (maxSeq + 1);
  const fileName = `${providerType}-oauth-${nextSeq}-${alias}.json`;
  const fullPath = path.join(authDir, fileName);
  (auth as any).tokenFile = fullPath;
  return fullPath;
}