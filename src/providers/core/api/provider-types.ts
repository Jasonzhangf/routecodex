/**
 * Provider V2 类型定义
 *
 * 定义与V1版本完全兼容的类型接口
 */

import type { ProviderModule } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { OpenAIStandardConfig } from './provider-config.js';
import type { ProviderHooks } from '../config/provider-hooks.js';
import type { TargetMetadata } from '../../../modules/pipeline/orchestrator/pipeline-context.js';
import type { ProviderRuntimeMetadata } from '../runtime/provider-runtime-metadata.js';

// Re-export ProviderHooks for external use
export type { ProviderHooks } from '../config/provider-hooks.js';

/**
 * 统一Provider接口 (与V1 ProviderModule完全一致)
 */
export interface IProviderV2 extends ProviderModule {
  readonly id: string;
  readonly type: string;
  readonly providerType: string;
  readonly config: OpenAIStandardConfig;

  // V1兼容方法 - 必须与V1 ProviderModule完全一致
  initialize(): Promise<void>;
  sendRequest(request: UnknownObject): Promise<unknown>; // V1兼容的主要方法
  checkHealth(): Promise<boolean>;
  cleanup(): Promise<void>;

  // V2扩展方法
  processIncoming(request: UnknownObject): Promise<UnknownObject>;
  processOutgoing(response: UnknownObject): Promise<UnknownObject>;
}

/**
 * 支持的Provider协议类型
 * - 'openai'     : OpenAI Chat wire
 * - 'responses'  : OpenAI Responses wire（/v1/responses）
 * - 'anthropic'  : Anthropic Messages wire（/v1/messages）
 * - 'gemini'     : Gemini Chat wire
 * - 'gemini-cli' : Gemini CLI wire (Cloud Code Assist)
 *
 * 注意：品牌/家族（glm、qwen、iflow 等）通过 providerId/providerFamily 表达，禁止写入 providerType。
 */
export type ProviderType = 'openai' | 'responses' | 'anthropic' | 'gemini' | 'gemini-cli' | 'mock';

/**
 * 服务协议类型映射
 */
export const PROVIDER_TYPE_MAP = {
  OPENAI: 'openai',
  RESPONSES: 'responses',
  ANTHROPIC: 'anthropic',
  GEMINI: 'gemini',
  GEMINI_CLI: 'gemini-cli',
  MOCK: 'mock'
} as const;

/**
 * Provider状态枚举
 */
export enum ProviderStatus {
  INITIALIZING = 'initializing',
  READY = 'ready',
  PROCESSING = 'processing',
  ERROR = 'error',
  STOPPED = 'stopped'
}

/**
 * Provider错误类型
 */
export interface ProviderError extends Error {
  type: 'network' | 'server' | 'authentication' | 'validation' | 'unknown';
  statusCode?: number;
  code?: string;
  retryable: boolean;
  details: Record<string, unknown>;
}

/**
 * Provider指标
 */
export interface ProviderMetrics {
  requestCount: number;
  successCount: number;
  errorCount: number;
  averageResponseTime: number;
  lastRequestTime: number;
  timestamp: number;
}

export interface ProviderRuntimeAuth {
  type: 'apikey' | 'oauth';
  value?: string;
  secretRef?: string;
  tokenFile?: string;
  tokenUrl?: string;
  deviceCodeUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  authorizationUrl?: string;
  userInfoUrl?: string;
  refreshUrl?: string;
  oauthProviderId?: string;
  rawType?: string;
}

export interface ProviderRuntimeProfile {
  runtimeKey: string;
  providerId: string;
  providerKey?: string;
  keyAlias?: string;
  providerType: ProviderType;
  providerFamily?: string;
  providerProtocol?: string;
  /**
   * Optional module implementation override (e.g. 'mock-provider').
   * Allows host to keep logical providerType while instantiating a different module.
   */
  providerModule?: string;
  /**
   * Upstream endpoint/base URL emitted by virtual router runtime.
   * When only endpoint is provided, host/provider should treat it as baseUrl.
   */
  endpoint: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  auth: ProviderRuntimeAuth;
  compatibilityProfile?: string;
  outboundProfile?: string;
  defaultModel?: string;
  responsesConfig?: {
    toolCallIdStyle?: string;
    streaming?: 'auto' | 'always' | 'never';
    instructionsMode?: 'default' | 'inline';
  };
}

/**
 * Provider上下文
 */
export interface ProviderContext {
  requestId: string;
  providerType: ProviderType;
  providerFamily?: string;
  startTime: number;
  model?: string;
  hasTools?: boolean;
  metadata?: Record<string, unknown>;
  providerId?: string;
  providerKey?: string;
  providerProtocol?: string;
  routeName?: string;
  target?: TargetMetadata;
  runtimeMetadata?: ProviderRuntimeMetadata;
  pipelineId?: string;
  profile?: ServiceProfile;
}

/**
 * 服务配置档案接口
 */
export interface ServiceProfile {
  defaultBaseUrl: string;
  defaultEndpoint: string;
  defaultModel: string;
  requiredAuth: Array<string>;
  optionalAuth: Array<string>;
  headers?: Record<string, string>;
  timeout?: number;
  maxRetries?: number;

  // Hook系统支持
  hooks?: ProviderHooks;

  // 特殊配置
  features?: {
    supportsBearerToken?: boolean;
    customErrorParsing?: boolean;
    streamingSupport?: boolean;
    customTimeout?: boolean;
  };

  // 扩展配置
  extensions?: Record<string, unknown>;
}
