/**
 * Provider V2 类型定义
 *
 * 定义与V1版本完全兼容的类型接口
 */

import type { ProviderModule } from '../../../../interfaces/pipeline-interfaces.js';
import type { UnknownObject } from '../../../../../../types/common-types.js';
import type { OpenAIStandardConfig } from './provider-config.js';
import type { ProviderHooks } from '../config/provider-hooks.js';

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
  processIncoming(request: UnknownObject): Promise<unknown>;
  processOutgoing(response: UnknownObject): Promise<UnknownObject>;
}

/**
 * 支持的Provider类型
 * - 'openai'     : OpenAI Chat 兼容族
 * - 'responses'  : OpenAI Responses wire（/v1/responses）
 * - 'anthropic'  : Anthropic Messages wire（/v1/messages）
 * - 其余为具体兼容族（glm/qwen/iflow/lmstudio）
 */
export type ProviderType = 'openai' | 'glm' | 'qwen' | 'iflow' | 'lmstudio' | 'responses' | 'anthropic';

/**
 * 服务类型映射
 */
export const PROVIDER_TYPE_MAP = {
  OPENAI: 'openai',
  GLM: 'glm',
  QWEN: 'qwen',
  IFLOW: 'iflow',
  LMSTUDIO: 'lmstudio',
  RESPONSES: 'responses',
  ANTHROPIC: 'anthropic'
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

/**
 * Provider上下文
 */
export interface ProviderContext {
  requestId: string;
  providerType: ProviderType;
  startTime: number;
  model?: string;
  hasTools?: boolean;
  metadata?: Record<string, unknown>;
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
