/**
 * Anthropic ↔ OpenAI LLMSwitch 实现
 * 基于配置驱动的双向协议转换
 */

import type { LLMSwitchModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';
import {
  DEFAULT_CONVERSION_CONFIG,
  detectRequestFormat,
  detectResponseFormat,
  type ConversionConfig
} from './anthropic-openai-config.js';

/**
 * Anthropic↔OpenAI 双向转换器
 */
export class AnthropicOpenAIConverter implements LLMSwitchModule {
  readonly id: string;
  readonly type = 'llmswitch-anthropic-openai';
  readonly protocol = 'bidirectional';
  readonly config: ModuleConfig;

  private isInitialized = false;
  private logger: PipelineDebugLogger;
  private conversionConfig: ConversionConfig;
  private enableStreaming: boolean;
  private enableTools: boolean;

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.config = config;
    this.id = `llmswitch-anthropic-openai-${Date.now()}`;
    this.logger = dependencies.logger as any;
    
    // 合并配置
    this.conversionConfig = {
      ...DEFAULT_CONVERSION_CONFIG,
      ...(config.config?.conversionMappings || {})
    };
    
    this.enableStreaming = config.config?.enableStreaming ?? true;
    this.enableTools = config.config?.enableTools ?? true;
  }

  /**
   * 初始化模块
   */
  async initialize(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'initializing', {
        config: this.conversionConfig,
        enableStreaming: this.enableStreaming,
        enableTools: this.enableTools
      });

      this.validateConfig();
      this.isInitialized = true;
      
      this.logger.logModule(this.id, 'initialized');
    } catch (error) {
      this.logger.logModule(this.id, 'initialization-error', { error });
      throw error;
    }
  }

  /**
   * 处理入站请求 - 根据格式决定是否转换
   */
  async processIncoming(request: any): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('AnthropicOpenAIConverter is not initialized');
    }

    try {
      const requestFormat = detectRequestFormat(request);
      
      // 只处理 Anthropic → OpenAI 转换
      if (requestFormat === 'anthropic') {
        const transformedRequest = this.convertAnthropicRequestToOpenAI(request);
        
        this.logger.logTransformation(this.id, 'anthropic-to-openai-request', request, transformedRequest);
        
        return {
          ...transformedRequest,
          _metadata: {
            switchType: 'llmswitch-anthropic-openai',
            direction: 'anthropic-to-openai',
            timestamp: Date.now(),
            originalFormat: 'anthropic',
            targetFormat: 'openai'
          }
        };
      }
      
      // OpenAI 格式直接透传
      if (requestFormat === 'openai') {
        this.logger.logModule(this.id, 'openai-request-passthrough', { request });
      }
      
      return {
        ...request,
        _metadata: {
          switchType: 'llmswitch-anthropic-openai',
          direction: 'passthrough',
          timestamp: Date.now(),
          originalFormat: requestFormat,
          targetFormat: requestFormat
        }
      };
      
    } catch (error) {
      this.logger.logModule(this.id, 'request-transform-error', { error, request });
      throw error;
    }
  }

  /**
   * 处理出站响应 - 根据格式决定是否转换
   */
  async processOutgoing(response: any): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('AnthropicOpenAIConverter is not initialized');
    }

    try {
      const responseFormat = detectResponseFormat(response);
      
      // 只处理 OpenAI → Anthropic 转换
      if (responseFormat === 'openai') {
        const transformedResponse = this.convertOpenAIResponseToAnthropic(response);
        
        this.logger.logTransformation(this.id, 'openai-to-anthropic-response', response, transformedResponse);
        
        return {
          ...transformedResponse,
          _metadata: {
            ...response._metadata,
            switchType: 'llmswitch-anthropic-openai',
            direction: 'openai-to-anthropic',
            responseTimestamp: Date.now(),
            originalFormat: 'openai',
            targetFormat: 'anthropic'
          }
        };
      }
      
      // Anthropic 格式直接透传
      if (responseFormat === 'anthropic') {
        this.logger.logModule(this.id, 'anthropic-response-passthrough', { response });
      }
      
      return {
        ...response,
        _metadata: {
          ...response._metadata,
          switchType: 'llmswitch-anthropic-openai',
          direction: 'passthrough',
          responseTimestamp: Date.now(),
          originalFormat: responseFormat,
          targetFormat: responseFormat
        }
      };
      
    } catch (error) {
      this.logger.logModule(this.id, 'response-transform-error', { error, response });
      throw error;
    }
  }

  /**
   * 转换请求到目标协议
   */
  async transformRequest(request: any): Promise<any> {
    return this.processIncoming(request);
  }

  /**
   * 转换响应从目标协议
   */
  async transformResponse(response: any): Promise<any> {
    return this.processOutgoing(response);
  }

  /**
   * Anthropic 请求 → OpenAI 请求
   */
  private convertAnthropicRequestToOpenAI(request: any): any {
    const { requestMappings } = this.conversionConfig;
    const transformed: any = {};

    // 处理消息 - 提取系统消息
    if (request.system) {
      transformed.messages = [
        { role: 'system', content: request.system },
        ...(request.messages || [])
      ];
    } else {
      transformed.messages = request.messages || [];
    }

    // 处理工具定义转换
    if (this.enableTools && request.tools) {
      transformed.tools = this.convertAnthropicToolsToOpenAI(request.tools);
    }

    // 处理通用参数
    this.copyParameters(request, transformed, requestMappings.parameters);

    return transformed;
  }

  /**
   * OpenAI 响应 → Anthropic 响应
   */
  private convertOpenAIResponseToAnthropic(response: any): any {
    const { responseMappings } = this.conversionConfig;
    const transformed: any = {};

    // 提取基本内容
    if (response.choices && response.choices.length > 0) {
      const choice = response.choices[0];
      const message = choice.message;

      transformed.role = message.role || 'assistant';
      
      // 处理内容
      if (message.content) {
        transformed.content = message.content;
      }
      
      // 处理工具调用
      if (this.enableTools && message.tool_calls) {
        transformed.content = this.convertOpenAIToolCallsToAnthropic(message.tool_calls);
      }
      
      // 完成原因映射
      if (choice.finish_reason) {
        transformed.stop_reason = responseMappings.finishReason.mapping[choice.finish_reason] || 'end_turn';
      }
    }

    // 使用统计转换
    if (response.usage) {
      transformed.usage = this.convertUsageStats(response.usage, responseMappings.usage.fieldMapping);
    }

    // 复制其他字段
    if (response.id) {transformed.id = response.id;}
    if (response.model) {transformed.model = response.model;}
    if (response.created) {transformed.created = response.created;}

    return transformed;
  }

  /**
   * Anthropic 工具定义 → OpenAI 函数定义
   */
  private convertAnthropicToolsToOpenAI(tools: any[]): any[] {
    if (!tools) {return [];}
    
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema
      }
    }));
  }

  /**
   * OpenAI 工具调用 → Anthropic 工具使用
   */
  private convertOpenAIToolCallsToAnthropic(toolCalls: any[]): any[] {
    if (!toolCalls) {return [];}
    
    return toolCalls.map(call => ({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: JSON.parse(call.function.arguments || '{}')
    }));
  }

  /**
   * 使用统计转换
   */
  private convertUsageStats(usage: any, fieldMapping: Record<string, string>): any {
    const transformed: any = {};
    
    for (const [sourceField, targetField] of Object.entries(fieldMapping)) {
      if (usage[sourceField] !== undefined) {
        transformed[targetField] = usage[sourceField];
      }
    }
    
    return transformed;
  }

  /**
   * 通用参数复制
   */
  private copyParameters(source: any, target: any, parameterMappings: any): void {
    for (const [param, mapping] of Object.entries(parameterMappings)) {
      const sourceKey = (mapping as any).source;
      const targetKey = (mapping as any).target;
      
      if (source[sourceKey] !== undefined) {
        target[targetKey] = source[sourceKey];
      }
    }
  }

  /**
   * 清理资源
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
   * 获取模块状态
   */
  getStatus(): {
    id: string;
    type: string;
    protocol: string;
    isInitialized: boolean;
    lastActivity: number;
    config: {
      enableStreaming: boolean;
      enableTools: boolean;
    };
  } {
    return {
      id: this.id,
      type: this.type,
      protocol: this.protocol,
      isInitialized: this.isInitialized,
      lastActivity: Date.now(),
      config: {
        enableStreaming: this.enableStreaming,
        enableTools: this.enableTools
      }
    };
  }

  /**
   * 验证配置
   */
  private validateConfig(): void {
    if (!this.conversionConfig) {
      throw new Error('Conversion configuration is required');
    }
    
    this.logger.logModule(this.id, 'config-validation-success', {
      enableStreaming: this.enableStreaming,
      enableTools: this.enableTools,
      hasRequestMappings: !!this.conversionConfig.requestMappings,
      hasResponseMappings: !!this.conversionConfig.responseMappings
    });
  }
}
