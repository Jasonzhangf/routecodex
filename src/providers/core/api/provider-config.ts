/**
 * Provider V2 配置接口
 *
 * 定义统一的配置接口，确保与V1配置兼容
 */

import type { ModuleConfig } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { ProviderType } from './provider-types.js';

/**
 * 统一Provider配置接口 (与V1 ModuleConfig兼容)
 */
export interface OpenAIStandardConfig extends ModuleConfig {
  /**
   * Provider 模块类型
   *
   * - 'openai-standard'           : 兼容老配置的统一 Provider
   * - 'openai-http-provider'      : OpenAI Chat 协议族专用 HTTP Provider
   * - 'responses-http-provider'   : OpenAI Responses 协议族专用 HTTP Provider
   * - 'anthropic-http-provider'   : Anthropic Messages 协议族专用 HTTP Provider
   *
   * 说明：为了保持 V1 兼容性，旧路径仍使用 'openai-standard'，新装配器会根据
   * providerType 选择具体的 *-http-provider 类型。
   */
  type: 'openai-standard' | 'openai-http-provider' | 'responses-http-provider' | 'anthropic-http-provider' | 'gemini-http-provider' | 'iflow-http-provider' | 'mock-provider';
  config: {
    // 服务类型标识 (必需)
    providerType: ProviderType;
    runtimeKey?: string;
    providerId?: string;

    // 基础配置 (可选，使用预设值)
    baseUrl?: string;
    timeout?: number;
    maxRetries?: number;

    // 认证配置 (必需)
    auth: ApiKeyAuth | OAuthAuth;

    // 服务特定覆盖配置 (可选)
    overrides?: ServiceOverrides;

    // 扩展配置 (可选)
    extensions?: Record<string, unknown>;
  };
}

/**
 * API Key认证配置
 */
export interface ApiKeyAuth {
  type: 'apikey';
  apiKey: string;
  headerName?: string;    // 默认 'Authorization'
  prefix?: string;        // 默认 'Bearer '
}

/**
 * OAuth认证类型
 */
export type OAuthAuthType = 'oauth' | `${string}-oauth`;

/**
 * OAuth认证配置
 */
export interface OAuthAuth {
  type: OAuthAuthType;
  clientId?: string;
  clientSecret?: string;
  tokenUrl?: string;
  deviceCodeUrl?: string;
  scopes?: string[];
  tokenFile?: string;
  refreshUrl?: string;
  pkce?: boolean;          // 启用PKCE (默认false)
  authorizationUrl?: string;
  userInfoUrl?: string;
}

/**
 * 服务特定覆盖配置
 */
export interface ServiceOverrides {
  baseUrl?: string;
  defaultModel?: string;
  headers?: Record<string, string>;
  endpoint?: string;
  timeout?: number;
  maxRetries?: number;
}

/**
 * 认证凭证类型
 */
export type AuthCredentials = ApiKeyAuth | OAuthAuth;

/**
 * 服务预设配置
 */
export interface ServiceProfile {
  defaultBaseUrl: string;
  defaultEndpoint: string;
  defaultModel: string;
  requiredAuth: Array<'apikey' | 'oauth'>;
  optionalAuth: Array<'apikey' | 'oauth'>;
  headers?: Record<string, string>;
  timeout?: number;
  maxRetries?: number;
}

/**
 * 配置验证结果
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}
