/**
 * AuthFile Resolver
 * 处理AuthFile机制的密钥解析
 */

import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

export class AuthFileResolver {
  private authDir: string;
  private keyCache: Map<string, string> = new Map();

  constructor(authDir?: string) {
    this.authDir = authDir || path.join(homedir(), '.routecodex', 'auth');
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

  /**
   * 批量解析密钥
   */
  async resolveKeys(keyIds: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    for (const keyId of keyIds) {
      try {
        const actualKey = await this.resolveKey(keyId);
        result.set(keyId, actualKey);
      } catch (error) {
        console.warn(`Failed to resolve key ${keyId}:`, error);
        result.set(keyId, keyId); // 使用原始keyId作为fallback
      }
    }

    return result;
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.keyCache.clear();
  }

  /**
   * 确保Auth目录存在
   */
  async ensureAuthDir(): Promise<void> {
    try {
      await fs.mkdir(this.authDir, { recursive: true });
      console.log(`Auth directory created: ${this.authDir}`);
    } catch (error) {
      // 目录已存在，忽略错误
    }
  }
}
