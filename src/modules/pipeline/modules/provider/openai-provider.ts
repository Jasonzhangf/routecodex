/**
 * OpenAI Provider Implementation
 *
 * Provides a standard OpenAI-compatible provider using the official OpenAI SDK.
 * Supports chat completions, function calling, and streaming responses.
 */

import type { ProviderModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { ProviderConfig, AuthContext, ProviderResponse } from '../../types/provider-types.js';
import type { UnknownObject } from '../../../../types/common-types.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';
import { DebugEventBus } from "rcc-debugcenter";
import OpenAI from 'openai';

/**
 * OpenAI Provider Module
 */
export class OpenAIProvider implements ProviderModule {
  readonly id: string;
  readonly type = 'openai-provider';
  readonly providerType = 'openai';
  readonly config: ModuleConfig;

  private isInitialized = false;
  private logger: PipelineDebugLogger;
  private authContext: AuthContext | null = null;
  private openai: OpenAI | null = null;
  private client: OpenAI | null = null;

  // Debug enhancement properties
  private debugEventBus: DebugEventBus | null = null;
  private isDebugEnhanced = false;
  private providerMetrics: Map<string, { values: number[]; lastUpdated: number }> = new Map();
  private requestHistory: UnknownObject[] = [];
  private errorHistory: UnknownObject[] = [];
  private maxHistorySize = 50;

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.id = `provider-${Date.now()}`;
    this.config = config;
    this.logger = dependencies.logger as PipelineDebugLogger;

    // Initialize debug enhancements
    this.initializeDebugEnhancements();
  }

  /**
   * Initialize debug enhancements
   */
  private initializeDebugEnhancements(): void {
    try {
      this.debugEventBus = DebugEventBus.getInstance();
      this.isDebugEnhanced = true;
      this.logger.logModule(this.id, 'debug-enhancements-enabled');
    } catch (error) {
      this.logger.logModule(this.id, 'debug-enhancements-failed', { error });
    }
  }

  /**
   * Initialize the OpenAI provider
   */
  async initialize(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'initializing', {
        config: this.config
      });

      const providerConfig = this.config.config as ProviderConfig;

      // Validate configuration
      if (!providerConfig.baseUrl && !providerConfig.auth?.apiKey) {
        throw new Error('OpenAI provider requires either baseUrl or apiKey configuration');
      }

      // Initialize OpenAI client
      const openaiConfig: Record<string, unknown> = {
        dangerouslyAllowBrowser: true // Allow browser usage for Node.js environments
      };

      if (providerConfig.baseUrl) {
        openaiConfig.baseURL = providerConfig.baseUrl;
      }

      if (providerConfig.auth?.apiKey) {
        openaiConfig.apiKey = providerConfig.auth.apiKey;
      }

      if (providerConfig.auth?.organization) {
        openaiConfig.organization = providerConfig.auth.organization;
      }

      // Note: timeout is not part of the base config, but we can add it as needed
      if (providerConfig.compatibility?.timeout) {
        openaiConfig.timeout = providerConfig.compatibility.timeout;
      }

      this.openai = new OpenAI(openaiConfig);
      this.client = this.openai;

      // Store auth context
      this.authContext = providerConfig.auth || null;

      // Test connection
      await this.testConnection();

      this.isInitialized = true;
      this.logger.logModule(this.id, 'initialized');

      if (this.isDebugEnhanced) {
        this.publishProviderEvent('initialization-complete', {
          baseUrl: providerConfig.baseUrl,
          hasAuth: !!providerConfig.auth,
          timeout: providerConfig.compatibility?.timeout
        });
      }

    } catch (error) {
      this.logger.logModule(this.id, 'initialization-error', { error });

      if (this.isDebugEnhanced) {
        this.publishProviderEvent('initialization-error', {
          error: error instanceof Error ? error.message : String(error)
        });
      }

      throw error;
    }
  }

  /**
   * Test OpenAI connection
   */
  private async testConnection(): Promise<void> {
    try {
      // Check if this is a compatibility provider (non-OpenAI)
      const providerConfig = this.config.config as ProviderConfig;
      const isCompatibilityProvider = !providerConfig.baseUrl.includes('api.openai.com');

      if (isCompatibilityProvider) {
        // For compatibility providers, just check that the OpenAI client was created
        // Skip the models.list test as it might not be supported
        this.logger.logModule(this.id, 'connection-test-success', {
          note: 'Compatibility provider - models test skipped'
        });
      } else {
        // For real OpenAI, test with models list
        await this.openai!.models.list();
        this.logger.logModule(this.id, 'connection-test-success');
      }
    } catch (error) {
      this.logger.logModule(this.id, 'connection-test-failed', { error });
      throw new Error(`OpenAI connection test failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Send request to OpenAI
   */
  async sendRequest(request: UnknownObject): Promise<ProviderResponse> {
    if (!this.isInitialized) {
      throw new Error('OpenAI provider is not initialized');
    }

    const startTime = Date.now();
    const requestId = this.generateRequestId();

    try {
      this.logger.logModule(this.id, 'sending-request-start', {
        requestId,
        model: (request as { model?: string }).model,
        hasMessages: Array.isArray((request as { messages?: unknown[] }).messages),
        hasTools: Array.isArray((request as { tools?: unknown[] }).tools)
      });

      if (this.isDebugEnhanced) {
        this.publishProviderEvent('request-start', {
          requestId,
          model: (request as { model?: string }).model,
          timestamp: startTime
        });
      }

      // Prepare chat completion request
      const chatRequest: Record<string, unknown> = {
        model: (request as { model?: string }).model,
        messages: (request as { messages?: unknown[] }).messages || [],
        temperature: (request as { temperature?: number }).temperature ?? 0.7,
        max_tokens: (request as { max_tokens?: number }).max_tokens,
        top_p: (request as { top_p?: number }).top_p,
        frequency_penalty: (request as { frequency_penalty?: number }).frequency_penalty,
        presence_penalty: (request as { presence_penalty?: number }).presence_penalty,
        stream: (request as { stream?: boolean }).stream ?? false
      };

      // Add tools if provided
      {
        const tools = (request as { tools?: unknown[] }).tools;
        if (Array.isArray(tools) && tools.length > 0) {
          chatRequest.tools = tools;
          chatRequest.tool_choice = (request as { tool_choice?: string }).tool_choice || 'auto';
        }
      }

      // Add response format if provided
      if ((request as { response_format?: unknown }).response_format) {
        chatRequest.response_format = (request as { response_format?: unknown }).response_format;
      }

      // Send request to OpenAI
      type ChatCreateArg = Parameters<OpenAI['chat']['completions']['create']>[0];
      const response = await this.openai!.chat.completions.create(chatRequest as unknown as ChatCreateArg);

      const processingTime = Date.now() - startTime;
      const providerResponse: ProviderResponse = {
        data: response,
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-request-id': requestId
        },
        metadata: {
          requestId,
          processingTime,
          model: (request as { model?: string }).model as string
        }
      };

      this.logger.logModule(this.id, 'sending-request-complete', {
        requestId,
        processingTime,
        model: (request as { model?: string }).model
      });

      if (this.isDebugEnhanced) {
        this.publishProviderEvent('request-complete', {
          requestId,
          processingTime,
          success: true,
          model: (request as { model?: string }).model
        });
        this.recordProviderMetric('request_time', processingTime);
        this.addToRequestHistory({
          requestId,
          model: (request as { model?: string }).model,
          processingTime,
          success: true,
          timestamp: Date.now()
        });
      }

      return providerResponse;

    } catch (error) {
      const processingTime = Date.now() - startTime;

      const errAny: any = error as any;
      const upstreamMsg = errAny?.response?.data?.error?.message
        ?? errAny?.response?.data?.message
        ?? errAny?.data?.error?.message
        ?? errAny?.data?.message
        ?? (typeof errAny?.message === 'string' ? errAny.message : undefined);
      const message = upstreamMsg ? String(upstreamMsg) : (error instanceof Error ? error.message : String(error));

      this.logger.logModule(this.id, 'sending-request-error', {
        requestId,
        error: message,
        processingTime
      });

      if (this.isDebugEnhanced) {
        this.publishProviderEvent('request-error', {
          requestId,
          error: message,
          processingTime,
          model: (request as { model?: string }).model
        });
        this.addToErrorHistory({
          requestId,
          error: message,
          model: (request as { model?: string }).model,
          timestamp: Date.now()
        });
      }

      // Map to ProviderError so router can produce consistent error payloads
      const providerErr: any = new Error(message);
      providerErr.type = 'server';
      providerErr.statusCode = errAny?.status ?? errAny?.statusCode ?? errAny?.response?.status ?? 500;
      providerErr.details = errAny?.response?.data || errAny?.data || {};
      providerErr.retryable = providerErr.statusCode >= 500 || providerErr.statusCode === 429;

      throw providerErr;
    }
  }

  /**
   * Check provider health
   */
  async checkHealth(): Promise<boolean> {
    if (!this.isInitialized) {
      return false;
    }

    try {
      // Check if this is a compatibility provider
      const providerConfig = this.config.config as ProviderConfig;
      const isCompatibilityProvider = !providerConfig.baseUrl.includes('api.openai.com');

      if (isCompatibilityProvider) {
        // For compatibility providers, just check that the OpenAI client exists
        // Skip actual health check as models endpoint might not exist
        if (this.isDebugEnhanced) {
          this.publishProviderEvent('health-check-success', {
            timestamp: Date.now(),
            note: 'Compatibility provider - models health check skipped'
          });
        }
        return true;
      } else {
        // For real OpenAI, test with models list
        await this.openai!.models.list();

        if (this.isDebugEnhanced) {
          this.publishProviderEvent('health-check-success', {
            timestamp: Date.now()
          });
        }
        return true;
      }
    } catch (error) {
      this.logger.logModule(this.id, 'health-check-failed', { error });

      if (this.isDebugEnhanced) {
        this.publishProviderEvent('health-check-failed', {
          error: error instanceof Error ? error.message : String(error),
          timestamp: Date.now()
        });
      }

      return false;
    }
  }

  /**
   * Process incoming request (compatibility with pipeline)
   */
  async processIncoming(request: UnknownObject): Promise<ProviderResponse> {
    return this.sendRequest(request);
  }

  /**
   * Process outgoing response (compatibility with pipeline)
   */
  async processOutgoing(response: UnknownObject): Promise<UnknownObject> {
    return response;
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'cleanup-start');

      // Reset state
      this.isInitialized = false;
      this.openai = null;
      this.client = null;
      this.authContext = null;

      this.logger.logModule(this.id, 'cleanup-complete');

      if (this.isDebugEnhanced) {
        this.publishProviderEvent('cleanup-complete', {
          timestamp: Date.now()
        });
      }

    } catch (error) {
      this.logger.logModule(this.id, 'cleanup-error', { error });
      throw error;
    }
  }

  /**
   * Get module status
   */
  getStatus(): {
    id: string;
    type: string;
    providerType: string;
    isInitialized: boolean;
    lastActivity: number;
    hasAuth: boolean;
    debugEnabled: boolean;
  } {
    return {
      id: this.id,
      type: this.type,
      providerType: this.providerType,
      isInitialized: this.isInitialized,
      lastActivity: Date.now(),
      hasAuth: !!this.authContext,
      debugEnabled: this.isDebugEnhanced
    };
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `openai-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Record provider metric
   */
  private recordProviderMetric(operationId: string, value: number): void {
    if (!this.isDebugEnhanced) {return;}

    if (!this.providerMetrics.has(operationId)) {
      this.providerMetrics.set(operationId, {
        values: [],
        lastUpdated: Date.now()
      });
    }

    const metric = this.providerMetrics.get(operationId)!;
    metric.values.push(value);
    metric.lastUpdated = Date.now();

    // Keep only last 50 measurements
    if (metric.values.length > 50) {
      metric.values.shift();
    }
  }

  /**
   * Add request to history
   */
  private addToRequestHistory(request: UnknownObject): void {
    if (!this.isDebugEnhanced) {return;}

    this.requestHistory.push(request);

    // Keep only recent history
    if (this.requestHistory.length > this.maxHistorySize) {
      this.requestHistory.shift();
    }
  }

  /**
   * Add error to history
   */
  private addToErrorHistory(error: UnknownObject): void {
    if (!this.isDebugEnhanced) {return;}

    this.errorHistory.push(error);

    // Keep only recent history
    if (this.errorHistory.length > this.maxHistorySize) {
      this.errorHistory.shift();
    }
  }

  /**
   * Publish provider event
   */
  private publishProviderEvent(type: string, data: UnknownObject): void {
    if (!this.isDebugEnhanced || !this.debugEventBus) {return;}

    try {
      this.debugEventBus.publish({
        sessionId: 'system',
        moduleId: this.id,
        operationId: type,
        timestamp: Date.now(),
        type: "start",
        position: 'middle',
        data: {
          providerType: 'openai',
          ...data
        }
      });
    } catch (error) {
      // Silent fail if WebSocket is not available
    }
  }

  /**
   * Get enhanced provider status with debug information
   */
  getEnhancedStatus(): UnknownObject {
    const baseStatus = this.getStatus();

    if (!this.isDebugEnhanced) {
      return baseStatus;
    }

    return {
      ...baseStatus,
      metrics: this.getProviderMetrics(),
      requestHistory: [...this.requestHistory],
      errorHistory: [...this.errorHistory],
      performanceStats: this.getPerformanceStats()
    };
  }

  /**
   * Get provider metrics
   */
  private getProviderMetrics(): Record<string, { count: number; avg: number; min: number; max: number; lastUpdated: number }> {
    const metrics: Record<string, { count: number; avg: number; min: number; max: number; lastUpdated: number }> = {};

    for (const [operationId, metric] of this.providerMetrics.entries()) {
      const values = metric.values;
      if (values.length > 0) {
        metrics[operationId] = {
          count: values.length,
          avg: Math.round(values.reduce((a: number, b: number) => a + b, 0) / values.length),
          min: Math.min(...values),
          max: Math.max(...values),
          lastUpdated: metric.lastUpdated
        };
      }
    }

    return metrics;
  }

  /**
   * Get performance statistics
   */
  private getPerformanceStats(): Record<string, number> {
    const requests = this.requestHistory as Array<{ processingTime?: number }>;
    const errors = this.errorHistory;
    const count = requests.length;
    const total = count > 0 ? requests.reduce((sum, r) => sum + (typeof r.processingTime === 'number' ? r.processingTime : 0), 0) : 0;
    const avg = count > 0 ? Math.round(total / count) : 0;
    const successRate = count > 0 ? (count - errors.length) / count : 0;
    return {
      totalRequests: count,
      totalErrors: errors.length,
      successRate,
      avgResponseTime: avg
    };
  }
}
