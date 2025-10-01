/**
 * Qwen Compatibility Module
 *
 * Handles OpenAI to Qwen API format transformations with OAuth authentication.
 * Implements protocol translation and tool calling format conversion.
 */

import type { CompatibilityModule, ModuleConfig, ModuleDependencies, TransformationRule } from '../../interfaces/pipeline-interfaces.js';
import type { SharedPipelineRequest } from '../../../../types/shared-dtos.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';
import { DebugEventBus } from "rcc-debugcenter";

/**
 * Qwen Compatibility Module
 */
export class QwenCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'qwen-compatibility';
  readonly config: ModuleConfig;
  readonly rules: TransformationRule[];

  private isInitialized = false;
  private logger: PipelineDebugLogger;
  private transformationEngine: any; // TransformationEngine instance

  // Debug enhancement properties
  private debugEventBus: DebugEventBus | null = null;
  private isDebugEnhanced = false;
  private compatibilityMetrics: Map<string, any> = new Map();
  private transformationHistory: any[] = [];
  private errorHistory: any[] = [];
  private maxHistorySize = 50;

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.logger = dependencies.logger as any;
    this.id = `compatibility-${Date.now()}`;
    this.config = config;
    this.rules = this.initializeTransformationRules();

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
      console.log('Qwen Compatibility debug enhancements initialized');
    } catch (error) {
      console.warn('Failed to initialize Qwen Compatibility debug enhancements:', error);
      this.isDebugEnhanced = false;
    }
  }

  /**
   * Record compatibility metric
   */
  private recordCompatibilityMetric(operation: string, data: any): void {
    if (!this.compatibilityMetrics.has(operation)) {
      this.compatibilityMetrics.set(operation, {
        values: [],
        lastUpdated: Date.now()
      });
    }

    const metric = this.compatibilityMetrics.get(operation)!;
    metric.values.push(data);
    metric.lastUpdated = Date.now();

    // Keep only last 50 measurements
    if (metric.values.length > 50) {
      metric.values.shift();
    }
  }

  /**
   * Add to transformation history
   */
  private addToTransformationHistory(transformation: any): void {
    this.transformationHistory.push(transformation);

    // Keep only recent history
    if (this.transformationHistory.length > this.maxHistorySize) {
      this.transformationHistory.shift();
    }
  }

  /**
   * Add to error history
   */
  private addToErrorHistory(error: any): void {
    this.errorHistory.push(error);

    // Keep only recent history
    if (this.errorHistory.length > this.maxHistorySize) {
      this.errorHistory.shift();
    }
  }

  /**
   * Publish debug event
   */
  private publishDebugEvent(type: string, data: any): void {
    if (!this.isDebugEnhanced || !this.debugEventBus) {return;}

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'qwen-compatibility',
        operationId: type,
        timestamp: Date.now(),
        type: "start",
        position: 'middle',
        data: {
          ...data,
          compatibilityId: this.id,
          source: 'qwen-compatibility'
        }
      });
    } catch (error) {
      // Silent fail if debug event bus is not available
    }
  }

  /**
   * Get debug status with enhanced information
   */
  getDebugStatus(): any {
    const baseStatus = {
      compatibilityId: this.id,
      isInitialized: this.isInitialized,
      type: this.type,
      isEnhanced: this.isDebugEnhanced
    };

    if (!this.isDebugEnhanced) {
      return baseStatus;
    }

    return {
      ...baseStatus,
      debugInfo: this.getDebugInfo(),
      compatibilityMetrics: this.getCompatibilityMetrics(),
      transformationHistory: [...this.transformationHistory.slice(-10)], // Last 10 transformations
      errorHistory: [...this.errorHistory.slice(-10)] // Last 10 errors
    };
  }

  /**
   * Get detailed debug information
   */
  private getDebugInfo(): any {
    return {
      compatibilityId: this.id,
      compatibilityType: this.type,
      enhanced: this.isDebugEnhanced,
      eventBusAvailable: !!this.debugEventBus,
      transformationHistorySize: this.transformationHistory.length,
      errorHistorySize: this.errorHistory.length,
      rulesCount: this.rules.length,
      hasTransformationEngine: !!this.transformationEngine
    };
  }

  /**
   * Get compatibility metrics
   */
  private getCompatibilityMetrics(): any {
    const metrics: any = {};

    for (const [operation, metric] of this.compatibilityMetrics.entries()) {
      metrics[operation] = {
        count: metric.values.length,
        lastUpdated: metric.lastUpdated,
        recentValues: metric.values.slice(-5) // Last 5 values
      };
    }

    return metrics;
  }

  /**
   * Initialize the compatibility module
   */
  async initialize(): Promise<void> {
    const startTime = Date.now();
    const initId = `init_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Debug: Record initialization start
    if (this.isDebugEnhanced) {
      this.recordCompatibilityMetric('initialization_start', {
        initId,
        rulesCount: this.rules.length,
        timestamp: startTime
      });
      this.publishDebugEvent('initialization_start', {
        initId,
        rulesCount: this.rules.length,
        timestamp: startTime
      });
    }

    try {
      this.logger.logModule(this.id, 'initializing', {
        config: this.config,
        type: this.type
      });

      // Initialize transformation engine
      const { TransformationEngine } = await import('../../utils/transformation-engine.js');
      this.transformationEngine = new TransformationEngine();

      this.isInitialized = true;
      this.logger.logModule(this.id, 'initialized');

      const totalTime = Date.now() - startTime;

      // Debug: Record initialization completion
      if (this.isDebugEnhanced) {
        this.recordCompatibilityMetric('initialization_complete', {
          initId,
          success: true,
          totalTime,
          hasTransformationEngine: !!this.transformationEngine
        });
        this.publishDebugEvent('initialization_complete', {
          initId,
          success: true,
          totalTime,
          hasTransformationEngine: !!this.transformationEngine
        });
      }

    } catch (error) {
      const totalTime = Date.now() - startTime;

      // Debug: Record initialization failure
      if (this.isDebugEnhanced) {
        this.recordCompatibilityMetric('initialization_failed', {
          initId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
        this.addToErrorHistory({
          initId,
          error,
          startTime,
          endTime: Date.now(),
          totalTime,
          operation: 'initialize'
        });
        this.publishDebugEvent('initialization_failed', {
          initId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
      }

      this.logger.logModule(this.id, 'initialization-error', { error });
      throw error;
    }
  }

  /**
   * Process incoming request - Transform OpenAI format to Qwen format
   */
  async processIncoming(requestParam: any): Promise<SharedPipelineRequest> {
    const startTime = Date.now();
    const transformId = `transform_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    if (!this.isInitialized) {
      throw new Error('Qwen Compatibility module is not initialized');
    }

    const isDto = requestParam && typeof requestParam === 'object' && 'data' in requestParam && 'route' in requestParam;
    const dto = isDto ? (requestParam as SharedPipelineRequest) : null;
    const request = isDto ? (dto!.data as any) : (requestParam as any);

    // Debug: Record transformation start
    if (this.isDebugEnhanced) {
      this.recordCompatibilityMetric('transformation_start', {
        transformId,
        originalFormat: 'openai',
        targetFormat: 'qwen',
        hasTools: !!request.tools,
        model: request.model,
        messageCount: request.messages?.length || 0,
        timestamp: startTime
      });
      this.publishDebugEvent('transformation_start', {
        transformId,
        request,
        timestamp: startTime
      });
    }

    try {
      this.logger.logModule(this.id, 'transform-request-start', {
        originalFormat: 'openai',
        targetFormat: 'qwen',
        hasTools: !!request.tools
      });

      // Apply transformation rules
      const transformed = await this.transformationEngine.transform(request, this.rules);

      const converted = this.convertToQwenRequest(transformed.data || transformed);

      const totalTime = Date.now() - startTime;

      // Debug: Record transformation completion
      if (this.isDebugEnhanced) {
        this.recordCompatibilityMetric('transformation_complete', {
          transformId,
          success: true,
          totalTime,
          transformationCount: transformed.transformationCount || 0,
          hasInput: Array.isArray(converted.input),
          parameterKeys: Object.keys(converted.parameters || {}),
          model: converted.model,
          rulesApplied: this.rules.length
        });
        this.addToTransformationHistory({
          transformId,
          request,
          result: converted,
          startTime,
          endTime: Date.now(),
          totalTime,
          success: true,
          transformationCount: transformed.transformationCount || 0
        });
        this.publishDebugEvent('transformation_complete', {
          transformId,
          success: true,
          totalTime,
          transformed,
          converted
        });
      }

      this.logger.logModule(this.id, 'transform-request-success', {
        transformationCount: transformed.transformationCount || 0,
        hasInput: Array.isArray(converted.input),
        parameterKeys: Object.keys(converted.parameters || {})
      });

      return isDto ? { ...dto!, data: converted } : { data: converted, route: { providerId: 'unknown', modelId: 'unknown', requestId: 'unknown', timestamp: Date.now() }, metadata: {}, debug: { enabled: false, stages: {} } } as SharedPipelineRequest;

    } catch (error) {
      const totalTime = Date.now() - startTime;

      // Debug: Record transformation failure
      if (this.isDebugEnhanced) {
        this.recordCompatibilityMetric('transformation_failed', {
          transformId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
        this.addToErrorHistory({
          transformId,
          error,
          request,
          startTime,
          endTime: Date.now(),
          totalTime,
          operation: 'processIncoming'
        });
        this.publishDebugEvent('transformation_failed', {
          transformId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
      }

      this.logger.logModule(this.id, 'transformation-error', { error });
      throw error;
    }
  }

  /**
   * Process outgoing response - Transform Qwen format to OpenAI format
   */
  async processOutgoing(response: any): Promise<any> {
    const startTime = Date.now();
    const responseId = `response_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    if (!this.isInitialized) {
      throw new Error('Qwen Compatibility module is not initialized');
    }

    // Debug: Record response transformation start
    if (this.isDebugEnhanced) {
      this.recordCompatibilityMetric('response_transform_start', {
        responseId,
        originalFormat: 'qwen',
        targetFormat: 'openai',
        hasData: !!response.data,
        hasChoices: !!(response.data?.choices || response.choices),
        timestamp: startTime
      });
      this.publishDebugEvent('response_transform_start', {
        responseId,
        response,
        timestamp: startTime
      });
    }

    try {
      const isDto = response && typeof response === 'object' && 'data' in response && 'metadata' in response;
      const payload = isDto ? (response as any).data : response;
      this.logger.logModule(this.id, 'transform-response-start', { originalFormat: 'qwen', targetFormat: 'openai' });

      // Transform response back to OpenAI format
      const transformed = this.transformQwenResponseToOpenAI(payload);

      const totalTime = Date.now() - startTime;

      // Debug: Record response transformation completion
      if (this.isDebugEnhanced) {
        this.recordCompatibilityMetric('response_transform_complete', {
          responseId,
          success: true,
          totalTime,
          transformedResponseId: transformed.id,
          hasChoices: Array.isArray(transformed.choices),
          choiceCount: transformed.choices?.length || 0,
          hasToolCalls: transformed.choices?.some((c: any) => c.message?.tool_calls?.length > 0)
        });
        this.addToTransformationHistory({
          responseId,
          request: response,
          result: transformed,
          startTime,
          endTime: Date.now(),
          totalTime,
          success: true,
          operation: 'processOutgoing'
        });
        this.publishDebugEvent('response_transform_complete', {
          responseId,
          success: true,
          totalTime,
          transformed
        });
      }

      this.logger.logModule(this.id, 'transform-response-success', {
        responseId: transformed.id
      });

      return isDto ? { ...(response as any), data: transformed } : transformed;

    } catch (error) {
      const totalTime = Date.now() - startTime;

      // Debug: Record response transformation failure
      if (this.isDebugEnhanced) {
        this.recordCompatibilityMetric('response_transform_failed', {
          responseId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
        this.addToErrorHistory({
          responseId,
          error,
          request: response,
          startTime,
          endTime: Date.now(),
          totalTime,
          operation: 'processOutgoing'
        });
        this.publishDebugEvent('response_transform_failed', {
          responseId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
      }

      this.logger.logModule(this.id, 'response-transformation-error', { error });
      throw error;
    }
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    const startTime = Date.now();
    const cleanupId = `cleanup_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Debug: Record cleanup start
    if (this.isDebugEnhanced) {
      this.recordCompatibilityMetric('cleanup_start', {
        cleanupId,
        isInitialized: this.isInitialized,
        transformationHistorySize: this.transformationHistory.length,
        errorHistorySize: this.errorHistory.length,
        metricsCount: this.compatibilityMetrics.size,
        timestamp: startTime
      });
      this.publishDebugEvent('cleanup_start', {
        cleanupId,
        isInitialized: this.isInitialized,
        timestamp: startTime
      });
    }

    try {
      this.logger.logModule(this.id, 'cleanup-start');

      const wasInitialized = this.isInitialized;
      this.isInitialized = false;

      const totalTime = Date.now() - startTime;

      // Debug: Record cleanup completion
      if (this.isDebugEnhanced) {
        this.recordCompatibilityMetric('cleanup_complete', {
          cleanupId,
          success: true,
          totalTime,
          wasInitialized,
          finalTransformationHistorySize: this.transformationHistory.length,
          finalErrorHistorySize: this.errorHistory.length,
          finalMetricsCount: this.compatibilityMetrics.size
        });
        this.publishDebugEvent('cleanup_complete', {
          cleanupId,
          success: true,
          totalTime,
          wasInitialized
        });
      }

      this.logger.logModule(this.id, 'cleanup-complete');
    } catch (error) {
      const totalTime = Date.now() - startTime;

      // Debug: Record cleanup failure
      if (this.isDebugEnhanced) {
        this.recordCompatibilityMetric('cleanup_failed', {
          cleanupId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
        this.addToErrorHistory({
          cleanupId,
          error,
          startTime,
          endTime: Date.now(),
          totalTime,
          operation: 'cleanup'
        });
        this.publishDebugEvent('cleanup_failed', {
          cleanupId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
      }

      this.logger.logModule(this.id, 'cleanup-error', { error });
      throw error;
    }
  }

  /**
   * Get compatibility module status
   */
  getStatus(): {
    id: string;
    type: string;
    isInitialized: boolean;
    ruleCount: number;
    lastActivity: number;
  } {
    return {
      id: this.id,
      type: this.type,
      isInitialized: this.isInitialized,
      ruleCount: this.rules.length,
      lastActivity: Date.now()
    };
  }

  /**
   * Get transformation metrics
   */
  async getMetrics(): Promise<any> {
    return {
      transformationCount: 0,
      successCount: 0,
      errorCount: 0,
      averageTransformationTime: 0,
      ruleCount: this.rules.length,
      timestamp: Date.now()
    };
  }

  /**
   * Apply compatibility transformations
   */
  async applyTransformations(data: any, rules: TransformationRule[]): Promise<any> {
    const startTime = Date.now();
    const transformId = `custom_transform_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Debug: Record custom transformation start
    if (this.isDebugEnhanced) {
      this.recordCompatibilityMetric('custom_transformation_start', {
        transformId,
        rulesCount: rules.length,
        dataType: typeof data,
        timestamp: startTime
      });
      this.publishDebugEvent('custom_transformation_start', {
        transformId,
        data,
        rules,
        timestamp: startTime
      });
    }

    try {
      const result = await this.transformationEngine.transform(data, rules);
      const totalTime = Date.now() - startTime;

      // Debug: Record custom transformation completion
      if (this.isDebugEnhanced) {
        this.recordCompatibilityMetric('custom_transformation_complete', {
          transformId,
          success: true,
          totalTime,
          transformationCount: result.transformationCount || 0,
          hasData: !!result.data
        });
        this.addToTransformationHistory({
          transformId,
          request: { data, rules },
          result: result.data || result,
          startTime,
          endTime: Date.now(),
          totalTime,
          success: true,
          operation: 'applyTransformations'
        });
        this.publishDebugEvent('custom_transformation_complete', {
          transformId,
          success: true,
          totalTime,
          result
        });
      }

      return result;
    } catch (error) {
      const totalTime = Date.now() - startTime;

      // Debug: Record custom transformation failure
      if (this.isDebugEnhanced) {
        this.recordCompatibilityMetric('custom_transformation_failed', {
          transformId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
        this.addToErrorHistory({
          transformId,
          error,
          request: { data, rules },
          startTime,
          endTime: Date.now(),
          totalTime,
          operation: 'applyTransformations'
        });
        this.publishDebugEvent('custom_transformation_failed', {
          transformId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
      }

      throw error;
    }
  }

  /**
   * Initialize transformation rules for Qwen API
   */
  private initializeTransformationRules(): TransformationRule[] {
    const compatibilityConfig = this.config.config as any;

    // Default transformation rules for Qwen API
    const transformationRules = [
      // Model name mapping
      {
        id: 'map-model-names',
        transform: 'mapping',
        sourcePath: 'model',
        targetPath: 'model',
        mapping: {
          'gpt-3.5-turbo': 'qwen-turbo',
          'gpt-4': 'qwen3-coder-plus',
          'gpt-4-turbo': 'qwen3-coder-plus',
          'gpt-4o': 'qwen3-coder-plus'
        }
      },
      // Tools format conversion
      {
        id: 'ensure-tools-format',
        transform: 'mapping',
        sourcePath: 'tools',
        targetPath: 'tools',
        mapping: {
          'type': 'type',
          'function': 'function'
        }
      },
      // Stream parameter mapping
      {
        id: 'map-stream-parameter',
        transform: 'mapping',
        sourcePath: 'stream',
        targetPath: 'stream',
        mapping: {
          'true': true,
          'false': false
        }
      },
      // Temperature and max_tokens pass-through are optional; defaults handled by provider
    ];

    // Add custom rules from configuration
    if (compatibilityConfig.customRules) {
      transformationRules.push(...compatibilityConfig.customRules);
    }

    this.logger.logModule(this.id, 'transformation-rules-initialized', {
      ruleCount: transformationRules.length
    });

    return transformationRules as TransformationRule[];
  }

  /**
   * Transform Qwen response to OpenAI format
   */
  private transformQwenResponseToOpenAI(response: any): any {
    // Handle different response formats
    if (response.data) {
      // Provider response format
      return this.transformProviderResponse(response.data);
    } else {
      // Direct response format
      return this.transformProviderResponse(response);
    }
  }

  /**
   * Transform provider response to OpenAI format
   */
  private transformProviderResponse(data: any): any {
    const transformed = {
      id: data.id || `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Date.now(),
      model: data.model || 'qwen-turbo',
      choices: [],
      usage: data.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    };

    // Transform choices
    if (data.choices && Array.isArray(data.choices)) {
      transformed.choices = data.choices.map((choice: any) => ({
        index: choice.index || 0,
        message: {
          role: choice.message?.role || 'assistant',
          content: choice.message?.content || '',
          tool_calls: this.transformToolCalls(choice.message?.tool_calls)
        },
        finish_reason: this.transformFinishReason(choice.finish_reason)
      }));
    }

    // Add transformation metadata
    (transformed as any)._transformed = true;
    (transformed as any)._originalFormat = 'qwen';
    (transformed as any)._targetFormat = 'openai';

    return transformed;
  }

  /**
   * Transform tool calls from Qwen format to OpenAI format
   */
  private transformToolCalls(toolCalls: any[]): any[] {
    if (!toolCalls || !Array.isArray(toolCalls)) {
      return [];
    }

    return toolCalls.map((toolCall, index) => ({
      id: toolCall.id || `call_${Date.now()}_${index}`,
      type: 'function',
      function: {
        name: toolCall.function?.name || '',
        arguments: typeof toolCall.function?.arguments === 'string'
          ? toolCall.function.arguments
          : JSON.stringify(toolCall.function?.arguments || {})
      }
    }));
  }

  /**
   * Transform finish reason from Qwen format to OpenAI format
   */
  private transformFinishReason(finishReason: string): string {
    const reasonMap: { [key: string]: string } = {
      'stop': 'stop',
      'length': 'length',
      'tool_calls': 'tool_calls',
      'content_filter': 'content_filter'
    };

    return reasonMap[finishReason] || finishReason || 'stop';
  }

  /**
   * Convert OpenAI-style request into Qwen API payload
   */
  private convertToQwenRequest(request: any): any {
    if (!request || typeof request !== 'object') {
      return request;
    }

    // If request already has Qwen input structure, assume it is correct.
    if (Array.isArray(request.input)) {
      return request;
    }

    const qwenRequest: any = {};

    // Model mapping already handled by transformation rules, but ensure fallback
    qwenRequest.model = request.model;

    // Convert messages -> input structure expected by Qwen portal API, but retain original messages field
    if (Array.isArray(request.messages)) {
      qwenRequest.messages = request.messages;
      qwenRequest.input = request.messages.map((message: any) => {
        const normalizedContent = this.normalizeMessageContent(message?.content);
        return {
          role: message?.role || 'user',
          content: normalizedContent
        };
      });
    }

    // Parameters block
    const parameters: Record<string, any> = {};
    if (typeof request.temperature === 'number') {
      parameters.temperature = request.temperature;
    }
    if (typeof request.top_p === 'number') {
      parameters.top_p = request.top_p;
    }
    if (typeof request.frequency_penalty === 'number') {
      parameters.frequency_penalty = request.frequency_penalty;
    }
    if (typeof request.presence_penalty === 'number') {
      parameters.presence_penalty = request.presence_penalty;
    }
    if (typeof request.max_tokens === 'number') {
      parameters.max_output_tokens = request.max_tokens;
    }
    if (request.stop !== undefined) {
      const stops = Array.isArray(request.stop) ? request.stop : [request.stop];
      parameters.stop_sequences = stops.filter(Boolean);
    }
    if (typeof request.stream === 'boolean') {
      qwenRequest.stream = request.stream;
    }
    if (typeof request.debug === 'boolean') {
      parameters.debug = request.debug;
    }

    if (Object.keys(parameters).length > 0) {
      qwenRequest.parameters = parameters;
    }

    // Optional OpenAI fields that Qwen API also supports
    if (typeof request.stream === 'boolean') {
      qwenRequest.stream = request.stream;
    }
    if (request.response_format) {
      qwenRequest.response_format = request.response_format;
    }
    if (typeof request.user === 'string') {
      qwenRequest.user = request.user;
    }

    // Copy tool definitions if present (Qwen expects array under tools?)
    if (Array.isArray(request.tools)) {
      qwenRequest.tools = request.tools;
    }

    // Attach metadata passthrough if present
    if (request.metadata && typeof request.metadata === 'object') {
      qwenRequest.metadata = request.metadata;
    }

    return qwenRequest;
  }

  /**
   * Normalize message content into Qwen's expected format
   */
  private normalizeMessageContent(content: any): any[] {
    if (content === undefined || content === null) {
      return [{ text: '' }];
    }

    if (Array.isArray(content)) {
      return content.map(item => {
        if (typeof item === 'string') {
          return { text: item };
        }
        if (item && typeof item === 'object') {
          if ('text' in item) {
            return { text: String((item as any).text) };
          }
          if ('type' in item && item.type === 'input_text' && 'text' in item) {
            return { text: String((item as any).text) };
          }
          return item;
        }
        return { text: String(item) };
      });
    }

    if (typeof content === 'string') {
      return [{ text: content }];
    }

    if (typeof content === 'object' && content !== null) {
      if ('text' in content) {
        return [{ text: String(content.text) }];
      }
      if ('type' in content && content.type === 'input_text' && 'text' in content) {
        return [{ text: String(content.text) }];
      }
    }

    return [{ text: String(content) }];
  }
}
