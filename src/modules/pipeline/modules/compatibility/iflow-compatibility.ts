/**
 * iFlow Compatibility Module
 *
 * Handles OpenAI to iFlow API format transformations with OAuth authentication.
 * Implements protocol translation and tool calling format conversion.
 */

import type { CompatibilityModule, ModuleConfig, ModuleDependencies, TransformationRule } from '../../interfaces/pipeline-interfaces.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';

/**
 * iFlow Compatibility Module
 */
export class iFlowCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'iflow-compatibility';
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
   * Process incoming request - Transform OpenAI format to iFlow format
   */
  async processIncoming(request: any): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('iFlow Compatibility module is not initialized');
    }

    try {
      this.logger.logModule(this.id, 'transform-request-start', {
        originalFormat: 'openai',
        targetFormat: 'iflow',
        hasTools: !!request.tools
      });

      // Apply transformation rules
      const transformed = await this.transformationEngine.transform(
        request,
        this.rules
      );

      this.logger.logModule(this.id, 'transform-request-success', {
        transformationCount: transformed.transformationCount || 0
      });

      return transformed.data || transformed;

    } catch (error) {
      this.logger.logModule(this.id, 'transformation-error', { error });
      throw error;
    }
  }

  /**
   * Process outgoing response - Transform iFlow format to OpenAI format
   */
  async processOutgoing(response: any): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('iFlow Compatibility module is not initialized');
    }

    try {
      this.logger.logModule(this.id, 'transform-response-start', {
        originalFormat: 'iflow',
        targetFormat: 'openai'
      });

      // Transform response back to OpenAI format
      const transformed = this.transformIFlowResponseToOpenAI(response);

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
   * Initialize transformation rules for iFlow API
   */
  private initializeTransformationRules(): TransformationRule[] {
    const compatibilityConfig = this.config.config as any;

    // Default transformation rules for iFlow API
    const transformationRules = [
      // Model name mapping
      {
        id: 'map-model-names',
        transform: 'mapping',
        sourcePath: 'model',
        targetPath: 'model',
        mapping: {
          'gpt-3.5-turbo': 'iflow-turbo',
          'gpt-4': 'iflow-pro',
          'gpt-4-turbo': 'iflow-turbo-latest'
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
      // Temperature mapping
      {
        id: 'map-temperature',
        transform: 'rename',
        sourcePath: 'temperature',
        targetPath: 'temperature'
      },
      // Max tokens mapping
      {
        id: 'map-max-tokens',
        transform: 'rename',
        sourcePath: 'max_tokens',
        targetPath: 'max_tokens'
      },
      // Messages format conversion - iFlow specific
      {
        id: 'convert-messages-format',
        transform: 'mapping',
        sourcePath: 'messages',
        targetPath: 'messages',
        mapping: {
          'role': 'role',
          'content': 'content',
          'name': 'name'
        }
      }
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
   * Transform iFlow response to OpenAI format
   */
  private transformIFlowResponseToOpenAI(response: any): any {
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
      model: data.model || 'iflow-turbo',
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
    (transformed as any)._originalFormat = 'iflow';
    (transformed as any)._targetFormat = 'openai';

    return transformed;
  }

  /**
   * Transform tool calls from iFlow format to OpenAI format
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
   * Transform finish reason from iFlow format to OpenAI format
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
}