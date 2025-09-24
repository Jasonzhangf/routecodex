/**
 * OpenAI Provider Implementation
 *
 * Provides a standard OpenAI-compatible provider using the official OpenAI SDK.
 * Supports chat completions, function calling, and streaming responses.
 */

import type { ProviderModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { ProviderConfig, AuthContext, ProviderResponse, ProviderError } from '../../types/provider-types.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';
import { DebugEventBus } from '../../../../utils/external-mocks.js';
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
  private client: any = null;

  // Debug enhancement properties
  private debugEventBus: DebugEventBus | null = null;
  private isDebugEnhanced = false;
  private providerMetrics: Map<string, any> = new Map();
  private requestHistory: any[] = [];
  private errorHistory: any[] = [];
  private maxHistorySize = 50;

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.id = `provider-${Date.now()}`;
    this.config = config;
    this.logger = dependencies.logger as any;

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
      const openaiConfig: any = {
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
  async sendRequest(request: any): Promise<ProviderResponse> {
    if (!this.isInitialized) {
      throw new Error('OpenAI provider is not initialized');
    }

    const startTime = Date.now();
    const requestId = this.generateRequestId();

    try {
      this.logger.logModule(this.id, 'sending-request-start', {
        requestId,
        model: request.model,
        hasMessages: !!request.messages,
        hasTools: !!request.tools
      });

      if (this.isDebugEnhanced) {
        this.publishProviderEvent('request-start', {
          requestId,
          model: request.model,
          timestamp: startTime
        });
      }

      // Prepare chat completion request
      const chatRequest: any = {
        model: request.model,
        messages: request.messages || [],
        temperature: request.temperature ?? 0.7,
        max_tokens: request.max_tokens,
        top_p: request.top_p,
        frequency_penalty: request.frequency_penalty,
        presence_penalty: request.presence_penalty,
        stream: request.stream ?? false
      };

      // Add tools if provided
      if (request.tools && request.tools.length > 0) {
        chatRequest.tools = request.tools;
        chatRequest.tool_choice = request.tool_choice || 'auto';
      }

      // Add response format if provided
      if (request.response_format) {
        chatRequest.response_format = request.response_format;
      }

      // Send request to OpenAI
      const response = await this.openai!.chat.completions.create(chatRequest);

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
          model: request.model
        }
      };

      this.logger.logModule(this.id, 'sending-request-complete', {
        requestId,
        processingTime,
        model: request.model
      });

      if (this.isDebugEnhanced) {
        this.publishProviderEvent('request-complete', {
          requestId,
          processingTime,
          success: true,
          model: request.model
        });
        this.recordProviderMetric('request_time', processingTime);
        this.addToRequestHistory({
          requestId,
          model: request.model,
          processingTime,
          success: true,
          timestamp: Date.now()
        });
      }

      return providerResponse;

    } catch (error) {
      const processingTime = Date.now() - startTime;
      const errorResponse: ProviderResponse = {
        data: null,
        status: 500,
        headers: {
          'content-type': 'application/json',
          'x-request-id': requestId
        },
        metadata: {
          requestId,
          processingTime,
          model: request.model
        }
      };

      this.logger.logModule(this.id, 'sending-request-error', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
        processingTime
      });

      if (this.isDebugEnhanced) {
        this.publishProviderEvent('request-error', {
          requestId,
          error: error instanceof Error ? error.message : String(error),
          processingTime,
          model: request.model
        });
        this.addToErrorHistory({
          requestId,
          error: error instanceof Error ? error.message : String(error),
          model: request.model,
          timestamp: Date.now()
        });
      }

      throw errorResponse;
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
  async processIncoming(request: any): Promise<any> {
    return this.sendRequest(request);
  }

  /**
   * Process outgoing response (compatibility with pipeline)
   */
  async processOutgoing(response: any): Promise<any> {
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
    if (!this.isDebugEnhanced) return;

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
  private addToRequestHistory(request: any): void {
    if (!this.isDebugEnhanced) return;

    this.requestHistory.push(request);

    // Keep only recent history
    if (this.requestHistory.length > this.maxHistorySize) {
      this.requestHistory.shift();
    }
  }

  /**
   * Add error to history
   */
  private addToErrorHistory(error: any): void {
    if (!this.isDebugEnhanced) return;

    this.errorHistory.push(error);

    // Keep only recent history
    if (this.errorHistory.length > this.maxHistorySize) {
      this.errorHistory.shift();
    }
  }

  /**
   * Publish provider event
   */
  private publishProviderEvent(type: string, data: any): void {
    if (!this.isDebugEnhanced || !this.debugEventBus) return;

    try {
      this.debugEventBus.publish({
        sessionId: 'system',
        moduleId: this.id,
        operationId: type,
        timestamp: Date.now(),
        type: 'provider',
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
  getEnhancedStatus(): any {
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
  private getProviderMetrics(): any {
    const metrics: any = {};

    for (const [operationId, metric] of this.providerMetrics.entries()) {
      const values = metric.values;
      if (values.length > 0) {
        metrics[operationId] = {
          count: values.length,
          avg: Math.round(values.reduce((a: any, b: any) => a + b, 0) / values.length),
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
  private getPerformanceStats(): any {
    const requests = this.requestHistory;
    const errors = this.errorHistory;

    return {
      totalRequests: requests.length,
      totalErrors: errors.length,
      successRate: requests.length > 0 ? (requests.length - errors.length) / requests.length : 0,
      avgResponseTime: requests.length > 0
        ? Math.round(requests.reduce((sum: any, req: any) => sum + req.processingTime, 0) / requests.length)
        : 0
    };
  }
}