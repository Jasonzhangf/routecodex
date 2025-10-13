/**
 * LLMSwitch AJV Adapter
 * Main LLMSwitch module implementation using AJV for validation and conversion
 */

import type {
  LLMSwitchModule,
  ModuleConfig,
  ModuleDependencies,
  LLMSwitchRequest,
  LLMSwitchResponse,
  LLMSwitchAjvConfig,
  ConversionContext,
  ConversionDirection,
  MessageFormat
} from '../types/index.js';
import { ConversionEngine } from './conversion-engine.js';
import { ValidationError, ConversionError } from '../types/index.js';

/**
 * LLMSwitch AJV Adapter
 *
 * Implements the LLMSwitchModule interface using AJV-based validation
 * and conversion for OpenAI <> Anthropic protocols.
 */
export class LLMSwitchAjvAdapter implements LLMSwitchModule {
  readonly id: string;
  readonly type = 'llmswitch-anthropic-openai-ajv';
  readonly protocol = 'bidirectional';
  readonly config: LLMSwitchAjvConfig;

  private isInitialized = false;
  private conversionEngine: ConversionEngine;
  private dependencies: ModuleDependencies;

  constructor(config: ModuleConfig, dependencies: ModuleDependencies) {
    this.config = config as LLMSwitchAjvConfig;
    this.dependencies = dependencies;
    this.id = `llmswitch-ajv-${Date.now()}`;
    this.conversionEngine = new ConversionEngine();
  }

  /**
   * Initialize the module
   */
  async initialize(): Promise<void> {
    try {
      // Validate configuration
      this.validateConfig();

      // Initialize conversion engine
      this.conversionEngine = new ConversionEngine();

      this.isInitialized = true;

      this.logModule('initialized', {
        enableStreaming: this.config.config.enableStreaming,
        enableTools: this.config.config.enableTools,
        strictMode: this.config.config.strictMode,
        fallbackToOriginal: this.config.config.fallbackToOriginal
      });
    } catch (error) {
      this.logError('initialization_failed', error as Error);
      throw error;
    }
  }

  /**
   * Process incoming request (OpenAI <> Anthropic conversion)
   */
  async processIncoming(request: LLMSwitchRequest): Promise<LLMSwitchRequest> {
    if (!this.isInitialized) {
      throw new Error('LLMSwitchAjvAdapter is not initialized');
    }

    const startTime = performance.now();
    const context = this.createConversionContext('incoming');

    try {
      // Extract data from DTO
      const isDto = request && typeof request === 'object' && 'data' in request && 'route' in request;
      const payload = isDto ? (request.data as any) : (request as any);

      // Detect request format
      const requestFormat = this.detectMessageFormat(payload);
      context.originalFormat = requestFormat;

      let transformedRequest: any;

      if (requestFormat === 'anthropic') {
        // Convert Anthropic -> OpenAI
        context.direction = 'anthropic-to-openai';
        context.targetFormat = 'openai';
        transformedRequest = this.conversionEngine.convertAnthropicToOpenAI(payload, context);

        this.logTransformation('anthropic-to-openai-request', payload, transformedRequest);
      } else if (requestFormat === 'openai') {
        // Convert OpenAI -> Anthropic
        context.direction = 'openai-to-anthropic';
        context.targetFormat = 'anthropic';
        transformedRequest = this.conversionEngine.convertOpenAIToAnthropic(payload, context);

        this.logTransformation('openai-to-anthropic-request', payload, transformedRequest);
      } else {
        // Unknown format, pass through
        context.direction = 'passthrough';
        context.targetFormat = requestFormat;
        transformedRequest = payload;
      }

      // Add metadata
      const result = {
        ...transformedRequest,
        _metadata: {
          switchType: this.type,
          direction: context.direction,
          timestamp: Date.now(),
          originalFormat: context.originalFormat,
          targetFormat: context.targetFormat,
          metrics: context.metrics
        }
      };

      const endTime = performance.now();
      context.metrics.totalTime = endTime - startTime;

      // Return in proper format
      return isDto
        ? { ...request, data: result }
        : {
            data: result,
            route: (request as any).route || {
              providerId: 'unknown',
              modelId: 'unknown',
              requestId: `req_${Date.now()}`,
              timestamp: Date.now()
            },
            metadata: {},
            debug: { enabled: false, stages: {} }
          } as LLMSwitchRequest;

    } catch (error) {
      const endTime = performance.now();
      context.metrics.totalTime = endTime - startTime;
      context.metrics.errorCount++;

      this.logError('processIncoming_failed', error as Error, {
        request,
        context
      });

      // Fallback to original implementation if enabled
      if (this.config.config.fallbackToOriginal) {
        this.logModule('fallback_to_original', { error: (error as Error).message });
        return request; // Return original request
      }

      throw error;
    }
  }

  /**
   * Process outgoing response (OpenAI <> Anthropic conversion)
   */
  async processOutgoing(response: LLMSwitchResponse | any): Promise<LLMSwitchResponse | any> {
    if (!this.isInitialized) {
      throw new Error('LLMSwitchAjvAdapter is not initialized');
    }

    const startTime = performance.now();
    const context = this.createConversionContext('outgoing');

    try {
      // Extract data from DTO
      const isDto = response && typeof response === 'object' && 'data' in response && 'metadata' in response;
      let payload = isDto ? (response as LLMSwitchResponse).data : response;

      // Unwrap nested data if needed
      payload = this.unwrapPayload(payload);

      // Detect response format
      const responseFormat = this.detectMessageFormat(payload);
      context.originalFormat = responseFormat;

      let transformedResponse: any;

      if (responseFormat === 'openai') {
        // Convert OpenAI -> Anthropic
        context.direction = 'openai-to-anthropic';
        context.targetFormat = 'anthropic';
        transformedResponse = this.conversionEngine.convertOpenAIToAnthropicResponse(payload, context);

        this.logTransformation('openai-to-anthropic-response', payload, transformedResponse);
      } else if (responseFormat === 'anthropic') {
        // Convert Anthropic -> OpenAI
        context.direction = 'anthropic-to-openai';
        context.targetFormat = 'openai';
        transformedResponse = this.conversionEngine.convertAnthropicToOpenAIResponse(payload, context);

        this.logTransformation('anthropic-to-openai-response', payload, transformedResponse);
      } else {
        // Unknown format, pass through
        context.direction = 'passthrough';
        context.targetFormat = responseFormat;
        transformedResponse = payload;
      }

      // Add metadata
      const result = {
        ...transformedResponse,
        _metadata: {
          ...(payload?._metadata || {}),
          switchType: this.type,
          direction: context.direction,
          responseTimestamp: Date.now(),
          originalFormat: context.originalFormat,
          targetFormat: context.targetFormat,
          metrics: context.metrics
        }
      };

      const endTime = performance.now();
      context.metrics.totalTime = endTime - startTime;

      // Return in proper format
      return isDto
        ? { ...(response as LLMSwitchResponse), data: result }
        : result;

    } catch (error) {
      const endTime = performance.now();
      context.metrics.totalTime = endTime - startTime;
      context.metrics.errorCount++;

      this.logError('processOutgoing_failed', error as Error, {
        response,
        context
      });

      // Fallback to original implementation if enabled
      if (this.config.config.fallbackToOriginal) {
        this.logModule('fallback_to_original', { error: (error as Error).message });
        return response; // Return original response
      }

      throw error;
    }
  }

  /**
   * Transform request (simplified interface)
   */
  async transformRequest(input: any): Promise<any> {
    const mockRequest = {
      data: input,
      route: {
        providerId: 'unknown',
        modelId: 'unknown',
        requestId: `req_${Date.now()}`,
        timestamp: Date.now()
      },
      metadata: {},
      debug: { enabled: false, stages: {} }
    } as LLMSwitchRequest;

    const result = await this.processIncoming(mockRequest);
    return result.data;
  }

  /**
   * Transform response (simplified interface)
   */
  async transformResponse(input: any): Promise<any> {
    const mockResponse = {
      data: input,
      metadata: {}
    } as LLMSwitchResponse;

    const result = await this.processOutgoing(mockResponse);
    return result.data;
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    this.isInitialized = false;

    // Clean up schema mapper cache
    const schemaMapper = this.conversionEngine.getSchemaMapper();
    schemaMapper.clearCache();

    this.logModule('cleanup', {});
  }

  /**
   * Get performance metrics
   */
  getMetrics(): any {
    const schemaMapper = this.conversionEngine.getSchemaMapper();
    return {
      schemaMapper: schemaMapper.getMetrics(),
      cacheStats: schemaMapper.getCacheStats()
    };
  }

  // Private helper methods

  /**
   * Validate module configuration
   */
  private validateConfig(): void {
    if (!this.config) {
      throw new Error('Configuration is required');
    }

    if (!this.config.config) {
      throw new Error('Conversion config is required');
    }

    // Set default values
    this.config.config.enableStreaming = this.config.config.enableStreaming ?? true;
    this.config.config.enableTools = this.config.config.enableTools ?? true;
    this.config.config.strictMode = this.config.config.strictMode ?? false;
    this.config.config.fallbackToOriginal = this.config.config.fallbackToOriginal ?? true;
    this.config.config.performanceMonitoring = this.config.config.performanceMonitoring ?? true;
    this.config.config.customSchemas = this.config.config.customSchemas || {};
  }

  /**
   * Create conversion context
   */
  private createConversionContext(type: 'incoming' | 'outgoing'): ConversionContext {
    return {
      requestId: `${type}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      direction: 'openai-to-anthropic', // Default, will be updated
      originalFormat: 'unknown',
      targetFormat: 'unknown',
      metrics: {
        conversionTime: 0,
        validationTime: 0,
        totalTime: 0,
        schemaCacheHits: 0,
        schemaCacheMisses: 0,
        errorCount: 0
      }
    };
  }

  /**
   * Detect message format
   */
  private detectMessageFormat(payload: any): MessageFormat {
    if (!payload || typeof payload !== 'object') {
      return 'unknown';
    }

    // Check for Anthropic format
    if (
      (Array.isArray(payload.messages) && payload.messages.some((m: any) => m.content && Array.isArray(m.content))) ||
      (payload.content && Array.isArray(payload.content) && payload.content.some((c: any) => c.type))
    ) {
      return 'anthropic';
    }

    // Check for OpenAI format
    if (
      (Array.isArray(payload.messages) && payload.messages.some((m: any) => m.role === 'system' || m.tool_calls)) ||
      (payload.choices && Array.isArray(payload.choices))
    ) {
      return 'openai';
    }

    return 'unknown';
  }

  /**
   * Unwrap nested payload
   */
  private unwrapPayload(payload: any): any {
    let current = payload;
    const seen = new Set<any>();

    while (current && typeof current === 'object' && !Array.isArray(current) && !seen.has(current)) {
      seen.add(current);

      // If we find OpenAI choices or Anthropic content, stop unwrapping
      if ('choices' in current || 'content' in current) {
        break;
      }

      // If there's a nested data object, unwrap it
      if ('data' in current && current.data && typeof current.data === 'object') {
        current = current.data;
        continue;
      }

      break;
    }

    return current;
  }

  /**
   * Log module events
   */
  private logModule(event: string, data: any): void {
    try {
      if (this.dependencies?.logger) {
        this.dependencies.logger.logModule(this.id, event, data);
      }
    } catch (error) {
      // Ignore logging errors
    }
  }

  /**
   * Log transformation events
   */
  private logTransformation(type: string, input: any, output: any): void {
    try {
      if (this.dependencies?.logger) {
        this.dependencies.logger.logTransformation(this.id, type, input, output);
      }
    } catch (error) {
      // Ignore logging errors
    }
  }

  /**
   * Log errors
   */
  private logError(event: string, error: Error, context?: any): void {
    try {
      if (this.dependencies?.logger) {
        this.dependencies.logger.logError(this.id, error, context);
      }
    } catch (error) {
      // Ignore logging errors
    }
  }
}