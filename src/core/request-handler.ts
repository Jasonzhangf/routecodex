/**
 * Request Handler
 * Handles incoming HTTP requests and forwards them to appropriate providers
 */

import { BaseModule, type ModuleInfo } from 'rcc-basemodule';
import { DebugEventBus } from 'rcc-debugcenter';
import { ErrorHandlingCenter, type ErrorContext } from 'rcc-errorhandling';
import { ErrorHandlingUtils } from '../utils/error-handling-utils.js';
import { ProviderManager } from './provider-manager.js';
import {
  type RequestContext,
  type ResponseContext,
  type OpenAIChatCompletionRequest,
  type OpenAICompletionRequest,
  type OpenAICompletionResponse,
  type OpenAIModel,
  type ServerConfig,
  RouteCodexError
} from '../server/types.js';

/**
 * Request handler options
 */
export interface RequestHandlerOptions {
  timeout?: number;
  maxRequestSize?: number;
  enableStreaming?: boolean;
  rateLimitEnabled?: boolean;
  authEnabled?: boolean;
  validateRequests?: boolean;
}

/**
 * Type guards for request discrimination
 */
function isChatCompletionRequest(request: any): request is OpenAIChatCompletionRequest {
  return request && typeof request === 'object' && 'messages' in request && Array.isArray(request.messages);
}

function isCompletionRequest(request: any): request is OpenAICompletionRequest {
  return request && typeof request === 'object' && 'prompt' in request && !('messages' in request);
}

/**
 * Request validation result
 */
export interface RequestValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  normalizedRequest?: OpenAIChatCompletionRequest | OpenAICompletionRequest;
}

/**
 * Request Handler class
 */
export class RequestHandler extends BaseModule {
  private providerManager: ProviderManager;
  private config: ServerConfig;
  private debugEventBus: DebugEventBus;
  private errorHandling: ErrorHandlingCenter;
  private errorUtils: ReturnType<typeof ErrorHandlingUtils.createModuleErrorHandler>;
  private options: RequestHandlerOptions;

  // Debug enhancement properties
  private handlerMetrics: Map<string, any> = new Map();
  private requestHistory: any[] = [];
  private errorHistory: any[] = [];
  private maxHistorySize = 50;

  constructor(
    providerManager: ProviderManager,
    config: ServerConfig,
    options: RequestHandlerOptions = {}
  ) {
    const moduleInfo: ModuleInfo = {
      id: 'request-handler',
      name: 'RequestHandler',
      version: '0.0.1',
      description: 'Handles incoming HTTP requests and forwards to providers',
      type: 'core'
    };

    super(moduleInfo);

    this.providerManager = providerManager;
    this.config = config;
    this.debugEventBus = DebugEventBus.getInstance();
    this.errorHandling = new ErrorHandlingCenter();
    this.errorUtils = ErrorHandlingUtils.createModuleErrorHandler('request-handler');

    // Set default options
    this.options = {
      timeout: 30000,
      maxRequestSize: 10 * 1024 * 1024, // 10MB
      enableStreaming: true,
      rateLimitEnabled: true,
      authEnabled: false,
      validateRequests: true,
      ...options
    };

    // Initialize debug enhancements
    this.initializeDebugEnhancements();
  }

  /**
   * Initialize the request handler
   */
  public async initialize(config?: any): Promise<void> {
    try {
      await ErrorHandlingUtils.initialize();
      await this.errorHandling.initialize();

      // Register error messages for request handler
      this.errorUtils.registerMessage(
        'validation_error',
        'Request validation failed',
        'medium',
        'validation',
        'Incoming request failed validation checks',
        'Check request format and required fields'
      );

      this.errorUtils.registerMessage(
        'provider_error',
        'Provider processing error',
        'medium',
        'provider',
        'AI provider failed to process request',
        'Retry with different parameters or check provider status'
      );

      this.errorUtils.registerMessage(
        'timeout_error',
        'Request timeout',
        'medium',
        'performance',
        'Request exceeded time limit',
        'Increase timeout or optimize request complexity'
      );

      this.errorUtils.registerMessage(
        'rate_limit_error',
        'Rate limit exceeded',
        'medium',
        'performance',
        'Too many requests in time period',
        'Wait and retry with lower frequency'
      );

      // Register error handlers for request handler
      this.errorUtils.registerHandler(
        'validation_error',
        async (context) => {
          console.warn(`Request validation error: ${context.error}`);
          // Could implement automatic request correction
        },
        2,
        'Handle request validation errors'
      );

      this.errorUtils.registerHandler(
        'provider_error',
        async (context) => {
          console.error(`Provider processing error: ${context.error}`);
          // Could implement provider failover logic
        },
        1,
        'Handle AI provider processing errors'
      );

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'request-handler',
        operationId: 'request_handler_initialized',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          options: this.options,
          timeout: this.options.timeout,
          maxRequestSize: this.options.maxRequestSize
        }
      });

    } catch (error) {
      await this.handleError(error as Error, 'initialization');
      throw error;
    }
  }

  /**
   * Handle chat completion request
   */
  public async handleChatCompletion(
    request: OpenAIChatCompletionRequest,
    context: RequestContext
  ): Promise<ResponseContext> {
    const startTime = Date.now();

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'request-handler',
        operationId: 'chat_completion_request_start',
        timestamp: startTime,
        type: 'start',
        position: 'middle',
        data: {
          requestId: context.id,
          model: request.model,
          messageCount: request.messages?.length || 0,
          streaming: request.stream || false
        }
      });

      // Validate request
      const validation = this.validateChatCompletionRequest(request);
      if (!validation.isValid) {
        throw new RouteCodexError(
          `Request validation failed: ${validation.errors.join(', ')}`,
          'validation_error',
          400
        );
      }

      // Use normalized request if available
      const processedRequest = validation.normalizedRequest || request;

      // Check if streaming is requested and enabled
      if (processedRequest.stream && !this.options.enableStreaming) {
        throw new RouteCodexError(
          'Streaming is not enabled',
          'streaming_disabled',
          400
        );
      }

      let response: any;

      if (processedRequest.stream && isChatCompletionRequest(processedRequest)) {
        // Handle streaming request
        response = await this.handleStreamingChatCompletion(processedRequest as OpenAIChatCompletionRequest, context);
      } else {
        // Handle regular request
        const provider = this.providerManager.getActiveProviders()[0]; // Use first available provider
        if (!provider) {
          throw new RouteCodexError(
            'No active providers available',
            'no_active_providers',
            503
          );
        }

        const providerResponse = await provider.processChatCompletion(processedRequest as OpenAIChatCompletionRequest, {
          timeout: this.options.timeout,
          retryAttempts: 3
        });

        response = this.formatChatCompletionResponse(processedRequest as OpenAIChatCompletionRequest, providerResponse);
      }

      const duration = Date.now() - startTime;

      // Create response context
      const responseContext: ResponseContext = {
        id: `resp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        requestId: context.id,
        timestamp: Date.now(),
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Response-Time': duration.toString()
        },
        body: response,
        duration,
        providerId: (response as any).providerId || 'unknown',
        modelId: (response as any).model || processedRequest.model,
        usage: (response as any).usage
      };

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'request-handler',
        operationId: 'chat_completion_request_end',
        timestamp: Date.now(),
        type: 'end',
        position: 'middle',
        data: {
          requestId: context.id,
          duration,
          status: responseContext.status,
          providerId: responseContext.providerId,
          usage: responseContext.usage
        }
      });

      return responseContext;

    } catch (error) {
      const duration = Date.now() - startTime;
      await this.handleError(error as Error, 'chat_completion');

      const responseContext: ResponseContext = {
        id: `resp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        requestId: context.id,
        timestamp: Date.now(),
        status: error instanceof RouteCodexError ? error.status : 500,
        headers: {
          'Content-Type': 'application/json'
        },
        body: {
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: error instanceof RouteCodexError ? error.code : 'internal_error',
            code: error instanceof RouteCodexError ? error.code : 'internal_error'
          }
        },
        duration
      };

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'request-handler',
        operationId: 'chat_completion_request_error',
        timestamp: Date.now(),
        type: 'error',
        position: 'middle',
        data: {
          requestId: context.id,
          duration,
          error: error instanceof Error ? error.message : String(error),
          status: responseContext.status
        }
      });

      return responseContext;
    }
  }

  /**
   * Handle completion request
   */
  public async handleCompletion(
    request: OpenAICompletionRequest,
    context: RequestContext
  ): Promise<ResponseContext> {
    const startTime = Date.now();

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'request-handler',
        operationId: 'completion_request_start',
        timestamp: startTime,
        type: 'start',
        position: 'middle',
        data: {
          requestId: context.id,
          model: request.model,
          promptLength: Array.isArray(request.prompt) ? request.prompt.length : request.prompt?.length || 0,
          streaming: request.stream || false
        }
      });

      // Validate request
      const validation = this.validateCompletionRequest(request);
      if (!validation.isValid) {
        throw new RouteCodexError(
          `Request validation failed: ${validation.errors.join(', ')}`,
          'validation_error',
          400
        );
      }

      // Use normalized request if available
      const processedRequest = validation.normalizedRequest || request;

      // Process request through provider manager
      const provider = this.providerManager.getActiveProviders()[0]; // Use first available provider
      if (!provider) {
        throw new RouteCodexError(
          'No active providers available',
          'no_active_providers',
          503
        );
      }

      const providerResponse = await provider.processCompletion(processedRequest as OpenAICompletionRequest, {
        timeout: this.options.timeout,
        retryAttempts: 3
      });

      const response = this.formatCompletionResponse(processedRequest as OpenAICompletionRequest, providerResponse);
      const duration = Date.now() - startTime;

      // Create response context
      const responseContext: ResponseContext = {
        id: `resp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        requestId: context.id,
        timestamp: Date.now(),
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Response-Time': duration.toString()
        },
        body: response,
        duration,
        providerId: (response as any).providerId || 'unknown',
        modelId: (response as any).model || processedRequest.model,
        usage: (response as any).usage
      };

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'request-handler',
        operationId: 'completion_request_end',
        timestamp: Date.now(),
        type: 'end',
        position: 'middle',
        data: {
          requestId: context.id,
          duration,
          status: responseContext.status,
          providerId: responseContext.providerId,
          usage: responseContext.usage
        }
      });

      return responseContext;

    } catch (error) {
      const duration = Date.now() - startTime;
      await this.handleError(error as Error, 'completion');

      const responseContext: ResponseContext = {
        id: `resp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        requestId: context.id,
        timestamp: Date.now(),
        status: error instanceof RouteCodexError ? error.status : 500,
        headers: {
          'Content-Type': 'application/json'
        },
        body: {
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: error instanceof RouteCodexError ? error.code : 'internal_error',
            code: error instanceof RouteCodexError ? error.code : 'internal_error'
          }
        },
        duration
      };

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'request-handler',
        operationId: 'completion_request_error',
        timestamp: Date.now(),
        type: 'error',
        position: 'middle',
        data: {
          requestId: context.id,
          duration,
          error: error instanceof Error ? error.message : String(error),
          status: responseContext.status
        }
      });

      return responseContext;
    }
  }

  /**
   * Handle streaming chat completion
   */
  private async handleStreamingChatCompletion(
    request: OpenAIChatCompletionRequest,
    context: RequestContext
  ): Promise<any> {
    // This would typically involve setting up a streaming response
    // For now, we'll return a placeholder indicating streaming support
    return {
      id: `stream_${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Streaming response would be handled here'
          },
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    };
  }

  /**
   * Handle models request
   */
  public async handleModels(context: RequestContext): Promise<ResponseContext> {
    const startTime = Date.now();

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'request-handler',
        operationId: 'models_request_start',
        timestamp: startTime,
        type: 'start',
        position: 'middle',
        data: {
          requestId: context.id
        }
      });

      // Get models from active providers
      const models: any[] = [];
      const activeProviders = this.providerManager.getActiveProviders();

      for (const provider of activeProviders) {
        try {
          const providerModels = await provider.getModels();
          if (Array.isArray(providerModels)) {
            models.push(...providerModels);
          } else if (providerModels && typeof providerModels === 'object' && 'data' in providerModels && Array.isArray((providerModels as any).data)) {
            models.push(...(providerModels as any).data);
          } else if (providerModels && typeof providerModels === 'object' && 'data' in providerModels) {
            // Handle case where data might not be an array
            models.push((providerModels as any).data);
          }
        } catch (error) {
          // Continue with other providers if one fails
          console.warn(`Failed to get models from provider:`, error);
        }
      }

      const response = {
        object: 'list',
        data: models
      };

      const duration = Date.now() - startTime;

      // Create response context
      const responseContext: ResponseContext = {
        id: `resp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        requestId: context.id,
        timestamp: Date.now(),
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Response-Time': duration.toString()
        },
        body: response,
        duration
      };

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'request-handler',
        operationId: 'models_request_end',
        timestamp: Date.now(),
        type: 'end',
        position: 'middle',
        data: {
          requestId: context.id,
          duration,
          modelCount: models.length
        }
      });

      return responseContext;

    } catch (error) {
      const duration = Date.now() - startTime;
      await this.handleError(error as Error, 'models');

      const responseContext: ResponseContext = {
        id: `resp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        requestId: context.id,
        timestamp: Date.now(),
        status: 500,
        headers: {
          'Content-Type': 'application/json'
        },
        body: {
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: 'models_error',
            code: 'models_error'
          }
        },
        duration
      };

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'request-handler',
        operationId: 'models_request_error',
        timestamp: Date.now(),
        type: 'error',
        position: 'middle',
        data: {
          requestId: context.id,
          duration,
          error: error instanceof Error ? error.message : String(error)
        }
      });

      return responseContext;
    }
  }

  /**
   * Validate chat completion request
   */
  private validateChatCompletionRequest(request: OpenAIChatCompletionRequest): RequestValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const normalizedRequest = { ...request };

    // Validate required fields
    if (!request.model || typeof request.model !== 'string') {
      errors.push('Model is required and must be a string');
    }

    if (!request.messages || !Array.isArray(request.messages) || request.messages.length === 0) {
      errors.push('Messages are required and must be a non-empty array');
    }

    // Validate messages
    if (request.messages && Array.isArray(request.messages)) {
      for (let i = 0; i < request.messages.length; i++) {
        const message = request.messages[i];
        if (!message.role || !['system', 'user', 'assistant', 'tool'].includes(message.role)) {
          errors.push(`Message ${i} has invalid role: ${message.role}`);
        }

        if (!message.content || typeof message.content !== 'string') {
          errors.push(`Message ${i} has invalid content: must be a string`);
        }
      }
    }

    // Validate numeric fields
    if (request.max_tokens !== undefined && (typeof request.max_tokens !== 'number' || request.max_tokens < 1)) {
      errors.push('max_tokens must be a positive number');
    }

    if (request.temperature !== undefined && (typeof request.temperature !== 'number' || request.temperature < 0 || request.temperature > 2)) {
      errors.push('temperature must be a number between 0 and 2');
    }

    if (request.top_p !== undefined && (typeof request.top_p !== 'number' || request.top_p < 0 || request.top_p > 1)) {
      errors.push('top_p must be a number between 0 and 1');
    }

    // Normalize values
    if (request.temperature === undefined) {
      normalizedRequest.temperature = 0.7;
    }

    if (request.top_p === undefined) {
      normalizedRequest.top_p = 1.0;
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      normalizedRequest
    };
  }

  /**
   * Validate completion request
   */
  private validateCompletionRequest(request: OpenAICompletionRequest): RequestValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const normalizedRequest = { ...request };

    // Validate required fields
    if (!request.model || typeof request.model !== 'string') {
      errors.push('Model is required and must be a string');
    }

    if (!request.prompt || (typeof request.prompt !== 'string' && !Array.isArray(request.prompt))) {
      errors.push('Prompt is required and must be a string or array of strings');
    }

    // Validate numeric fields
    if (request.max_tokens !== undefined && (typeof request.max_tokens !== 'number' || request.max_tokens < 1)) {
      errors.push('max_tokens must be a positive number');
    }

    if (request.temperature !== undefined && (typeof request.temperature !== 'number' || request.temperature < 0 || request.temperature > 2)) {
      errors.push('temperature must be a number between 0 and 2');
    }

    if (request.top_p !== undefined && (typeof request.top_p !== 'number' || request.top_p < 0 || request.top_p > 1)) {
      errors.push('top_p must be a number between 0 and 1');
    }

    // Normalize values
    if (request.temperature === undefined) {
      normalizedRequest.temperature = 0.7;
    }

    if (request.top_p === undefined) {
      normalizedRequest.top_p = 1.0;
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      normalizedRequest
    };
  }

  /**
   * Format chat completion response
   */
  private formatChatCompletionResponse(
    request: OpenAIChatCompletionRequest,
    providerResponse: any
  ): OpenAICompletionResponse {
    const responseData = providerResponse.data || providerResponse;
    return {
      id: responseData.id || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: responseData.choices || [],
      usage: responseData.usage || providerResponse.usage
    };
  }

  /**
   * Format completion response
   */
  private formatCompletionResponse(
    request: OpenAICompletionRequest,
    providerResponse: any
  ): OpenAICompletionResponse {
    const responseData = providerResponse.data || providerResponse;
    return {
      id: responseData.id || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: responseData.choices || [],
      usage: responseData.usage || providerResponse.usage
    };
  }

  /**
   * Extract preferred provider from request context
   */
  private extractPreferredProvider(context: RequestContext): string | undefined {
    // Extract from headers
    const preferredProvider = context.headers['x-preferred-provider'];
    return preferredProvider;
  }

  /**
   * Extract excluded providers from request context
   */
  private extractExcludedProviders(context: RequestContext): string[] | undefined {
    // Extract from headers
    const excluded = context.headers['x-excluded-providers'];
    if (excluded && typeof excluded === 'string') {
      return excluded.split(',').map(p => p.trim());
    }
    return undefined;
  }

  /**
   * Handle error with enhanced error handling system
   */
  private async handleError(error: Error, context: string): Promise<void> {
    try {
      // Use enhanced error handling utilities
      await this.errorUtils.handle(error, context, {
        severity: this.getErrorSeverity(context, error),
        category: this.getErrorCategory(context),
        additionalContext: {
          stack: error.stack,
          name: error.name,
          requestId: this.extractRequestId(context),
          operationType: this.getOperationType(context)
        }
      });
    } catch (handlerError) {
      console.error('Failed to handle error:', handlerError);
      console.error('Original error:', error);
    }
  }

  /**
   * Get error severity based on context and error type
   */
  private getErrorSeverity(context: string, error: Error): 'low' | 'medium' | 'high' | 'critical' {
    const errorName = error.constructor.name;

    // Critical errors
    if (errorName === 'RouteCodexError' && (error as any).status >= 500) {
      return 'critical';
    }

    // High severity errors
    if (context.includes('initialization') ||
        context.includes('provider_unavailable') ||
        errorName === 'TypeError') {
      return 'high';
    }

    // Medium severity errors
    if (context.includes('validation') ||
        context.includes('timeout') ||
        context.includes('rate_limit') ||
        errorName === 'RouteCodexError') {
      return 'medium';
    }

    return 'low';
  }

  /**
   * Get error category based on context
   */
  private getErrorCategory(context: string): string {
    const categories: Record<string, string> = {
      'chat_completion': 'request',
      'completion': 'request',
      'models': 'request',
      'validation': 'validation',
      'provider': 'provider',
      'timeout': 'performance',
      'rate_limit': 'performance',
      'initialization': 'system'
    };

    for (const [key, category] of Object.entries(categories)) {
      if (context.includes(key)) return category;
    }
    return 'general';
  }

  /**
   * Extract request ID from context if available
   */
  private extractRequestId(context: string): string | undefined {
    // This could extract request ID from context or use a tracking system
    return undefined;
  }

  /**
   * Get operation type from context
   */
  private getOperationType(context: string): string {
    if (context.includes('chat_completion')) return 'chat_completion';
    if (context.includes('completion')) return 'completion';
    if (context.includes('models')) return 'models_list';
    return 'unknown';
  }

  /**
   * Update configuration
   */
  public async updateConfig(newConfig: Partial<ServerConfig>): Promise<void> {
    this.config = { ...this.config, ...newConfig };

    this.debugEventBus.publish({
      sessionId: `session_${Date.now()}`,
      moduleId: 'request-handler',
      operationId: 'config_updated',
      timestamp: Date.now(),
      type: 'start',
      position: 'middle',
      data: {
        changes: Object.keys(newConfig)
      }
    });
  }

  /**
   * Get handler status
   */
  public getStatus(): any {
    return {
      initialized: this.isInitialized(),
      running: this.isRunning(),
      options: this.options,
      providerHealth: this.providerManager.getAllProvidersHealth()
    };
  }

  /**
   * Stop request handler
   */
  public async stop(): Promise<void> {
    await this.errorHandling.destroy();
  }

  /**
   * Initialize debug enhancements
   */
  private initializeDebugEnhancements(): void {
    try {
      console.log('RequestHandler debug enhancements initialized');
    } catch (error) {
      console.warn('Failed to initialize RequestHandler debug enhancements:', error);
    }
  }

  /**
   * Record handler metric
   */
  private recordHandlerMetric(operation: string, data: any): void {
    if (!this.handlerMetrics.has(operation)) {
      this.handlerMetrics.set(operation, {
        values: [],
        lastUpdated: Date.now()
      });
    }

    const metric = this.handlerMetrics.get(operation)!;
    metric.values.push(data);
    metric.lastUpdated = Date.now();

    // Keep only last 50 measurements
    if (metric.values.length > 50) {
      metric.values.shift();
    }
  }

  /**
   * Add to request history
   */
  private addToRequestHistory(operation: any): void {
    this.requestHistory.push(operation);

    // Keep only recent history
    if (this.requestHistory.length > this.maxHistorySize) {
      this.requestHistory.shift();
    }
  }

  /**
   * Add to error history
   */
  private addToErrorHistory(operation: any): void {
    this.errorHistory.push(operation);

    // Keep only recent history
    if (this.errorHistory.length > this.maxHistorySize) {
      this.errorHistory.shift();
    }
  }

  /**
   * Get debug status with enhanced information
   */
  getDebugStatus(): any {
    const baseStatus = {
      handlerId: this.getModuleInfo().id,
      name: this.getModuleInfo().name,
      version: this.getModuleInfo().version,
      isInitialized: this.isInitialized(),
      isRunning: this.isRunning(),
      options: this.options,
      isEnhanced: true
    };

    return {
      ...baseStatus,
      debugInfo: this.getDebugInfo(),
      handlerMetrics: this.getHandlerMetrics(),
      requestHistory: [...this.requestHistory.slice(-10)],
      errorHistory: [...this.errorHistory.slice(-10)]
    };
  }

  /**
   * Get detailed debug information
   */
  private getDebugInfo(): any {
    return {
      handlerId: this.getModuleInfo().id,
      name: this.getModuleInfo().name,
      version: this.getModuleInfo().version,
      enhanced: true,
      requestHistorySize: this.requestHistory.length,
      errorHistorySize: this.errorHistory.length,
      handlerMetricsSize: this.handlerMetrics.size,
      maxHistorySize: this.maxHistorySize,
      providerCount: this.providerManager.getActiveProviders().length,
      timeout: this.options.timeout,
      maxRequestSize: this.options.maxRequestSize,
      streamingEnabled: this.options.enableStreaming,
      validationEnabled: this.options.validateRequests
    };
  }

  /**
   * Get handler metrics
   */
  private getHandlerMetrics(): any {
    const metrics: any = {};

    for (const [operation, metric] of this.handlerMetrics.entries()) {
      metrics[operation] = {
        count: metric.values.length,
        lastUpdated: metric.lastUpdated,
        recentValues: metric.values.slice(-5)
      };
    }

    return metrics;
  }
}