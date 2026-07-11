/**
 * AuthFile Resolver
 * 处理AuthFile机制的密钥解析
 */

import { resolveAuthFileKeyNativeSync } from '../modules/llmswitch/bridge/config-integrations.js';
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

    const resolved = resolveAuthFileKeyNativeSync({
      keyId,
      authDir: this.authDir,
    });

    // 如果不是AuthFile，直接返回
    if (resolved.kind === 'literal') {
      return resolved.value;
    }

    const cacheKey = resolved.cacheKey ?? keyId;

    // 缓存密钥
    this.keyCache.set(cacheKey, resolved.value);

    return resolved.value;
  }

}
