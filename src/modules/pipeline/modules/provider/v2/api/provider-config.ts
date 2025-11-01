/**
 * Provider V2 配置接口
 *
 * 定义统一的配置接口，确保与V1配置兼容
 */

import type { ModuleConfig } from '../../../../interfaces/pipeline-interfaces.js';
import type { ProviderType } from './provider-types.js';

/**
 * 统一Provider配置接口 (与V1 ModuleConfig兼容)
 */
export interface OpenAIStandardConfig extends ModuleConfig {
  type: 'openai-standard';
  config: {
    // 服务类型标识 (必需)
    providerType: ProviderType;

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
 * OAuth认证配置
 */
export interface OAuthAuth {
  type: 'oauth';
  clientId: string;
  clientSecret?: string;
  tokenUrl: string;
  deviceCodeUrl?: string;
  scopes?: string[];
  tokenFile?: string;
  refreshUrl?: string;
  pkce?: boolean;          // 启用PKCE (默认false)
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

/**
 * 配置映射表 (V1到V2的映射)
 */
export const CONFIG_MAPPINGS = {
  // V1类型 -> V2类型
  'glm-http-provider': 'openai-standard',
  'qwen-provider': 'openai-standard',
  'openai-provider': 'openai-standard',
  'iflow-provider': 'openai-standard',
  'lmstudio-provider-simple': 'openai-standard',
  'generic-http-provider': 'openai-standard',
  'generic-responses': 'openai-standard'
} as const;

/**
 * V1配置转换器
 */
export interface ConfigTransformer {
  transformV1ToV2(v1Config: ModuleConfig): OpenAIStandardConfig;
  transformV2ToV1(v2Config: OpenAIStandardConfig): ModuleConfig;
  validateV2Config(config: OpenAIStandardConfig): ValidationResult;
}