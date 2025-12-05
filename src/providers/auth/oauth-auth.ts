/**
 * OAuth Authentication - OAuth认证实现
 *
 * 提供标准的OAuth 2.0认证功能，支持设备流和授权码流程
 */

import type { IAuthProvider, AuthStatus, IOAuthClient, TokenStorage } from './auth-interface.js';
import fs from 'fs/promises';
import path from 'path';
import type { OAuthAuth } from '../core/api/provider-config.js';
import type { UnknownObject } from '../../modules/pipeline/types/common-types.js';

type ExtendedOAuthAuth = OAuthAuth & {
  tokenFile?: string;
  authorizationUrl?: string;
  userInfoUrl?: string;
  redirectUri?: string;
};

type StoredOAuthToken = UnknownObject & {
  access_token?: string;
  api_key?: string;
  apiKey?: string;
  refresh_token?: string;
  expires_at?: number | string;
  expired?: number | string;
  expiry_date?: number | string;
};


/**
 * 基础OAuth认证提供者
 *
 * 实现标准的OAuth 2.0认证机制
 */
export class OAuthAuthProvider implements IAuthProvider {
  readonly type = 'oauth' as const;

  private config: OAuthAuth;
  private oauthClient: IOAuthClient;
  private status: AuthStatus;
  private isInitialized = false;

  constructor(config: OAuthAuth, providerType: string) {
    this.config = config;
    this.oauthClient = this.createOAuthClient(providerType);
    this.status = {
      isAuthenticated: false,
      isValid: false,
      lastValidated: 0,
      error: undefined
    };
  }

  /**
   * 初始化认证
   */
  async initialize(): Promise<void> {
    try {
      // 验证OAuth配置
      this.validateOAuthConfig();

      // 初始化OAuth客户端
      await this.oauthClient.initialize();

      // 尝试加载已保存的token
      const savedToken = await this.oauthClient.loadToken();

      if (savedToken && this.isTokenValid(savedToken)) {
        this.updateStatus(true, true, 'OAuth initialized with saved token');
      } else {
        this.updateStatus(false, false, 'No valid token found, OAuth flow required');
      }

      this.isInitialized = true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.updateStatus(false, false, errorMessage);
      throw error;
    }
  }

  /**
   * 构建认证头部
   */
  buildHeaders(): Record<string, string> {
    if (!this.isInitialized) {
      throw new Error('OAuthAuthProvider is not initialized');
    }

    const tokenStorage = this.oauthClient.getToken();
    if (!tokenStorage || !this.isTokenValid(tokenStorage)) {
      throw new Error('No valid OAuth token available');
    }

    // iFlow 等服务在 userInfo 返回 apiKey 时，优先使用 apiKey 作为 Bearer
    const extendedToken = tokenStorage as unknown as StoredOAuthToken;
    const bearer = extractApiKey(extendedToken) || String(tokenStorage.access_token);
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${bearer}`
    };

    // 添加OAuth特定的头部
    if (tokenStorage.token_type) {
      headers['Token-Type'] = tokenStorage.token_type;
    }

    return headers;
  }

  /**
   * 验证凭证
   */
  async validateCredentials(): Promise<boolean> {
    if (!this.isInitialized) {
      return false;
    }

    try {
      const tokenStorage = this.oauthClient.getToken();

      if (!tokenStorage) {
        this.updateStatus(true, false, 'No OAuth token available');
        return false;
      }

      // 检查token是否过期
      if (this.isTokenExpired(tokenStorage)) {
        // 尝试刷新token
        if (tokenStorage.refresh_token) {
          try {
            await this.refreshCredentials();
            this.updateStatus(true, true, 'Token refreshed successfully');
            return true;
          } catch (error) {
            this.updateStatus(true, false, 'Token refresh failed');
            return false;
          }
        } else {
          this.updateStatus(true, false, 'Token expired and no refresh token available');
          return false;
        }
      }

      this.updateStatus(true, true, 'OAuth token validated');
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Validation failed';
      this.updateStatus(true, false, errorMessage);
      return false;
    }
  }

  /**
   * 刷新凭证
   */
  async refreshCredentials(): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('OAuthAuthProvider is not initialized');
    }

    const tokenStorage = this.oauthClient.getToken();
    if (!tokenStorage?.refresh_token) {
      throw new Error('No refresh token available');
    }

    try {
      const newTokenStorage = await this.oauthClient.refreshToken(tokenStorage.refresh_token);
      await this.oauthClient.saveToken(newTokenStorage);
      this.updateStatus(true, true, 'OAuth token refreshed successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Token refresh failed';
      this.updateStatus(false, false, errorMessage);
      throw error;
    }
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    try {
      await this.oauthClient.saveToken(null);
      this.isInitialized = false;
      this.updateStatus(false, false, 'OAuth provider cleaned up');
    } catch (error) {
      console.warn('Error during OAuth cleanup:', error);
    }
  }

  /**
   * 获取认证状态
   */
  getStatus(): AuthStatus {
    return { ...this.status };
  }

  /**
   * 完成OAuth流程
   */
  async completeOAuthFlow(): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('OAuthAuthProvider is not initialized');
    }

    try {
      const tokenStorage = await this.oauthClient.completeOAuthFlow();
      await this.oauthClient.saveToken(tokenStorage);
      this.updateStatus(true, true, 'OAuth flow completed successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'OAuth flow failed';
      this.updateStatus(false, false, errorMessage);
      throw error;
    }
  }

  /**
   * 获取OAuth客户端
   */
  getOAuthClient(): IOAuthClient {
    return this.oauthClient;
  }

  /**
   * 创建OAuth客户端（需要子类实现）
   */
  private createOAuthClient(providerType: string): IOAuthClient {
    // 基础实现，实际应该根据providerType创建对应的客户端
    return new BaseOAuthClient(this.config, providerType);
  }

  /**
   * 验证OAuth配置
   */
  private validateOAuthConfig(): void {
    if (!this.config.clientId) {
      throw new Error('OAuth client ID is required');
    }

    // 放宽校验：若提供了 tokenFile（预先获取的令牌），允许缺失 clientSecret
    // 真实授权码/交换流程在策略层实现；此处只负责读取并使用现有令牌。
    if (!this.config.clientSecret && !this.config.tokenUrl) {
      throw new Error('OAuth token URL is required');
    }

    if (!this.config.tokenUrl) {
      throw new Error('OAuth token URL is required');
    }
  }

  /**
   * 检查token是否有效
   */
  private isTokenValid(token: TokenStorage): boolean {
    if (!token || !token.access_token) {
      return false;
    }

    return !this.isTokenExpired(token);
  }

  /**
   * 检查token是否过期
   */
  private isTokenExpired(token: TokenStorage): boolean {
    if (!token.expires_at) {
      return false; // 如果没有过期时间，假设不过期
    }

    // 提前5分钟过期以确保安全
    const expirationBuffer = 5 * 60 * 1000; // 5分钟
    return Date.now() >= (token.expires_at - expirationBuffer);
  }

  /**
   * 更新认证状态
   */
  private updateStatus(isAuthenticated: boolean, isValid: boolean, message?: string): void {
    this.status = {
      isAuthenticated,
      isValid,
      lastValidated: Date.now(),
      error: isValid ? undefined : message
    };
  }
}

/**
 * 基础OAuth客户端实现
 */
class BaseOAuthClient implements IOAuthClient {
  private config: ExtendedOAuthAuth;
  private providerType: string;
  private currentToken: TokenStorage | null = null;
  private tokenFilePath: string | null = null;

  constructor(config: OAuthAuth, providerType: string) {
    this.config = config as ExtendedOAuthAuth;
    this.providerType = providerType;
    const tf = typeof this.config.tokenFile === 'string' ? this.config.tokenFile : undefined;
    if (tf && tf.trim()) {
      this.tokenFilePath = tf.replace(/^~\//, `${process.env.HOME || ''}/`);
    } else {
      // default path: ~/.routecodex/tokens/<providerType>-default.json
      const home = process.env.HOME || '';
      this.tokenFilePath = path.join(home, '.routecodex', 'tokens', `${this.providerType}-default.json`);
      // write back to config for downstream users if needed
      this.config.tokenFile = this.tokenFilePath;
    }
  }

  async initialize(): Promise<void> {
    // 基础实现
  }

  async getAccessToken(): Promise<string> {
    if (!this.currentToken) {
      throw new Error('No access token available');
    }
    return this.currentToken.access_token;
  }

  async refreshToken(_refreshToken: string): Promise<TokenStorage> {
    // 基础实现，需要根据具体OAuth服务器实现
    throw new Error('Refresh token not implemented for base OAuth client');
  }

  async completeOAuthFlow(): Promise<TokenStorage> {
    // 基础实现，需要根据具体OAuth流程实现
    throw new Error('OAuth flow not implemented for base OAuth client');
  }

  async saveToken(token: TokenStorage | null): Promise<void> {
    this.currentToken = token;
    // 持久化到 tokenFile（若配置提供）
    try {
      if (this.tokenFilePath && token) {
        const dir = path.dirname(this.tokenFilePath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(this.tokenFilePath, JSON.stringify(token, null, 2), 'utf-8');
        console.log(`[OAuth] Token saved to: ${this.tokenFilePath}`);
      }
    } catch { /* ignore persistence errors */ }
  }

  getToken(): TokenStorage | null {
    return this.currentToken;
  }

  async loadToken(): Promise<TokenStorage | null> {
    // 优先从配置的 tokenFile 读取
    if (this.tokenFilePath) {
      try {
        const txt = await fs.readFile(this.tokenFilePath, 'utf-8');
        const j = JSON.parse(txt) as TokenStorage;
        this.currentToken = j;
        console.log(`[OAuth] Token loaded from: ${this.tokenFilePath}`);
        return j;
      } catch {
        // fallthrough to memory
      }
    }
    return this.currentToken;
  }

  updateTokenStorage(storage: TokenStorage, tokenData: unknown): void {
    // 更新token存储
    Object.assign(storage, tokenData);
  }
}

function extractApiKey(token: StoredOAuthToken | null): string {
  if (!token) {
    return '';
  }
  const candidate = typeof token.apiKey === 'string' ? token.apiKey : token.api_key;
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    return trimmed.length ? trimmed : '';
  }
  return '';
}
