/**
 * Protocol-Aware Token Calculator
 * 支持多种协议的Token估算器
 */

import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';

export interface ProtocolTokenCalculationConfig {
  type: 'openai' | 'anthropic';
  tokenRatio: number;
  toolOverhead: number;
  messageOverhead: number;
  imageTokenDefault?: number;
}

export interface ProtocolTokenCalculationResult {
  totalTokens: number;
  messageTokens: number;
  systemTokens: number;
  toolTokens: number;
  breakdown: {
    messages: number;
    system: number;
    tools: number;
  };
  protocol: string;
}

export interface ProtocolFieldMapping {
  messageField: string;
  modelField: string;
  toolsField: string;
  maxTokensField: string;
}

export class ProtocolTokenCalculator {
  private config: ProtocolTokenCalculationConfig;
  private fieldMapping: ProtocolFieldMapping;

  constructor(config: ProtocolTokenCalculationConfig, fieldMapping: ProtocolFieldMapping) {
    this.config = config;
    this.fieldMapping = fieldMapping;
  }

  /**
   * 根据协议计算Token数
   */
  calculate(request: any, endpoint: string): ProtocolTokenCalculationResult {
    const protocol = this.detectProtocol(endpoint);
    const messages = this.extractMessages(request);
    const tools = this.extractTools(request);

    const messageTokens = this.calculateMessageTokens(messages);
    const systemTokens = this.calculateSystemTokens(messages);
    const toolTokens = this.calculateToolTokens(tools);

    const totalTokens = messageTokens + systemTokens + toolTokens;

    return {
      totalTokens,
      messageTokens,
      systemTokens,
      toolTokens,
      breakdown: {
        messages: messageTokens,
        system: systemTokens,
        tools: toolTokens
      },
      protocol
    };
  }

  /**
   * 检测协议类型
   */
  private detectProtocol(endpoint: string): string {
    if (endpoint.includes('/v1/chat/completions') || endpoint.includes('/v1/completions')) {
      return 'openai';
    }
    if (endpoint.includes('/v1/messages')) {
      return 'anthropic';
    }
    return 'unknown';
  }

  /**
   * 提取消息内容
   */
  private extractMessages(request: any): ChatCompletionMessageParam[] {
    const messages = request[this.fieldMapping.messageField];
    if (!Array.isArray(messages)) {
      return [];
    }
    return messages;
  }

  /**
   * 提取工具定义
   */
  private extractTools(request: any): ChatCompletionTool[] {
    const tools = request[this.fieldMapping.toolsField];
    if (!Array.isArray(tools)) {
      return [];
    }
    return tools;
  }

  /**
   * 计算消息内容的Token数
   */
  private calculateMessageTokens(messages: ChatCompletionMessageParam[]): number {
    let tokens = 0;

    for (const message of messages) {
      // 消息开销
      tokens += this.config.messageOverhead;

      if (typeof message.content === 'string') {
        // 纯文本消息
        tokens += this.estimateTextTokens(message.content);
      } else if (Array.isArray(message.content)) {
        // 多模态消息
        for (const contentPart of message.content) {
          if (contentPart.type === 'text') {
            tokens += this.estimateTextTokens(contentPart.text);
          } else if (contentPart.type === 'image_url' && this.config.imageTokenDefault) {
            // 图像内容
            tokens += this.config.imageTokenDefault;
          }
        }
      }

      // 函数调用结果
      if (message.role === 'assistant' && message.tool_calls) {
        tokens += this.calculateToolCallTokens(message.tool_calls);
      }

      // 函数调用
      if (message.role === 'tool' && typeof message.content === 'string') {
        tokens += this.estimateTextTokens(message.content);
      }
    }

    return tokens;
  }

  /**
   * 计算系统消息的Token数
   */
  private calculateSystemTokens(messages: ChatCompletionMessageParam[]): number {
    let tokens = 0;

    for (const message of messages) {
      if (message.role === 'system') {
        if (typeof message.content === 'string') {
          tokens += this.estimateTextTokens(message.content);
        } else if (Array.isArray(message.content)) {
          for (const contentPart of message.content) {
            if (contentPart.type === 'text') {
              tokens += this.estimateTextTokens(contentPart.text);
            }
          }
        }
      }
    }

    return tokens;
  }

  /**
   * 计算工具定义的Token数
   */
  private calculateToolTokens(tools: ChatCompletionTool[]): number {
    if (tools.length === 0) {
      return 0;
    }

    let tokens = this.config.toolOverhead * tools.length;

    for (const tool of tools) {
      if (tool.type === 'function') {
        tokens += this.estimateTextTokens(tool.function.name);
        tokens += this.estimateTextTokens(tool.function.description || '');

        if (tool.function.parameters) {
          tokens += this.estimateTextTokens(JSON.stringify(tool.function.parameters));
        }
      }
    }

    return tokens;
  }

  /**
   * 计算工具调用的Token数
   */
  private calculateToolCallTokens(toolCalls: any[]): number {
    let tokens = 0;

    for (const toolCall of toolCalls) {
      // 工具调用开销
      tokens += 20;

      // 工具名称
      tokens += this.estimateTextTokens(toolCall.function?.name || '');

      // 工具参数
      if (toolCall.function?.arguments) {
        tokens += this.estimateTextTokens(toolCall.function.arguments);
      }
    }

    return tokens;
  }

  /**
   * 估算文本Token数
   */
  private estimateTextTokens(text: string): number {
    if (!text || typeof text !== 'string') {
      return 0;
    }

    const estimatedTokens = Math.ceil(text.length * this.config.tokenRatio);
    return Math.max(1, estimatedTokens);
  }

  /**
   * 获取详细的Token分析
   */
  getDetailedAnalysis(request: any, endpoint: string): {
    calculation: ProtocolTokenCalculationResult;
    estimates: {
      low: number;
      medium: number;
      high: number;
    };
    recommendations: {
      category: 'short' | 'medium' | 'long' | 'very_long';
      suggestedTier: 'basic' | 'advanced';
      reasoning: string;
    };
  } {
    const calculation = this.calculate(request, endpoint);

    // 基于计算结果提供不同的估算
    const estimates = {
      low: Math.floor(calculation.totalTokens * 0.8),
      medium: calculation.totalTokens,
      high: Math.ceil(calculation.totalTokens * 1.2)
    };

    // 推荐模型层级
    let category: 'short' | 'medium' | 'long' | 'very_long';
    let suggestedTier: 'basic' | 'advanced';
    let reasoning: string;

    if (estimates.medium < 8000) {
      category = 'short';
      suggestedTier = 'basic';
      reasoning = '短文本请求，建议使用基础模型';
    } else if (estimates.medium < 24000) {
      category = 'medium';
      suggestedTier = 'basic';
      reasoning = '中等长度请求，建议使用基础模型';
    } else if (estimates.medium < 100000) {
      category = 'long';
      suggestedTier = 'advanced';
      reasoning = '长文本请求，建议使用高级模型';
    } else {
      category = 'very_long';
      suggestedTier = 'advanced';
      reasoning = '超长文本请求，必须使用高级模型';
    }

    return {
      calculation,
      estimates,
      recommendations: {
        category,
        suggestedTier,
        reasoning
      }
    };
  }

  /**
   * 创建OpenAI协议的Token计算器
   */
  static createOpenAICalculator(): ProtocolTokenCalculator {
    const config: ProtocolTokenCalculationConfig = {
      type: 'openai',
      tokenRatio: 0.25,
      toolOverhead: 50,
      messageOverhead: 10,
      imageTokenDefault: 255
    };

    const fieldMapping: ProtocolFieldMapping = {
      messageField: 'messages',
      modelField: 'model',
      toolsField: 'tools',
      maxTokensField: 'max_tokens'
    };

    return new ProtocolTokenCalculator(config, fieldMapping);
  }

  /**
   * 创建Anthropic协议的Token计算器
   */
  static createAnthropicCalculator(): ProtocolTokenCalculator {
    const config: ProtocolTokenCalculationConfig = {
      type: 'anthropic',
      tokenRatio: 0.25,
      toolOverhead: 50,
      messageOverhead: 10
    };

    const fieldMapping: ProtocolFieldMapping = {
      messageField: 'messages',
      modelField: 'model',
      toolsField: 'tools',
      maxTokensField: 'max_tokens'
    };

    return new ProtocolTokenCalculator(config, fieldMapping);
  }
}