/**
 * AuthFile Resolver
 * 处理AuthFile机制的密钥解析
 */

import fs from 'fs/promises';
import { planAuthFileResolutionNativeSync } from '../modules/llmswitch/bridge.js';
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

    const plan = planAuthFileResolutionNativeSync({
      keyId,
      authDir: this.authDir,
    });

    // 如果不是AuthFile，直接返回
    if (plan.kind === 'literal') {
      return plan.value ?? keyId;
    }

    const filePath = plan.filePath;
    const cacheKey = plan.cacheKey ?? keyId;
    if (!filePath) {
      throw new Error('[config] AuthFile native resolver returned empty file path');
    }

    try {
      // 读取密钥文件
      const keyContent = await fs.readFile(filePath, 'utf-8');
      const actualKey = keyContent.trim();

      // 缓存密钥
      this.keyCache.set(cacheKey, actualKey);

      return actualKey;
    } catch (error) {
      throw new Error(`Failed to read auth file ${filePath}: ${error}`);
    }
  }

}
