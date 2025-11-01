/**
 * API Key Authentication - API Key认证实现
 *
 * 提供标准的API Key认证功能
 */

import type { IAuthProvider, AuthStatus } from './auth-interface.js';
import type { ApiKeyAuth } from '../api/provider-config.js';

/**
 * API Key认证提供者
 *
 * 实现标准的API Key认证机制
 */
export class ApiKeyAuthProvider implements IAuthProvider {
  readonly type = 'apikey' as const;

  private config: ApiKeyAuth;
  private status: AuthStatus;
  private isInitialized = false;

  constructor(config: ApiKeyAuth) {
    this.config = config;
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
      // 验证API Key格式
      if (!this.config.apiKey || typeof this.config.apiKey !== 'string') {
        throw new Error('Invalid API key: must be a non-empty string');
      }

      // 验证API Key基本格式
      if (this.config.apiKey.length < 10) {
        throw new Error('Invalid API key: too short');
      }

      this.isInitialized = true;
      this.updateStatus(true, true, 'API key validated successfully');
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
      throw new Error('ApiKeyAuthProvider is not initialized');
    }

    const headers: Record<string, string> = {};

    // 支持多种header名称
    const headerName = this.config.headerName || 'Authorization';

    if (headerName.toLowerCase() === 'authorization') {
      // 标准Authorization header
      const prefix = this.config.prefix || 'Bearer';
      headers[headerName] = `${prefix} ${this.config.apiKey}`;
    } else {
      // 自定义header名称
      headers[headerName] = this.config.apiKey;
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
      // 基本验证：检查API key是否仍然有效
      const isValid = this.config.apiKey.length >= 10;

      this.updateStatus(true, isValid, isValid ? 'Credentials validated' : 'Invalid credentials');
      return isValid;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Validation failed';
      this.updateStatus(true, false, errorMessage);
      return false;
    }
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    // 清理API key内存
    this.config.apiKey = '';
    this.isInitialized = false;
    this.updateStatus(false, false, 'Provider cleaned up');
  }

  /**
   * 获取认证状态
   */
  getStatus(): AuthStatus {
    return { ...this.status };
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

  /**
   * 刷新凭证 (API Key认证不支持刷新)
   */
  async refreshCredentials?(): Promise<void> {
    // API Key认证不支持刷新，但可以重新验证
    await this.validateCredentials();
  }

  /**
   * 获取API Key信息（用于调试）
   */
  getApiKeyInfo(): {
    length: number;
    prefix: string;
    hasCustomHeader: boolean;
  } {
    return {
      length: this.config.apiKey.length,
      prefix: this.config.prefix || 'Bearer',
      hasCustomHeader: !!this.config.headerName && this.config.headerName !== 'Authorization'
    };
  }
}