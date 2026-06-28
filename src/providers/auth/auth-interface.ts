/**
 * Auth Interface - 认证接口定义
 *
 * 定义统一的 API key 认证接口
 */

import type { ApiKeyAuth } from '../core/api/provider-config.js';

/**
 * 认证提供者接口
 *
 * 统一的 API key 认证接口
 */
export interface IAuthProvider {
  readonly type: 'apikey';

  /**
   * 初始化认证
   */
  initialize(): Promise<void>;

  /**
   * 构建认证头部
   */
  buildHeaders(): Record<string, string>;

  /**
   * 验证凭证
   */
  validateCredentials(): Promise<boolean>;

  /**
   * 刷新凭证 (可选)
   */
  refreshCredentials?(): Promise<void>;

  /**
   * 清理资源
   */
  cleanup(): Promise<void>;

  /**
   * 获取认证状态
   */
  getStatus(): AuthStatus;
}

/**
 * 认证状态
 */
export interface AuthStatus {
  isAuthenticated: boolean;
  isValid: boolean;
  lastValidated: number;
  expiresAt?: number;
  error?: string;
}

/**
 * 认证结果
 */
export interface AuthResult {
  success: boolean;
  headers: Record<string, string>;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * 认证配置
 */
export type AuthConfig = ApiKeyAuth;

/**
 * 认证凭证存储
 */
export interface TokenStorage {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  token_type?: string;
  scope?: string;
  created_at: number;
  updated_at: number;
  metadata?: Record<string, unknown>;
}

/**
 * 认证错误类型
 */
export enum AuthErrorType {
  INVALID_CREDENTIALS = 'invalid_credentials',
  TOKEN_EXPIRED = 'token_expired',
  NETWORK_ERROR = 'network_error',
  CONFIGURATION_ERROR = 'configuration_error',
  UNKNOWN_ERROR = 'unknown_error'
}

/**
 * 认证错误
 */
export interface AuthError extends Error {
  type: AuthErrorType;
  details?: Record<string, unknown>;
  retryable: boolean;
}

/**
 * API Key认证工厂
 */
export interface ApiKeyAuthFactory {
  create(config: ApiKeyAuth): IAuthProvider;
}
