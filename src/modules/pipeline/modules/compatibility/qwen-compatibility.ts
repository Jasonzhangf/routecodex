/**
 * Qwen Compatibility Module
 *
 * Handles OpenAI to Qwen API format transformations with OAuth authentication.
 * Implements protocol translation and tool calling format conversion.
 */

import type { CompatibilityModule, ModuleConfig, ModuleDependencies, TransformationRule } from '../../interfaces/pipeline-interfaces.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';

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

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.logger = dependencies.logger as any;
    this.id = `compatibility-${Date.now()}`;
    this.config = config;
    this.rules = this.initializeTransformationRules();
  }

  /**
   * Initialize the compatibility module
   */
  async initialize(): Promise<void> {
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

    } catch (error) {
      this.logger.logModule(this.id, 'initialization-error', { error });
      throw error;
    }
  }

  /**
   * Process incoming request - Transform OpenAI format to Qwen format
   */
  async processIncoming(request: any): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('Qwen Compatibility module is not initialized');
    }

    try {
      this.logger.logModule(this.id, 'transform-request-start', {
        originalFormat: 'openai',
        targetFormat: 'qwen',
        hasTools: !!request.tools
      });

      // Apply transformation rules
      const transformed = await this.transformationEngine.transform(
        request,
        this.rules
      );

      const converted = this.convertToQwenRequest(transformed.data || transformed);

      this.logger.logModule(this.id, 'transform-request-success', {
        transformationCount: transformed.transformationCount || 0,
        hasInput: Array.isArray(converted.input),
        parameterKeys: Object.keys(converted.parameters || {})
      });

      return converted;

    } catch (error) {
      this.logger.logModule(this.id, 'transformation-error', { error });
      throw error;
    }
  }

  /**
   * Process outgoing response - Transform Qwen format to OpenAI format
   */
  async processOutgoing(response: any): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('Qwen Compatibility module is not initialized');
    }

    try {
      this.logger.logModule(this.id, 'transform-response-start', {
        originalFormat: 'qwen',
        targetFormat: 'openai'
      });

      // Transform response back to OpenAI format
      const transformed = this.transformQwenResponseToOpenAI(response);

      this.logger.logModule(this.id, 'transform-response-success', {
        responseId: transformed.id
      });

      return transformed;

    } catch (error) {
      this.logger.logModule(this.id, 'response-transformation-error', { error });
      throw error;
    }
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'cleanup-start');
      this.isInitialized = false;
      this.logger.logModule(this.id, 'cleanup-complete');
    } catch (error) {
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
    return await this.transformationEngine.transform(data, rules);
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
