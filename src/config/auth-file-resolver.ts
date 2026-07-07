/**
 * AuthFile Resolver
 * 处理AuthFile机制的密钥解析
 */

import fs from 'fs/promises';
import path from 'path';
import { resolveRccAuthDir } from './user-data-paths.js';

export class AuthFileResolver {
  private authDir: string;
  private keyCache: Map<string, string> = new Map();

  constructor(authDir?: string) {
    this.authDir = authDir || resolveRccAuthDir();
  }

  /**
   * 解析密钥
   */
  async resolveKey(keyId: string): Promise<string> {
    // 检查缓存
    if (this.keyCache.has(keyId)) {
      return this.keyCache.get(keyId)!;
    }

    // 如果不是AuthFile，直接返回
    if (!keyId.startsWith('authfile-')) {
      return keyId;
    }

    // 解析AuthFile
    const filename = keyId.replace('authfile-', '');
    const filePath = path.join(this.authDir, filename);

    try {
      // 读取密钥文件
      const keyContent = await fs.readFile(filePath, 'utf-8');
      const actualKey = keyContent.trim();

      // 缓存密钥
      this.keyCache.set(keyId, actualKey);

      return actualKey;
    } catch (error) {
      throw new Error(`Failed to read auth file ${filePath}: ${error}`);
    }
  }

}
