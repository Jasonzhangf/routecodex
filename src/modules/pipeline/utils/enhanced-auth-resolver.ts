/**
 * Enhanced Auth Resolver with OAuth Support
 * 增强版认证解析器 - 支持OAuth和自动刷新
 */

import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

/**
 * OAuth Token Response
 */
interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
  created_at?: number;
}

/**
 * OAuth Configuration
 */
interface OAuthConfig {
  clientId: string;
  deviceCodeUrl: string;
  tokenUrl: string;
  scopes: string[];
  tokenFile?: string;
}

/**
 * Authentication Configuration
 */
interface AuthConfig {
  type: 'oauth' | 'apikey' | 'static';
  oauth?: OAuthConfig;
  apiKey?: string;
  tokenFile?: string;
}

export class EnhancedAuthResolver {
  private authMappings: Record<string, string>;
  private tokenCache: Map<string, { token: string; expiry: number; refreshData?: OAuthTokenResponse }>;
  private tokenRefreshTimers: Map<string, NodeJS.Timeout>;
  private oauthConfigs: Map<string, OAuthConfig>;

  constructor(authMappings: Record<string, string> = {}) {
    this.authMappings = authMappings;
    this.tokenCache = new Map();
    this.tokenRefreshTimers = new Map();
    this.oauthConfigs = new Map();
  }

  /**
   * 解析auth id获取实际token，支持OAuth自动刷新
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
    const token = await this.readAuthFile(authId, authPath);

    return token;
  }

  /**
   * 读取auth文件并提取token，支持OAuth自动刷新
   */
  private async readAuthFile(authId: string, authPath: string): Promise<string> {
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

        // 检查是否是OAuth token
        if (authData.access_token) {
          // 处理OAuth token
          return await this.handleOAuthToken(authId, authData, expandedPath);
        }

        // 支持多种token字段名
        const tokenFields = ['token', 'apiKey', 'bearer_token', 'accessToken'];
        for (const field of tokenFields) {
          if (authData[field]) {
            const token = authData[field];
            // 缓存token（5分钟有效期）
            this.tokenCache.set(authId, {
              token,
              expiry: Date.now() + (5 * 60 * 1000)
            });
            return token;
          }
        }

        throw new Error(`No valid token found in auth file: ${expandedPath}`);
      } catch (parseError) {
        // 如果不是JSON，直接使用文件内容作为token
        const token = fileContent.trim();
        this.tokenCache.set(authId, {
          token,
          expiry: Date.now() + (5 * 60 * 1000)
        });
        return token;
      }
    } catch (error) {
      throw new Error(`Failed to read auth file ${authPath}: ${error}`);
    }
  }

  /**
   * 处理OAuth token，包括自动刷新
   */
  private async handleOAuthToken(authId: string, tokenData: OAuthTokenResponse, tokenPath: string): Promise<string> {
    // 检查token是否过期
    const now = Date.now();
    const createdAt = tokenData.created_at || now;
    const expiresAt = createdAt + (tokenData.expires_in * 1000);

    // 如果token即将过期（5分钟内），尝试刷新
    if (expiresAt <= now + (5 * 60 * 1000)) {
      if (tokenData.refresh_token) {
        try {
          const refreshedToken = await this.refreshOAuthToken(authId, tokenData.refresh_token, tokenPath);
          return refreshedToken;
        } catch (refreshError) {
          console.warn(`Failed to refresh OAuth token for ${authId}:`, refreshError);
          // 继续使用现有token，但标记为即将过期
        }
      } else {
        console.warn(`OAuth token for ${authId} is about to expire but no refresh token available`);
      }
    }

    // 设置自动刷新定时器
    this.setupAutoRefresh(authId, tokenData, tokenPath);

    // 缓存token
    this.tokenCache.set(authId, {
      token: tokenData.access_token,
      expiry: Math.min(expiresAt, now + (5 * 60 * 1000)), // 缓存不超过5分钟
      refreshData: tokenData
    });

    return tokenData.access_token;
  }

  /**
   * 刷新OAuth token
   */
  private async refreshOAuthToken(authId: string, refreshToken: string, tokenPath: string): Promise<string> {
    const oauthConfig = this.oauthConfigs.get(authId);
    if (!oauthConfig) {
      throw new Error(`OAuth configuration not found for: ${authId}`);
    }

    console.log(`Refreshing OAuth token for ${authId}...`);

    try {
      const response = await fetch(oauthConfig.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: oauthConfig.clientId,
          refresh_token: refreshToken
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to refresh token: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const newTokenData = await response.json() as OAuthTokenResponse;

      // 添加created_at时间戳
      newTokenData.created_at = Date.now();

      // 保存到文件
      await this.saveOAuthToken(tokenPath, newTokenData);

      // 重新设置自动刷新
      this.setupAutoRefresh(authId, newTokenData, tokenPath);

      // 更新缓存
      const expiry = Date.now() + (newTokenData.expires_in * 1000);
      this.tokenCache.set(authId, {
        token: newTokenData.access_token,
        expiry: Math.min(expiry, Date.now() + (5 * 60 * 1000)),
        refreshData: newTokenData
      });

      console.log(`OAuth token refreshed successfully for ${authId}`);
      return newTokenData.access_token;

    } catch (error) {
      console.error(`OAuth token refresh failed for ${authId}:`, error);
      throw error;
    }
  }

  /**
   * 保存OAuth token到文件
   */
  private async saveOAuthToken(tokenPath: string, tokenData: OAuthTokenResponse): Promise<void> {
    try {
      const tokenDir = path.dirname(tokenPath);
      await fs.mkdir(tokenDir, { recursive: true });
      await fs.writeFile(tokenPath, JSON.stringify(tokenData, null, 2));
    } catch (error) {
      console.error(`Failed to save OAuth token to ${tokenPath}:`, error);
      throw error;
    }
  }

  /**
   * 设置自动刷新定时器
   */
  private setupAutoRefresh(authId: string, tokenData: OAuthTokenResponse, tokenPath: string): void {
    // 清除现有的定时器
    const existingTimer = this.tokenRefreshTimers.get(authId);
    if (existingTimer) {
      clearInterval(existingTimer);
      this.tokenRefreshTimers.delete(authId);
    }

    // 如果没有refresh_token，无法自动刷新
    if (!tokenData.refresh_token) {
      return;
    }

    // 在过期前5分钟刷新
    const now = Date.now();
    const createdAt = tokenData.created_at || now;
    const expiresAt = createdAt + (tokenData.expires_in * 1000);
    const refreshDelay = Math.max(0, expiresAt - now - (5 * 60 * 1000));

    // 设置刷新定时器
    const timer = setTimeout(async () => {
      try {
        await this.refreshOAuthToken(authId, tokenData.refresh_token!, tokenPath);
      } catch (error) {
        console.error(`Auto-refresh failed for ${authId}:`, error);
        // 可以在这里添加重试逻辑或通知机制
      }
    }, refreshDelay);

    this.tokenRefreshTimers.set(authId, timer);

    console.log(`Auto-refresh scheduled for ${authId} in ${Math.round(refreshDelay / 1000)} seconds`);
  }

  /**
   * 添加OAuth配置
   */
  addOAuthConfig(authId: string, oauthConfig: OAuthConfig): void {
    this.oauthConfigs.set(authId, oauthConfig);
    // 清除相关缓存以使用新配置
    this.tokenCache.delete(authId);
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
   * 清除token缓存
   */
  clearCache(): void {
    this.tokenCache.clear();

    // 清除所有定时器
    for (const timer of this.tokenRefreshTimers.values()) {
      clearTimeout(timer);
    }
    this.tokenRefreshTimers.clear();
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

  /**
   * 获取token状态
   */
  getTokenStatus(authId: string): {
    isValid: boolean;
    isExpired: boolean;
    needsRefresh: boolean;
    expiresAt: Date;
    timeToExpiry: number;
  } {
    const cached = this.tokenCache.get(authId);

    if (!cached || !cached.refreshData) {
      return {
        isValid: false,
        isExpired: true,
        needsRefresh: false,
        expiresAt: new Date(Date.now()),
        timeToExpiry: 0
      };
    }

    const now = Date.now();
    const createdAt = cached.refreshData.created_at || now;
    const expiresAt = createdAt + (cached.refreshData.expires_in * 1000);
    const isExpired = expiresAt <= now;

    return {
      isValid: !isExpired,
      isExpired,
      needsRefresh: expiresAt <= now + (5 * 60 * 1000),
      expiresAt: new Date(expiresAt),
      timeToExpiry: isExpired ? 0 : expiresAt - now
    };
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    this.clearCache();
  }
}
