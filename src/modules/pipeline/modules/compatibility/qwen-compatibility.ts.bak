/**
 * Qwen Compatibility Module
 *
 * Handles OpenAI to Qwen API format transformations with OAuth authentication.
 * Implements protocol translation and tool calling format conversion.
 */

import type { CompatibilityModule, ModuleConfig, ModuleDependencies, TransformationRule } from '../../interfaces/pipeline-interfaces.js';
import type { SharedPipelineRequest } from '../../../../types/shared-dtos.js';
import type { /* TransformationEngine */ } from '../../utils/transformation-engine.js';
import { DebugEventBus } from "rcc-debugcenter";
import type { PipelineDebugLogger as PipelineDebugLoggerInterface } from '../../interfaces/pipeline-interfaces.js';
import type { UnknownObject, /* LogData */ } from '../../../../types/common-types.js';

/**
 * Qwen Compatibility Module
 */
export class QwenCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'qwen-compatibility';
  readonly config: ModuleConfig;
  readonly rules: TransformationRule[];

  private isInitialized = false;
  private logger: PipelineDebugLoggerInterface;
  private transformationEngine: any; // TransformationEngine instance

  // Debug enhancement properties
  private debugEventBus: DebugEventBus | null = null;
  private isDebugEnhanced = false;
  private compatibilityMetrics: Map<string, { values: any[]; lastUpdated: number }> = new Map();
  private transformationHistory: any[] = [];
  private errorHistory: any[] = [];
  private maxHistorySize = 50;

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.logger = dependencies.logger;
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
          ...(typeof data === 'object' && data !== null ? data as Record<string, unknown> : {}),
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
    const metrics: Record<string, unknown> = {};

    for (const [operation, metric] of this.compatibilityMetrics.entries()) {
      metrics[operation] = {
        count: Array.isArray(metric.values) ? metric.values.length : 0,
        lastUpdated: metric.lastUpdated,
        recentValues: Array.isArray(metric.values) ? metric.values.slice(-5) : [] // Last 5 values
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

    const isDto = this.isSharedPipelineRequest(requestParam);
    const dto = isDto ? requestParam as SharedPipelineRequest : null;
    const request = isDto ? (dto!.data as unknown) : requestParam;

    // Debug: Record transformation start
    if (this.isDebugEnhanced) {
      const reqObj = (request as Record<string, unknown>) || {};
      const hasTools = !!(reqObj as Record<string, unknown>).tools;
      const model = (reqObj as Record<string, unknown>).model as unknown;
      const msgs = Array.isArray(reqObj.messages as unknown) ? (reqObj.messages as unknown[]) : [];
      this.recordCompatibilityMetric('transformation_start', {
        transformId,
        originalFormat: 'openai',
        targetFormat: 'qwen',
        hasTools,
        model,
        messageCount: msgs.length,
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
        hasTools: !!(request as UnknownObject).tools
      });

      // Apply transformation rules
      if (!this.transformationEngine) {
        throw new Error('Transformation engine not initialized');
      }
      const engine = this.transformationEngine as any;
      const transformed = await engine.transform(request, this.rules);

      const converted = this.convertToQwenRequest(this.extractTransformationResult(transformed));

      const totalTime = Date.now() - startTime;

      // Debug: Record transformation completion
      if (this.isDebugEnhanced) {
        const transformedObj = typeof transformed === 'object' && transformed !== null ? transformed as UnknownObject : {};
        const convertedObj = typeof converted === 'object' && converted !== null ? converted as UnknownObject : {};
        
        this.recordCompatibilityMetric('transformation_complete', {
          transformId,
          success: true,
          totalTime,
          transformationCount: typeof transformedObj.transformationCount === 'number' ? transformedObj.transformationCount : 0,
          hasInput: Array.isArray(convertedObj.input),
          parameterKeys: convertedObj.parameters && typeof convertedObj.parameters === 'object' ? Object.keys(convertedObj.parameters) : [],
          model: typeof convertedObj.model === 'string' ? convertedObj.model : undefined,
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
          transformationCount: (transformed as UnknownObject).transformationCount || 0
        });
        this.publishDebugEvent('transformation_complete', {
          transformId,
          success: true,
          totalTime,
          transformed,
          converted
        });
      }

      const transformedObj = typeof transformed === 'object' && transformed !== null ? transformed as UnknownObject : {};
      const convertedObj = typeof converted === 'object' && converted !== null ? converted as UnknownObject : {};
      
      this.logger.logModule(this.id, 'transform-request-success', {
        transformationCount: typeof transformedObj.transformationCount === 'number' ? transformedObj.transformationCount : 0,
        hasInput: Array.isArray(convertedObj.input),
        parameterKeys: convertedObj.parameters && typeof convertedObj.parameters === 'object' ? Object.keys(convertedObj.parameters) : []
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
  async processOutgoing(response: any): Promise<unknown> {
    const startTime = Date.now();
    const responseId = `response_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    if (!this.isInitialized) {
      throw new Error('Qwen Compatibility module is not initialized');
    }

    // Debug: Record response transformation start
    if (this.isDebugEnhanced) {
      const respObj = (response as Record<string, unknown>) || {};
      const dataObj = (respObj.data as Record<string, unknown> | undefined);
      const hasChoices = Array.isArray((dataObj?.choices as unknown)) || Array.isArray((respObj.choices as unknown));
      this.recordCompatibilityMetric('response_transform_start', {
        responseId,
        originalFormat: 'qwen',
        targetFormat: 'openai',
        hasData: !!dataObj,
        hasChoices,
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
      const payload = isDto ? (response as Record<string, unknown>).data : response;
      this.logger.logModule(this.id, 'transform-response-start', { originalFormat: 'qwen', targetFormat: 'openai' });

      // Transform response back to OpenAI format
      const transformed = this.transformQwenResponseToOpenAI(payload);

      const totalTime = Date.now() - startTime;

      // Debug: Record response transformation completion
      if (this.isDebugEnhanced) {
        const transformedObj = typeof transformed === 'object' && transformed !== null ? transformed as Record<string, unknown> : {};
        const choices = Array.isArray(transformedObj.choices) ? transformedObj.choices : [];
        
        this.recordCompatibilityMetric('response_transform_complete', {
          responseId,
          success: true,
          totalTime,
          transformedResponseId: typeof transformedObj.id === 'string' ? transformedObj.id : undefined,
          hasChoices: Array.isArray(transformedObj.choices),
          choiceCount: choices.length,
          hasToolCalls: choices.some((c: any) => {
            if (c && typeof c === 'object') {
              const choiceObj = c as Record<string, unknown>;
              if (choiceObj.message && typeof choiceObj.message === 'object') {
                const messageObj = choiceObj.message as Record<string, unknown>;
                return messageObj.tool_calls && Array.isArray(messageObj.tool_calls) && messageObj.tool_calls.length > 0;
              }
            }
            return false;
          })
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

      const transformedObj = typeof transformed === 'object' && transformed !== null ? transformed as Record<string, unknown> : {};
      
      this.logger.logModule(this.id, 'transform-response-success', {
        responseId: typeof transformedObj.id === 'string' ? transformedObj.id : undefined
      });

      return isDto ? { ...(response as Record<string, unknown>), data: transformed } : transformed;

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
  async getMetrics(): Promise<unknown> {
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
  async applyTransformations(data: any, rules: TransformationRule[]): Promise<unknown> {
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
      if (!this.transformationEngine) {
        throw new Error('Transformation engine not initialized');
      }
      const engine = this.transformationEngine as any;
      const result = await engine.transform(data, rules);
      const totalTime = Date.now() - startTime;

      // Debug: Record custom transformation completion
      if (this.isDebugEnhanced) {
        const resultObj = typeof result === 'object' && result !== null ? result as Record<string, unknown> : {};
        
        this.recordCompatibilityMetric('custom_transformation_complete', {
          transformId,
          success: true,
          totalTime,
          transformationCount: typeof resultObj.transformationCount === 'number' ? resultObj.transformationCount : 0,
          hasData: !!resultObj.data
        });
        this.addToTransformationHistory({
          transformId,
          request: { data, rules },
          result: resultObj.data || result,
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
    const compatibilityConfig = this.config.config as Record<string, unknown>;

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
    if (compatibilityConfig.customRules && Array.isArray(compatibilityConfig.customRules)) {
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
    if (response && typeof response === 'object' && (response as Record<string, unknown>).data) {
      // Provider response format
      return this.transformProviderResponse((response as Record<string, unknown>).data);
    } else {
      // Direct response format
      return this.transformProviderResponse(response);
    }
  }

  /**
   * Transform provider response to OpenAI format
   */
  private transformProviderResponse(data: any): any {
    const dataObj = typeof data === 'object' && data !== null ? data as Record<string, unknown> : {};
    
    const transformed: Record<string, unknown> = {
      id: dataObj.id || `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Date.now(),
      model: dataObj.model || 'qwen-turbo',
      choices: [],
      usage: dataObj.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    };

    // Transform choices
    if (dataObj.choices && Array.isArray(dataObj.choices)) {
      transformed.choices = dataObj.choices.map((choice: any) => {
        const choiceObj = typeof choice === 'object' && choice !== null ? choice as Record<string, unknown> : {};
        const messageObj = typeof choiceObj.message === 'object' && choiceObj.message !== null ? choiceObj.message as Record<string, unknown> : {};
        
        return {
          index: choiceObj.index || 0,
          message: {
            role: messageObj.role || 'assistant',
            content: messageObj.content || '',
            tool_calls: this.transformToolCalls(messageObj.tool_calls as unknown[] | undefined)
          },
          finish_reason: this.transformFinishReason(typeof choiceObj.finish_reason === 'string' ? choiceObj.finish_reason : undefined)
        };
      });
    }

    // Add transformation metadata
    transformed._transformed = true;
    transformed._originalFormat = 'qwen';
    transformed._targetFormat = 'openai';

    return transformed;
  }

  /**
   * Transform tool calls from Qwen format to OpenAI format
   */
  private transformToolCalls(toolCalls: any[] | undefined): any[] {
    if (!toolCalls || !Array.isArray(toolCalls)) {
      return [];
    }

    return toolCalls.map((toolCall, index) => {
      const toolCallObj = typeof toolCall === 'object' && toolCall !== null ? toolCall as Record<string, unknown> : {};
      const functionObj = typeof toolCallObj.function === 'object' && toolCallObj.function !== null ? toolCallObj.function as Record<string, unknown> : {};
      
      return {
        id: toolCallObj.id || `call_${Date.now()}_${index}`,
        type: 'function',
        function: {
          name: functionObj.name || '',
          arguments: typeof functionObj.arguments === 'string'
            ? functionObj.arguments
            : JSON.stringify(functionObj.arguments || {})
        }
      };
    });
  }

  /**
   * Transform finish reason from Qwen format to OpenAI format
   */
  private transformFinishReason(finishReason: string | undefined): string {
    const reasonMap: { [key: string]: string } = {
      'stop': 'stop',
      'length': 'length',
      'tool_calls': 'tool_calls',
      'content_filter': 'content_filter'
    };

    return reasonMap[finishReason || ''] || finishReason || 'stop';
  }

  /**
   * Convert OpenAI-style request into Qwen API payload
   */
  private convertToQwenRequest(request: any): any {
    if (!request || typeof request !== 'object') {
      return request;
    }

    // If request already has Qwen input structure, assume it is correct.
    if (request && typeof request === 'object' && (request as Record<string, unknown>).input && Array.isArray((request as Record<string, unknown>).input)) {
      return request;
    }

    const qwenRequest: Record<string, unknown> = {};

    // Model mapping already handled by transformation rules, but ensure fallback
    qwenRequest.model = request && typeof request === 'object' && (request as Record<string, unknown>).model ? (request as Record<string, unknown>).model : undefined;

    // Convert messages -> input structure expected by Qwen portal API, but retain original messages field
    if (request && typeof request === 'object' && (request as Record<string, unknown>).messages && Array.isArray((request as Record<string, unknown>).messages)) {
      const msgs = (request as Record<string, unknown>).messages as unknown[];
      qwenRequest.messages = msgs as unknown;
      qwenRequest.input = msgs.map((message: any) => {
        const normalizedContent = this.normalizeMessageContent(message && typeof message === 'object' && (message as Record<string, unknown>).content ? (message as Record<string, unknown>).content : undefined);
        return {
          role: message && typeof message === 'object' && (message as Record<string, unknown>).role ? (message as Record<string, unknown>).role : 'user',
          content: normalizedContent
        };
      });
    }

    // Parameters block
    const parameters: Record<string, unknown> = {};
    if (request && typeof request === 'object' && typeof (request as Record<string, unknown>).temperature === 'number') {
      parameters.temperature = (request as Record<string, unknown>).temperature;
    }
    if (request && typeof request === 'object' && typeof (request as Record<string, unknown>).top_p === 'number') {
      parameters.top_p = (request as Record<string, unknown>).top_p;
    }
    if (request && typeof request === 'object' && typeof (request as Record<string, unknown>).frequency_penalty === 'number') {
      parameters.frequency_penalty = (request as Record<string, unknown>).frequency_penalty;
    }
    if (request && typeof request === 'object' && typeof (request as Record<string, unknown>).presence_penalty === 'number') {
      parameters.presence_penalty = (request as Record<string, unknown>).presence_penalty;
    }
    if (request && typeof request === 'object' && typeof (request as Record<string, unknown>).max_tokens === 'number') {
      parameters.max_output_tokens = (request as Record<string, unknown>).max_tokens;
    }
    if (request && typeof request === 'object' && (request as Record<string, unknown>).stop !== undefined) {
      const stops = Array.isArray((request as Record<string, unknown>).stop) ? (request as Record<string, unknown>).stop : [(request as Record<string, unknown>).stop];
      parameters.stop_sequences = (stops as unknown[]).filter(Boolean);
    }
    if (request && typeof request === 'object' && typeof (request as Record<string, unknown>).stream === 'boolean') {
      qwenRequest.stream = (request as Record<string, unknown>).stream;
    }
    if (request && typeof request === 'object' && typeof (request as Record<string, unknown>).debug === 'boolean') {
      parameters.debug = (request as Record<string, unknown>).debug;
    }

    if (Object.keys(parameters).length > 0) {
      qwenRequest.parameters = parameters;
    }

    // Optional OpenAI fields that Qwen API also supports
    if (request && typeof request === 'object' && typeof (request as Record<string, unknown>).stream === 'boolean') {
      qwenRequest.stream = (request as Record<string, unknown>).stream;
    }
    if (request && typeof request === 'object' && (request as Record<string, unknown>).response_format) {
      qwenRequest.response_format = (request as Record<string, unknown>).response_format;
    }
    if (request && typeof request === 'object' && typeof (request as Record<string, unknown>).user === 'string') {
      qwenRequest.user = (request as Record<string, unknown>).user;
    }

    // Copy tool definitions if present (Qwen expects array under tools?)
    if (request && typeof request === 'object' && (request as Record<string, unknown>).tools && Array.isArray((request as Record<string, unknown>).tools)) {
      qwenRequest.tools = (request as Record<string, unknown>).tools;
    }

    // Attach metadata passthrough if present
    if (request && typeof request === 'object' && (request as Record<string, unknown>).metadata && typeof (request as Record<string, unknown>).metadata === 'object') {
      qwenRequest.metadata = (request as Record<string, unknown>).metadata;
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
            return { text: String((item as Record<string, unknown>).text) };
          }
          if ('type' in item && (item as Record<string, unknown>).type === 'input_text' && 'text' in item) {
            return { text: String((item as Record<string, unknown>).text) };
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
        return [{ text: String((content as Record<string, unknown>).text) }];
      }
      if ('type' in content && (content as Record<string, unknown>).type === 'input_text' && 'text' in content) {
        return [{ text: String((content as Record<string, unknown>).text) }];
      }
    }

    return [{ text: String(content) }];
  }

  /**
   * Type guard for SharedPipelineRequest
   */
  private isSharedPipelineRequest(obj: any): obj is SharedPipelineRequest {
    return obj !== null && 
           typeof obj === 'object' && 
           'data' in obj && 
           'route' in obj &&
           'metadata' in obj &&
           'debug' in obj;
  }

  /**
   * Extract transformation result from engine response
   */
  private extractTransformationResult(result: any): any {
    if (result && typeof result === 'object' && 'data' in result) {
      return (result as UnknownObject).data;
    }
    return result;
  }
}
