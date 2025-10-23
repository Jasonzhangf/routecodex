/**
 * Provider Module - Type Definitions
 *
 * Type definitions for provider implementations, authentication, and related functionality.
 */

import type { BaseProviderConfig } from './base-types.js';
import type { ModuleConfig } from '../interfaces/pipeline-interfaces.js';

/**
 * Provider configuration interface
 */
export interface ProviderConfig extends BaseProviderConfig {}

/**
 * Provider type variants
 */
export type ProviderType = 'openai' | 'qwen' | 'anthropic' | 'cohere' | 'custom';

/**
 * Authentication type variants
 */
export type AuthType = 'apikey' | 'oauth' | 'bearer' | 'basic' | 'custom';

/**
 * Provider configuration variants
 */
export type ProviderConfigVariant =
  | OpenAIProviderConfig
  | QwenProviderConfig
  | AnthropicProviderConfig
  | CohereProviderConfig
  | CustomProviderConfig;

/**
 * OpenAI provider configuration
 */
export interface OpenAIProviderConfig extends ProviderConfig {
  type: 'openai';
  baseUrl: string;
  auth: {
    type: 'apikey';
    apiKey: string;
  };
  models: Record<string, OpenAIModelConfig>;
  compatibility?: OpenAICompatibilityConfig;
}

/**
 * Qwen provider configuration
 */
export interface QwenProviderConfig extends ProviderConfig {
  type: 'qwen';
  baseUrl: string;
  auth: {
    type: 'apikey';
    apiKey: string;
  };
  models: Record<string, QwenModelConfig>;
  compatibility?: QwenCompatibilityConfig;
}

/**
 * Anthropic provider configuration
 */
export interface AnthropicProviderConfig extends ProviderConfig {
  type: 'anthropic';
  baseUrl: string;
  auth: {
    type: 'apikey';
    apiKey: string;
  };
  models: Record<string, AnthropicModelConfig>;
  compatibility?: AnthropicCompatibilityConfig;
}

/**
 * Cohere provider configuration
 */
export interface CohereProviderConfig extends ProviderConfig {
  type: 'cohere';
  baseUrl: string;
  auth: {
    type: 'apikey';
    apiKey: string;
  };
  models: Record<string, CohereModelConfig>;
  compatibility?: CohereCompatibilityConfig;
}

/**
 * Custom provider configuration
 */
export interface CustomProviderConfig extends ProviderConfig {
  type: 'custom';
  baseUrl: string;
  auth: AuthConfig;
  models: Record<string, CustomModelConfig>;
  compatibility?: CustomCompatibilityConfig;
  customSettings?: Record<string, any>;
}

/**
 * Authentication configuration variants
 */
export type AuthConfig =
  | APIKeyAuthConfig
  | OAuthAuthConfig
  | BearerAuthConfig
  | BasicAuthConfig
  | CustomAuthConfig;

/**
 * API key authentication configuration
 */
export interface APIKeyAuthConfig {
  type: 'apikey';
  apiKey: string;
  headerName?: string;
  queryParam?: string;
  prefix?: string;
}

/**
 * OAuth authentication configuration
 */
export interface OAuthAuthConfig {
  type: 'oauth';
  clientId: string;
  clientSecret?: string;
  tokenUrl: string;
  deviceCodeUrl?: string;
  scopes?: string[];
  redirectUri?: string;
  tokenFile?: string;
  refreshBuffer?: number; // milliseconds before token expires
}

/**
 * Bearer token authentication configuration
 */
export interface BearerAuthConfig {
  type: 'bearer';
  token: string;
  refreshUrl?: string;
  refreshBuffer?: number;
}

/**
 * Basic authentication configuration
 */
export interface BasicAuthConfig {
  type: 'basic';
  username: string;
  password: string;
}

/**
 * Custom authentication configuration
 */
export interface CustomAuthConfig {
  type: 'custom';
  implementation: string; // path to custom auth implementation
  config: Record<string, any>;
}

/**
 * Model configuration interface
 */
export interface BaseModelConfig {
  id: string;
  name: string;
  description?: string;
  maxTokens: number;
  supportsStreaming: boolean;
  supportsFunctions: boolean;
  supportsVision: boolean;
  parameters: Record<string, any>;
  pricing?: {
    input: number; // per 1k tokens
    output: number; // per 1k tokens
  };
}

/**
 * OpenAI model configuration
 */
export interface OpenAIModelConfig extends BaseModelConfig {
  type: 'gpt-3.5-turbo' | 'gpt-4' | 'gpt-4-turbo' | 'gpt-4o' | 'custom';
  contextLength: number;
  trainingData?: string;
}

/**
 * Qwen model configuration
 */
export interface QwenModelConfig extends BaseModelConfig {
  type: 'qwen-turbo' | 'qwen-plus' | 'qwen-max' | 'qwen-coder' | 'custom';
  contextLength: number;
  version?: string;
}

/**
 * Anthropic model configuration
 */
export interface AnthropicModelConfig extends BaseModelConfig {
  type: 'claude-3-opus' | 'claude-3-sonnet' | 'claude-3-haiku' | 'custom';
  contextLength: number;
  maxOutputTokens: number;
}

/**
 * Cohere model configuration
 */
export interface CohereModelConfig extends BaseModelConfig {
  type: 'command' | 'command-light' | 'command-r' | 'command-r-plus' | 'custom';
  contextLength: number;
  connectors?: string[];
}

/**
 * Custom model configuration
 */
export interface CustomModelConfig extends BaseModelConfig {
  type: 'custom';
  customParameters: Record<string, any>;
}

/**
 * Compatibility configuration interface
 */
export interface BaseCompatibilityConfig {
  enabled: boolean;
  requestMappings?: any[];
  responseMappings?: any[];
  toolAdaptation?: boolean;
  streamingAdaptation?: boolean;
}

/**
 * OpenAI compatibility configuration
 */
export interface OpenAICompatibilityConfig extends BaseCompatibilityConfig {
  targetProtocol: 'openai' | 'custom';
  modelMapping?: Record<string, string>;
  parameterMapping?: Record<string, string>;
}

/**
 * Qwen compatibility configuration
 */
export interface QwenCompatibilityConfig extends BaseCompatibilityConfig {
  targetProtocol: 'openai' | 'qwen' | 'custom';
  modelMapping?: Record<string, string>;
  toolFormat?: 'openai' | 'qwen' | 'custom';
}

/**
 * Anthropic compatibility configuration
 */
export interface AnthropicCompatibilityConfig extends BaseCompatibilityConfig {
  targetProtocol: 'anthropic' | 'openai' | 'custom';
  modelMapping?: Record<string, string>;
  messageFormat?: 'anthropic' | 'openai' | 'custom';
}

/**
 * Cohere compatibility configuration
 */
export interface CohereCompatibilityConfig extends BaseCompatibilityConfig {
  targetProtocol: 'cohere' | 'openai' | 'custom';
  modelMapping?: Record<string, string>;
  connectorMapping?: Record<string, string>;
}

/**
 * Custom compatibility configuration
 */
export interface CustomCompatibilityConfig extends BaseCompatibilityConfig {
  targetProtocol: string;
  customMappings?: Record<string, any>;
}

/**
 * Provider authentication context
 */
export interface AuthContext {
  type: AuthType;
  token?: string;
  expiresAt?: number;
  refreshToken?: string;
  credentials: Record<string, any>;
  metadata?: Record<string, any>;
}

/**
 * Provider health status
 */
export type ProviderHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

/**
 * Provider health check result
 */
export interface ProviderHealthCheck {
  status: ProviderHealthStatus;
  timestamp: number;
  responseTime: number;
  details?: {
    authentication: 'valid' | 'invalid' | 'expired';
    connectivity: 'connected' | 'disconnected' | 'timeout';
    rateLimit?: {
      remaining: number;
      resetTime: number;
    };
    errors?: string[];
  };
}

/**
 * Provider request options
 */
export interface ProviderRequestOptions {
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  headers?: Record<string, string>;
  stream?: boolean;
}

/**
 * Provider response interface
 */
export interface ProviderResponse {
  data: any;
  status: number;
  headers: Record<string, string>;
  metadata?: {
    requestId: string;
    processingTime: number;
    tokensUsed?: number;
    model: string;
  };
  tool_calls?: any[];
}

/**
 * Provider error interface
 */
export interface ProviderError extends Error {
  type: 'authentication' | 'rate_limit' | 'timeout' | 'network' | 'validation' | 'server' | 'unknown';
  statusCode?: number;
  details?: Record<string, any>;
  retryable: boolean;
}

/**
 * Provider metrics interface
 */
export interface ProviderMetrics {
  requestCount: number;
  successCount: number;
  errorCount: number;
  averageResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  tokensUsed: {
    input: number;
    output: number;
  };
  cost?: number;
  timestamp: number;
}

/**
 * Provider statistics interface
 */
export interface ProviderStatistics {
  uptime: number;
  totalRequests: number;
  successRate: number;
  errorRate: number;
  averageResponseTime: number;
  lastHealthCheck: ProviderHealthCheck;
  currentMetrics: ProviderMetrics;
  historicalMetrics: ProviderMetrics[];
}

/**
 * Provider rate limit information
 */
export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetTime: number;
  retryAfter?: number;
}

/**
 * Provider capabilities interface
 */
export interface ProviderCapabilities {
  streaming: boolean;
  functions: boolean;
  vision: boolean;
  embeddings: boolean;
  fineTuning: boolean;
  batch: boolean;
  moderation: boolean;
}

/**
 * Provider status interface
 */
export interface ProviderStatus {
  /** Provider identifier */
  id: string;
  /** Provider type */
  type: string;
  /** Current status */
  status: 'online' | 'offline' | 'maintenance' | 'error';
  /** Health check timestamp */
  lastHealthCheck: number;
  /** Response time in milliseconds */
  responseTime: number;
  /** Error message if status is error */
  error?: string;
  /** Additional status information */
  metadata?: Record<string, any>;
}

/**
 * Provider module configuration
 */
export interface ProviderModuleConfig extends ModuleConfig {
  type: ProviderType;
  config: ProviderConfigVariant;
  healthCheck?: {
    enabled: boolean;
    interval: number;
    timeout: number;
  };
  metrics?: {
    enabled: boolean;
    interval: number;
    retention: number;
  };
}

/**
 * Provider context interface
 */
export interface ProviderContext {
  requestId: string;
  timestamp: number;
  auth: AuthContext;
  options: ProviderRequestOptions;
  metadata: Record<string, any>;
}

/**
 * Provider event types
 */
export type ProviderEventType =
  | 'request-started'
  | 'request-completed'
  | 'request-failed'
  | 'auth-refreshed'
  | 'health-check'
  | 'rate-limit-hit'
  | 'error-occurred';

/**
 * Provider event interface
 */
export interface ProviderEvent<T = any> {
  type: ProviderEventType;
  timestamp: number;
  providerId: string;
  data: T;
  metadata?: Record<string, any>;
}

/**
 * Provider event handler
 */
export type ProviderEventHandler<T = any> = (event: ProviderEvent<T>) => void | Promise<void>;

/**
 * Provider interface
 */
export interface Provider {
  /** Provider identifier */
  readonly id: string;
  /** Provider type */
  readonly type: ProviderType;
  /** Provider capabilities */
  readonly capabilities: ProviderCapabilities;

  /**
   * Initialize provider
   */
  initialize(): Promise<void>;

  /**
   * Send request to provider
   */
  sendRequest(request: any, options?: ProviderRequestOptions): Promise<ProviderResponse>;

  /**
   * Check provider health
   */
  checkHealth(): Promise<ProviderHealthCheck>;

  /**
   * Get provider metrics
   */
  getMetrics(): Promise<ProviderMetrics>;

  /**
   * Get provider statistics
   */
  getStatistics(): Promise<ProviderStatistics>;

  /**
   * Refresh authentication
   */
  refreshAuth(): Promise<boolean>;

  /**
   * Cleanup resources
   */
  cleanup(): Promise<void>;
}