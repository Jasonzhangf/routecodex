/**
 * Base Provider Class
 * Abstract base class for all AI providers
 */

import { BaseModule, type ModuleInfo } from 'rcc-basemodule';
import { DebugEventBus } from 'rcc-debugcenter';
import { ErrorHandlingCenter, type ErrorContext } from 'rcc-errorhandling';
import {
  type ProviderConfig,
  type ModelConfig,
  type OpenAIChatCompletionRequest,
  type OpenAICompletionRequest,
  type OpenAICompletionResponse,
  type OpenAIModel,
  type StreamOptions,
  type StreamResponse,
  RouteCodexError
} from '../server/types.js';

/**
 * Provider response interface
 */
export interface ProviderResponse {
  success: boolean;
  data?: any;
  error?: string;
  statusCode?: number;
  headers?: Record<string, string>;
  duration?: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Provider health status
 */
export interface ProviderHealth {
  status: 'healthy' | 'unhealthy' | 'unknown';
  responseTime?: number;
  lastCheck?: string;
  error?: string;
  consecutiveFailures: number;
  lastSuccess?: string;
}

/**
 * Provider statistics
 */
export interface ProviderStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  totalTokensUsed: number;
  lastRequest?: string;
  lastError?: string;
}

/**
 * Abstract Base Provider class
 */
export abstract class BaseProvider extends BaseModule {
  protected config: ProviderConfig;
  protected errorHandling: ErrorHandlingCenter;
  protected debugEventBus: DebugEventBus;
  protected health: ProviderHealth;
  protected stats: ProviderStats;
  protected rateLimitData: Map<string, { count: number; resetTime: number }> = new Map();

  constructor(config: ProviderConfig) {
    const moduleInfo: ModuleInfo = {
      id: config.id,
      name: `${config.type}-provider`,
      version: '0.0.1',
      description: `${config.type} AI provider`,
      type: 'provider'
    };

    super(moduleInfo);

    this.config = config;
    this.errorHandling = new ErrorHandlingCenter();
    this.debugEventBus = DebugEventBus.getInstance();

    // Initialize health and stats
    this.health = {
      status: 'unknown',
      consecutiveFailures: 0
    };

    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageResponseTime: 0,
      totalTokensUsed: 0
    };
  }

  /**
   * Initialize the provider
   */
  public async initialize(config?: any): Promise<void> {
    try {
      await this.errorHandling.initialize();
      await this.validateConfiguration();

      this.health.status = 'healthy';

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.getModuleInfo().id,
        operationId: 'provider_initialized',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          providerId: this.config.id,
          models: Object.keys(this.config.models)
        }
      });

    } catch (error) {
      this.health.status = 'unhealthy';
      this.health.error = error instanceof Error ? error.message : String(error);
      this.health.consecutiveFailures++;

      await this.handleError(error as Error, 'initialization');
      throw error;
    }
  }

  /**
   * Validate provider configuration
   */
  protected async validateConfiguration(): Promise<void> {
    const errors: string[] = [];

    if (!this.config.id || typeof this.config.id !== 'string') {
      errors.push('Provider ID is required and must be a string');
    }

    if (!this.config.type || typeof this.config.type !== 'string') {
      errors.push('Provider type is required and must be a string');
    }

    if (this.config.enabled === undefined) {
      errors.push('Provider enabled status must be specified');
    }

    // Validate models
    if (!this.config.models || typeof this.config.models !== 'object' || Object.keys(this.config.models).length === 0) {
      errors.push('Provider must have at least one model configured');
    }

    for (const [modelId, modelConfig] of Object.entries(this.config.models)) {
      if (!modelConfig || typeof modelConfig !== 'object') {
        errors.push(`Model '${modelId}' must be a valid configuration object`);
        continue;
      }

      if (modelConfig.maxTokens === undefined || modelConfig.maxTokens < 1) {
        errors.push(`Model '${modelId}' must have a valid maxTokens value > 0`);
      }
    }

    if (errors.length > 0) {
      throw new Error(`Configuration validation failed: ${errors.join(', ')}`);
    }
  }

  /**
   * Process chat completion request
   */
  public abstract processChatCompletion(
    request: OpenAIChatCompletionRequest,
    options?: { timeout?: number; retryAttempts?: number }
  ): Promise<ProviderResponse>;

  /**
   * Process completion request
   */
  public abstract processCompletion(
    request: OpenAICompletionRequest,
    options?: { timeout?: number; retryAttempts?: number }
  ): Promise<ProviderResponse>;

  /**
   * Process streaming chat completion
   */
  public abstract processStreamingChatCompletion(
    request: OpenAIChatCompletionRequest,
    options: StreamOptions
  ): Promise<ProviderResponse>;

  /**
   * Get available models
   */
  public async getModels(): Promise<OpenAIModel[]> {
    const models: OpenAIModel[] = [];

    for (const [modelId, modelConfig] of Object.entries(this.config.models)) {
      if (modelConfig.enabled !== false) {
        models.push({
          id: modelId,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: this.config.id
        });
      }
    }

    return models;
  }

  /**
   * Check if model is supported
   */
  public isModelSupported(modelId: string): boolean {
    const modelConfig = this.config.models[modelId];
    return modelConfig !== undefined && modelConfig.enabled !== false;
  }

  /**
   * Get model configuration
   */
  public getModelConfig(modelId: string): ModelConfig | undefined {
    const modelConfig = this.config.models[modelId];
    if (!modelConfig) {
      return undefined;
    }

    return {
      id: modelId,
      maxTokens: modelConfig.maxTokens || 4096,
      temperature: modelConfig.temperature,
      topP: modelConfig.topP,
      enabled: modelConfig.enabled !== false,
      costPer1kTokens: modelConfig.costPer1kTokens,
      supportsStreaming: modelConfig.supportsStreaming !== false,
      supportsTools: modelConfig.supportsTools !== false,
      supportsVision: modelConfig.supportsVision,
      contextWindow: modelConfig.contextWindow
    };
  }

  /**
   * Check rate limit
   */
  protected checkRateLimit(key: string): { allowed: boolean; resetTime?: number } {
    const now = Date.now();
    const windowMs = 60000; // 1 minute window
    const maxRequests = this.config.rateLimit?.requestsPerMinute || 100;

    let limitData = this.rateLimitData.get(key);

    // Reset if window has passed
    if (!limitData || now > limitData.resetTime) {
      limitData = { count: 0, resetTime: now + windowMs };
      this.rateLimitData.set(key, limitData);
    }

    if (limitData.count >= maxRequests) {
      return { allowed: false, resetTime: limitData.resetTime };
    }

    limitData.count++;
    return { allowed: true };
  }

  /**
   * Update provider statistics
   */
  protected updateStats(success: boolean, duration: number, tokens?: number): void {
    this.stats.totalRequests++;

    if (success) {
      this.stats.successfulRequests++;
      this.health.consecutiveFailures = 0;
      this.health.lastSuccess = new Date().toISOString();
    } else {
      this.stats.failedRequests++;
      this.health.consecutiveFailures++;
    }

    // Update average response time
    if (this.stats.totalRequests === 1) {
      this.stats.averageResponseTime = duration;
    } else {
      this.stats.averageResponseTime =
        (this.stats.averageResponseTime * (this.stats.totalRequests - 1) + duration) / this.stats.totalRequests;
    }

    if (tokens) {
      this.stats.totalTokensUsed += tokens;
    }

    this.stats.lastRequest = new Date().toISOString();

    // Update health status based on consecutive failures
    if (this.health.consecutiveFailures >= 3) {
      this.health.status = 'unhealthy';
    } else if (this.health.consecutiveFailures === 0) {
      this.health.status = 'healthy';
    }
  }

  /**
   * Get provider health
   */
  public getHealth(): ProviderHealth {
    return { ...this.health };
  }

  /**
   * Get provider statistics
   */
  public getStats(): ProviderStats {
    return { ...this.stats };
  }

  /**
   * Health check
   */
  public async healthCheck(): Promise<ProviderHealth> {
    const startTime = Date.now();

    try {
      // Try to get models as a basic health check
      await this.getModels();

      this.health.status = 'healthy';
      this.health.responseTime = Date.now() - startTime;
      this.health.lastCheck = new Date().toISOString();
      this.health.error = undefined;

    } catch (error) {
      this.health.status = 'unhealthy';
      this.health.responseTime = Date.now() - startTime;
      this.health.lastCheck = new Date().toISOString();
      this.health.error = error instanceof Error ? error.message : String(error);

      await this.handleError(error as Error, 'health_check');
    }

    return { ...this.health };
  }

  /**
   * Reset provider state
   */
  public async reset(): Promise<void> {
    this.health = {
      status: 'unknown',
      consecutiveFailures: 0
    };

    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageResponseTime: 0,
      totalTokensUsed: 0
    };

    this.rateLimitData.clear();

    this.debugEventBus.publish({
      sessionId: `session_${Date.now()}`,
      moduleId: this.getModuleInfo().id,
      operationId: 'provider_reset',
      timestamp: Date.now(),
      type: 'start',
      position: 'middle',
      data: {
        providerId: this.config.id
      }
    });
  }

  /**
   * Update configuration
   */
  public async updateConfig(newConfig: Partial<ProviderConfig>): Promise<void> {
    try {
      const oldConfig = { ...this.config };
      this.config = { ...this.config, ...newConfig };

      await this.validateConfiguration();

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.getModuleInfo().id,
        operationId: 'provider_config_updated',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          providerId: this.config.id,
          changes: Object.keys(newConfig)
        }
      });

    } catch (error) {
      // Revert to old config on validation failure
      const oldConfigBackup = { ...this.config };
      this.config = oldConfigBackup;
      await this.handleError(error as Error, 'update_config');
      throw error;
    }
  }

  /**
   * Handle error with error handling center
   */
  protected async handleError(error: Error, context: string): Promise<void> {
    try {
      const errorContext: ErrorContext = {
        error: error.message,
        source: `${this.getModuleInfo().id}.${context}`,
        severity: 'medium',
        timestamp: Date.now(),
        moduleId: this.getModuleInfo().id,
        context: {
          stack: error.stack,
          name: error.name,
          providerId: this.config.id
        }
      };

      await this.errorHandling.handleError(errorContext);
    } catch (handlerError) {
      console.error('Failed to handle error:', handlerError);
      console.error('Original error:', error);
    }
  }

  /**
   * Create standardized response
   */
  protected createResponse(
    success: boolean,
    data?: any,
    error?: string,
    statusCode?: number,
    headers?: Record<string, string>,
    duration?: number,
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  ): ProviderResponse {
    return {
      success,
      data,
      error,
      statusCode,
      headers,
      duration,
      usage
    };
  }

  /**
   * Format OpenAI-compatible response
   */
  protected formatOpenAIResponse(
    request: OpenAIChatCompletionRequest | OpenAICompletionRequest,
    response: any,
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  ): OpenAICompletionResponse {
    // Convert usage object to match OpenAI format
    const normalizedUsage = usage ? {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0
    } : undefined;

    return {
      id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: response.content || response.text || '',
            tool_calls: response.tool_calls
          },
          finish_reason: response.finish_reason || 'stop'
        }
      ],
      usage: normalizedUsage
    };
  }

  /**
   * Get module info
   */
  public getModuleInfo(): ModuleInfo {
    return {
      id: this.config.id,
      name: `${this.config.type}-provider`,
      version: '0.0.1',
      description: `${this.config.type} AI provider`,
      type: 'provider'
    };
  }

  /**
   * Clean up provider resources
   */
  public async destroy(): Promise<void> {
    await this.errorHandling.destroy();
    this.rateLimitData.clear();
  }
}