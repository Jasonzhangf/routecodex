/**
 * Provider Module - Type Definitions
 *
 * Type definitions for provider implementations, authentication, and related functionality.
 */

import type { ModuleConfig } from '../interfaces/pipeline-interfaces.js';
import type { JsonValue, UnknownObject } from '../../../types/common-types.js';
import type { AuthType, ProviderConfigVariant, ProviderType } from './provider-config-types.js';

export * from './provider-config-types.js';

/**
 * Provider authentication context
 */
export interface AuthContext {
  type: AuthType;
  token?: string;
  expiresAt?: number;
  refreshToken?: string;
  credentials: Record<string, unknown>;
  metadata?: Record<string, unknown>;
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
  data: UnknownObject | JsonValue;
  status: number;
  headers: Record<string, string>;
  metadata?: {
    requestId: string;
    processingTime: number;
    tokensUsed?: number;
    model: string;
  };
  tool_calls?: UnknownObject[];
}

/**
 * Provider error interface
 */
export interface ProviderError extends Error {
  type: 'authentication' | 'rate_limit' | 'timeout' | 'network' | 'validation' | 'server' | 'unknown';
  statusCode?: number;
  details?: Record<string, unknown>;
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
  metadata?: Record<string, unknown>;
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
  metadata: Record<string, unknown>;
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
export interface ProviderEvent<T = UnknownObject> {
  type: ProviderEventType;
  timestamp: number;
  providerId: string;
  data: T;
  metadata?: Record<string, unknown>;
}

/**
 * Provider event handler
 */
export type ProviderEventHandler<T = UnknownObject> = (event: ProviderEvent<T>) => void | Promise<void>;

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
  sendRequest(request: UnknownObject, options?: ProviderRequestOptions): Promise<ProviderResponse>;

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
