/**
 * iFlow Compatibility Module
 *
 * Handles OpenAI to iFlow API format transformations with OAuth authentication.
 * Implements protocol translation and tool calling format conversion.
 */

import type { CompatibilityModule, ModuleConfig, ModuleDependencies, TransformationRule } from '../../interfaces/pipeline-interfaces.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';
import type { SharedPipelineRequest } from '../../../../types/shared-dtos.js';

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
  async processIncoming(requestParam: any): Promise<SharedPipelineRequest> {
    if (!this.isInitialized) {
      throw new Error('iFlow Compatibility module is not initialized');
    }

    try {
      const isDto = requestParam && typeof requestParam === 'object' && 'data' in requestParam && 'route' in requestParam;
      const dto = isDto ? (requestParam as SharedPipelineRequest) : null;
      const request = isDto ? (dto!.data as any) : (requestParam as any);
      this.logger.logModule(this.id, 'transform-request-start', {
        originalFormat: 'openai',
        targetFormat: 'iflow',
        hasTools: !!request.tools
      });

      // Apply transformation rules
      const transformed = await this.transformationEngine.transform(request, this.rules);

      this.logger.logModule(this.id, 'transform-request-success', {
        transformationCount: transformed.transformationCount || 0
      });

      const out = transformed.data || transformed;
      // Heuristic: iFlow vision models (e.g., qwen3-vl-plus) may require a vision-friendly payload
      try {
        const modelId = String((out as any)?.model || (request as any)?.model || '').toLowerCase();
        const maybeMessages = (out as any)?.messages;
        const hasImage = Array.isArray(maybeMessages)
          && maybeMessages.some((m: any) => Array.isArray(m?.content)
            && m.content.some((c: any) => typeof c === 'object' && c && (c.type === 'image_url' || c.type === 'image')));
        const isVisionModel = /qwen3-vl/.test(modelId);
        if ((hasImage || isVisionModel) && typeof out === 'object' && out) {
          // Normalize image item: allow string or object with url
          const normMsgs = (maybeMessages || []).map((m: any) => {
            if (!Array.isArray(m?.content)) return m;
            const content = m.content.map((c: any) => {
              if (c && typeof c === 'object' && (c.type === 'image_url' || c.type === 'image')) {
                const url = typeof c.image_url === 'string' ? c.image_url : (c.image_url?.url || c.url || '');
                return { type: 'image_url', image_url: url };
              }
              if (c && typeof c === 'object' && c.type === 'text') return c;
              if (typeof c === 'string') return { type: 'text', text: c };
              return c;
            });
            return { role: m.role || 'user', content };
          });
          // iFlow-compatible alternative field: input
          (out as any).input = normMsgs;
          // Keep messages as-is too; provider will send both fields and upstream can accept one.
        }
      } catch { /* ignore */ }
      // Inject iFlow-specific HTTP headers to emulate official CLI behavior
      try {
        const headers = {
          'User-Agent': 'iflow-cli/2.0',
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'Origin': 'https://iflow.cn',
          'Referer': 'https://iflow.cn/chat'
        } as Record<string, string>;
        if (out && typeof out === 'object') {
          (out as Record<string, unknown>)['_headers'] = headers;
        }
      } catch { /* ignore header injection errors */ }
      return isDto ? { ...dto!, data: out } : { data: out, route: { providerId: 'unknown', modelId: 'unknown', requestId: 'unknown', timestamp: Date.now() }, metadata: {}, debug: { enabled: false, stages: {} } } as SharedPipelineRequest;

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
      const isDto = response && typeof response === 'object' && 'data' in response && 'metadata' in response;
      const payload = isDto ? (response as any).data : response;
      this.logger.logModule(this.id, 'transform-response-start', { originalFormat: 'iflow', targetFormat: 'openai' });

      // Transform response back to OpenAI format
      const transformed = this.transformIFlowResponseToOpenAI(payload);

      this.logger.logModule(this.id, 'transform-response-success', { responseId: transformed.id });

      return isDto ? { ...(response as any), data: transformed } : transformed;

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
          'gpt-4': 'qwen3-coder',
          'gpt-4-turbo': 'iflow-turbo-latest',
          'qwen3-coder': 'qwen3-coder'
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
    const transformed: any = {
      id: data.id || `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Number(data.created) || Date.now(),
      model: data.model || 'iflow-turbo',
      choices: [],
      usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };

    // Normalize choice list from common iFlow/OpenAI variants
    const choices = Array.isArray(data.choices) ? data.choices
      : Array.isArray(data.output_choices) ? data.output_choices
      : undefined;

    if (choices && Array.isArray(choices) && choices.length > 0) {
      transformed.choices = choices.map((choice: any, idx: number) => {
        const msg = choice.message || choice.delta || {};
        const role = msg.role || 'assistant';
        const content = typeof msg.content === 'string' ? msg.content
          : Array.isArray(msg.content) ? msg.content.join('\n')
          : (typeof data.output_text === 'string' ? data.output_text : '');
        const toolCalls = this.transformToolCalls(msg.tool_calls || choice.tool_calls);
        return {
          index: typeof choice.index === 'number' ? choice.index : idx,
          message: { role, content, tool_calls: toolCalls },
          finish_reason: this.transformFinishReason(choice.finish_reason)
        };
      });
    } else {
      // Fallback: fabricate a single assistant message if provider returned plain text
      const fallbackText =
        (typeof data.output_text === 'string' && data.output_text) ||
        (typeof data.text === 'string' && data.text) ||
        (typeof data.response === 'string' && data.response) ||
        (data.message && typeof data.message.content === 'string' && data.message.content) ||
        '';
      transformed.choices = [
        {
          index: 0,
          message: { role: 'assistant', content: fallbackText, tool_calls: [] },
          finish_reason: this.transformFinishReason((data.choices && data.choices[0]?.finish_reason) || 'stop')
        }
      ];
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
