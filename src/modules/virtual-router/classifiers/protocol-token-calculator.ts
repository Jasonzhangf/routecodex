/**
 * Protocol-Aware Token Calculator
 * 支持多种协议的Token估算器
 */

import type { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletionMessageToolCall } from 'openai/resources/chat/completions';

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
  calculate(request: Record<string, unknown>, endpoint: string): ProtocolTokenCalculationResult {
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
   * 使用llmswitch-core内置的TokenCounter进行精确/智能Token计算（优先tiktoken，回退估算）
   * 保持签名不变，由ConfigRequestClassifier在内部优先调用此方法（async）以进行长上下文判定。
   */
  async calculateAsync(request: Record<string, unknown>, endpoint: string): Promise<ProtocolTokenCalculationResult> {
    const protocol = this.detectProtocol(endpoint);
    // 使用 llmswitch-core 的严格 TokenCounter（禁止估算回退）；任何错误由上层分类器处理（Fail Fast）
    const mod: any = await import('rcc-llmswitch-core/v2/utils/token-counter');
    const TokenCounter = mod.TokenCounter;
    const { inputTokens, toolTokens } = await TokenCounter.calculateRequestTokensStrict(
      request,
      typeof (request as any)?.model === 'string' ? String((request as any).model) : 'gpt-3.5-turbo'
    );
    const totalTokens = inputTokens + (toolTokens || 0);
    return {
      totalTokens,
      messageTokens: inputTokens,
      systemTokens: 0,
      toolTokens: toolTokens || 0,
      breakdown: {
        messages: inputTokens,
        system: 0,
        tools: toolTokens || 0
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
  private extractMessages(request: Record<string, unknown>): ChatCompletionMessageParam[] {
    const messages = (request as Record<string, unknown>)[this.fieldMapping.messageField] as unknown;
    if (!Array.isArray(messages)) {
      return [];
    }
    return messages as ChatCompletionMessageParam[];
  }

  /**
   * 提取工具定义
   */
  private extractTools(request: Record<string, unknown>): ChatCompletionTool[] {
    const tools = (request as Record<string, unknown>)[this.fieldMapping.toolsField] as unknown;
    if (!Array.isArray(tools)) {
      return [];
    }
    return tools as ChatCompletionTool[];
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
  private calculateToolCallTokens(toolCalls: ChatCompletionMessageToolCall[]): number {
    let tokens = 0;

    for (const toolCall of toolCalls) {
      // 工具调用开销
      tokens += 20;

      // 工具名称/参数（兼容不同SDK类型定义）
      const fn: { name?: string; arguments?: string } | undefined = (toolCall as unknown as { function?: { name?: string; arguments?: string } }).function;
      tokens += this.estimateTextTokens(fn?.name || '');
      if (fn?.arguments) {
        tokens += this.estimateTextTokens(fn.arguments);
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
  getDetailedAnalysis(request: Record<string, unknown>, endpoint: string): {
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
