/**
 * OAuth Token Scanner
 * 自动扫描auth目录下符合命名规范的token文件
 * 命名规范: <provider>-oauth-<序号>-<alias>.json
 * 例如: iflow-oauth-1-work.json, iflow-oauth-2-personal.json
 */

import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

export interface TokenFileMatch {
  filePath: string;
  providerPrefix: string;
  sequence: number;
  alias: string;
}

const AUTH_DIR = path.join(homedir(), '.routecodex', 'auth');

/**
 * 匹配token文件名的正则
 * 格式: <provider>-oauth-<序号>-<alias>.json
 * 例如: iflow-oauth-1-work.json -> provider=iflow, sequence=1, alias=work
 */
const TOKEN_FILE_PATTERN = /^(.+)-oauth-(\d+)(?:-(.+))?\.json$/;

/**
 * 扫描auth目录下指定provider的所有token文件
 */
export async function scanProviderTokenFiles(provider: string): Promise<TokenFileMatch[]> {
  try {
    const entries = await fs.readdir(AUTH_DIR);
    const matches: TokenFileMatch[] = [];

    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue;
      }

      const match = entry.match(TOKEN_FILE_PATTERN);
      if (!match) {
        continue;
      }

      const [, providerPrefix, sequenceStr, alias] = match;
      if (providerPrefix.toLowerCase() !== provider.toLowerCase()) {
        continue;
      }

      const sequence = parseInt(sequenceStr, 10);
      if (isNaN(sequence) || sequence <= 0) {
        continue;
      }

      matches.push({
        filePath: path.join(AUTH_DIR, entry),
        providerPrefix,
        sequence,
        alias: alias || 'default'
      });
    }

    // 按序号排序
    matches.sort((a, b) => a.sequence - b.sequence);

    return matches;
  } catch (error) {
    // 目录不存在或读取失败，返回空列表
    return [];
  }
}

/**
 * 获取指定provider的所有token文件路径（有序）
 */
export async function getProviderTokenFilePaths(provider: string): Promise<string[]> {
  const matches = await scanProviderTokenFiles(provider);
  return matches.map((m) => m.filePath);
}

/**
 * 获取指定provider的token文件信息（用于调试）
 */
export async function getProviderTokenFileInfo(provider: string): Promise<TokenFileMatch[]> {
  return scanProviderTokenFiles(provider);
}

/**
 * 从文件路径提取序号
 * 返回: { sequence: number, alias: string } 或 null
 */
export function parseTokenSequenceFromPath(filePath: string): { sequence: number; alias: string } | null {
  const basename = path.basename(filePath);
  const match = basename.match(TOKEN_FILE_PATTERN);
  if (!match) {
    return null;
  }

  const [, , sequenceStr, alias] = match;
  const sequence = parseInt(sequenceStr, 10);
  if (isNaN(sequence) || sequence <= 0) {
    return null;
  }

  return { sequence, alias: alias || 'default' };
}
