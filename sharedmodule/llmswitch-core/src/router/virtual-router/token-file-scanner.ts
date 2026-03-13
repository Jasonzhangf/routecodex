import fs from 'fs';
import path from 'path';
import { resolveRccPathForRead } from '../../runtime/user-data-paths.js';

export interface OAuthTokenFileMatch {
  filePath: string;
  sequence: number;
  alias: string;
}

const TOKEN_FILE_PATTERN = /^([a-z0-9_-]+)-oauth-(\d+)(?:-(.+))?\.json$/i;
const DEEPSEEK_ACCOUNT_TOKEN_PATTERN = /^deepseek-account-(.+)\.json$/i;

function resolveAuthDir(authDir?: string): string {
  if (authDir && authDir.trim()) {
    return authDir.trim();
  }
  const envDir = (process.env.ROUTECODEX_AUTH_DIR || process.env.RCC_AUTH_DIR || '').trim();
  if (envDir) {
    return envDir;
  }
  return resolveRccPathForRead('auth');
}

/**
 * 扫描本地 auth 目录中的 OAuth token 文件。
 *
 * 约定:
 * - 目录: ~/.rcc/auth
 * - 文件名: <provider>-oauth-<sequence>[-<alias>].json
 *
 * 仅在 Node 环境下使用；如果环境不满足，返回空列表。
 */
export function scanOAuthTokenFiles(oauthProviderId: string, authDir?: string): OAuthTokenFileMatch[] {
  if (!isNodeEnvironment()) {
    return [];
  }

  const provider = oauthProviderId.trim().toLowerCase();
  if (!provider) {
    return [];
  }

  const baseDir = resolveAuthDir(authDir);

  let entries: string[];
  try {
    entries = fs.readdirSync(baseDir);
  } catch {
    return [];
  }

  const matches: OAuthTokenFileMatch[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const match = entry.match(TOKEN_FILE_PATTERN);
    if (!match) continue;
    const [, providerPrefix, sequenceStr, alias] = match;
    if (providerPrefix.toLowerCase() !== provider) continue;
    const sequence = parseInt(sequenceStr, 10);
    if (!Number.isFinite(sequence) || sequence <= 0) continue;
    matches.push({
      filePath: path.join(baseDir, entry),
      sequence,
      alias: alias || 'default'
    });
  }

  matches.sort((a, b) => a.sequence - b.sequence);
  return matches;
}

/**
 * 扫描 DeepSeek account token 文件。
 *
 * 约定:
 * - 目录: ~/.rcc/auth
 * - 文件名: deepseek-account-<alias>.json
 *   例如: deepseek-account-1.json, deepseek-account-2-work.json
 */
export function scanDeepSeekAccountTokenFiles(authDir?: string): OAuthTokenFileMatch[] {
  if (!isNodeEnvironment()) {
    return [];
  }

  const baseDir = resolveAuthDir(authDir);

  let entries: string[];
  try {
    entries = fs.readdirSync(baseDir);
  } catch {
    return [];
  }

  const matches: Array<{ filePath: string; alias: string; numericPrefix?: number }> = [];

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const match = entry.match(DEEPSEEK_ACCOUNT_TOKEN_PATTERN);
    if (!match) continue;
    const aliasRaw = (match[1] || '').trim();
    if (!aliasRaw.length) continue;
    const numericMatch = aliasRaw.match(/^(\d+)(?:-|$)/);
    const numericPrefix = numericMatch ? Number.parseInt(numericMatch[1], 10) : undefined;
    matches.push({
      filePath: path.join(baseDir, entry),
      alias: aliasRaw,
      ...(Number.isFinite(numericPrefix as number) ? { numericPrefix } : {})
    });
  }

  matches.sort((a, b) => {
    const aNum = typeof a.numericPrefix === 'number' ? a.numericPrefix : Number.POSITIVE_INFINITY;
    const bNum = typeof b.numericPrefix === 'number' ? b.numericPrefix : Number.POSITIVE_INFINITY;
    if (aNum !== bNum) {
      return aNum - bNum;
    }
    return a.alias.localeCompare(b.alias);
  });

  return matches.map((entry, index) => ({
    filePath: entry.filePath,
    sequence: index + 1,
    alias: entry.alias
  }));
}

function isNodeEnvironment(): boolean {
  return typeof process !== 'undefined' && !!process.release && process.release.name === 'node';
}
