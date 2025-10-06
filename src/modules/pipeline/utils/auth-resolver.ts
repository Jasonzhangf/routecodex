/**
 * Auth Resolver Utility
 * 处理auth id到实际路径的解析和token读取
 */

import fs from 'fs/promises';
// import path from 'path';
import { homedir } from 'os';

export class AuthResolver {
  private authMappings: Record<string, string>;
  private tokenCache: Map<string, { token: string; expiry: number }> = new Map();

  constructor(authMappings: Record<string, string> = {}) {
    this.authMappings = authMappings;
  }

  /**
   * 解析auth id获取实际token
   */
  async resolveToken(authId: string): Promise<string> {
    // 检查缓存
    const cached = this.tokenCache.get(authId);
    if (cached && cached.expiry > Date.now()) {
      return cached.token;
    }

    // 如果不是auth id，直接返回
    if (!authId.startsWith('auth-')) {
      return authId;
    }

    // 通过authMappings查找文件路径
    const authPath = this.authMappings[authId];
    if (!authPath) {
      throw new Error(`Auth mapping not found for: ${authId}`);
    }

    // 读取auth文件获取token
    const token = await this.readAuthFile(authPath);

    // 缓存token（5分钟有效期）
    this.tokenCache.set(authId, {
      token,
      expiry: Date.now() + (5 * 60 * 1000)
    });

    return token;
  }

  /**
   * 批量解析tokens
   */
  async resolveTokens(authIds: string[]): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    for (const authId of authIds) {
      try {
        const token = await this.resolveToken(authId);
        results.set(authId, token);
      } catch (error) {
        console.warn(`Failed to resolve auth ${authId}:`, error);
        results.set(authId, authId); // fallback to original id
      }
    }

    return results;
  }

  /**
   * 读取auth文件并提取token
   */
  private async readAuthFile(authPath: string): Promise<string> {
    try {
      // 展开路径中的 ~ 符号
      const expandedPath = authPath.startsWith('~')
        ? authPath.replace('~', homedir())
        : authPath;

      // 读取auth文件
      const fileContent = await fs.readFile(expandedPath, 'utf-8');

      try {
        // 尝试解析为JSON
        const authData = JSON.parse(fileContent);

        // 支持多种token字段名
        const tokenFields = ['token', 'apiKey', 'access_token', 'bearer_token', 'accessToken'];
        for (const field of tokenFields) {
          if (authData[field]) {
            return authData[field];
          }
        }

        // OAuth特殊处理
        if (authData.access_token) {
          return authData.access_token;
        }

        throw new Error(`No valid token found in auth file: ${expandedPath}`);
      } catch (parseError) {
        // 如果不是JSON，直接使用文件内容作为token
        return fileContent.trim();
      }
    } catch (error) {
      throw new Error(`Failed to read auth file ${authPath}: ${error}`);
    }
  }

  /**
   * 清除token缓存
   */
  clearCache(): void {
    this.tokenCache.clear();
  }

  /**
   * 添加auth映射
   */
  addAuthMapping(authId: string, authPath: string): void {
    this.authMappings[authId] = authPath;
    this.clearCache(); // 清除缓存以使用新映射
  }

  /**
   * 批量添加auth映射
   */
  addAuthMappings(authMappings: Record<string, string>): void {
    Object.assign(this.authMappings, authMappings);
    this.clearCache();
  }

  /**
   * 获取auth映射
   */
  getAuthMappings(): Record<string, string> {
    return { ...this.authMappings };
  }
}