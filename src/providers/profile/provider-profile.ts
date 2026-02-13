/**
 * Provider profile primitives
 *
 * 提供商配置被标准化为“协议类型 + 传输配置 + 认证配置 + 兼容层列表”。
 * 该层仅关注用户配置的声明式信息，与 runtime profile 解密后的密钥/令牌相区分。
 */

import type { DeepSeekProviderRuntimeOptions } from '../core/contracts/deepseek-provider-contract.js';

export type ProviderProtocol = 'openai' | 'responses' | 'anthropic' | 'gemini' | 'gemini-cli';

export interface ProviderTransportConfig {
  baseUrl?: string;
  endpoint?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * Optional override for OAuth browser activation per provider.
   * When set to 'camoufox', OAuth will prefer Camoufox launcher instead of the system default browser.
   */
  oauthBrowser?: 'camoufox' | 'default';
}

export interface ApiKeyAuthConfig {
  kind: 'apikey';
  /**
   * 直接填入的 API Key（可包含环境变量占位符）
   */
  apiKey?: string;
  /**
   * 指向外部存储（例如 secretRef/env）的引用
   */
  secretRef?: string;
  /**
   * 传统配置中用于表示环境变量名的字段
   */
  env?: string;
  rawType?: string;
  mobile?: string;
  password?: string;
  accountFile?: string;
  accountAlias?: string;
  tokenFile?: string;
}

export interface OAuthAuthConfig {
  kind: 'oauth';
  clientId?: string;
  clientSecret?: string;
  tokenUrl?: string;
  deviceCodeUrl?: string;
  scopes?: string[];
  tokenFile?: string;
  authorizationUrl?: string;
  userInfoUrl?: string;
  refreshUrl?: string;
}

export interface NoAuthConfig {
  kind: 'none';
}

export type ProviderAuthConfig = ApiKeyAuthConfig | OAuthAuthConfig | NoAuthConfig;

export interface ProviderProfile {
  id: string;
  protocol: ProviderProtocol;
  /**
   * Optional module implementation identifier (e.g. 'mock-provider').
   * When present, host/runtime can override the default module selection while
   * keeping the logical provider protocol unchanged.
   */
  moduleType?: string;
  transport: ProviderTransportConfig;
  auth: ProviderAuthConfig;
  compatibilityProfile?: string;
  metadata?: {
    defaultModel?: string;
    supportedModels?: string[];
    deepseek?: Partial<DeepSeekProviderRuntimeOptions>;
  };
}

export interface ProviderProfileCollection {
  profiles: ProviderProfile[];
  byId: Record<string, ProviderProfile>;
}
