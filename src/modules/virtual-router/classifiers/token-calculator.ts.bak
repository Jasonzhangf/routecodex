/**
 * OpenAI Token Calculator
 * 基于OpenAI格式的Token估算器
 */

import type { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletionMessageToolCall } from 'openai/resources/chat/completions';

export interface TokenCalculationResult {
  totalTokens: number;
  messageTokens: number;
  systemTokens: number;
  toolTokens: number;
  breakdown: {
    messages: number;
    system: number;
    tools: number;
  };
}

export class TokenCalculator {
  // Token估算系数 (字符数 / 平均Token数)
  private static readonly TOKEN_RATIO = 0.25; // 1 Token ≈ 4字符
  private static readonly TOOL_OVERHEAD = 50; // 工具定义的基础开销
  private static readonly MESSAGE_OVERHEAD = 10; // 每条消息的开销

  /**
   * 计算OpenAI格式请求的总Token数
   */
  calculate(
    messages: ChatCompletionMessageParam[],
    tools?: ChatCompletionTool[]
  ): TokenCalculationResult {
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
      }
    };
  }

  /**
   * 计算消息内容的Token数
   */
  private calculateMessageTokens(messages: ChatCompletionMessageParam[]): number {
    let tokens = 0;

    for (const message of messages) {
      // 消息开销
      tokens += TokenCalculator.MESSAGE_OVERHEAD;

      if (typeof message.content === 'string') {
        // 纯文本消息
        tokens += this.estimateTextTokens(message.content);
      } else if (Array.isArray(message.content)) {
        // 多模态消息
        for (const contentPart of message.content) {
          if (contentPart.type === 'text') {
            tokens += this.estimateTextTokens(contentPart.text);
          } else if (contentPart.type === 'image_url') {
            // 图像内容 - 基础估算
            tokens += this.estimateImageTokens(contentPart.image_url);
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
  private calculateToolTokens(tools?: ChatCompletionTool[]): number {
    if (!tools || tools.length === 0) {
      return 0;
    }

    let tokens = TokenCalculator.TOOL_OVERHEAD * tools.length;

    for (const tool of tools) {
      // 处理不同类型的工具
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

    // 基础字符数估算
    const estimatedTokens = Math.ceil(text.length * TokenCalculator.TOKEN_RATIO);

    // 最小Token数
    return Math.max(1, estimatedTokens);
  }

  /**
   * 估算图像Token数
   */
  private estimateImageTokens(_imageUrl: unknown): number {
    // 简化的图像Token估算
    // 实际Token数取决于图像尺寸、细节程度等
    return 255; // OpenAI的标准图像Token估算
  }

  /**
   * 获取Token估算的详细信息
   */
  getDetailedEstimate(request: {
    messages: ChatCompletionMessageParam[];
    tools?: ChatCompletionTool[];
  }): {
    calculation: TokenCalculationResult;
    estimates: {
      low: number;
      medium: number;
      high: number;
    };
    recommendations: {
      category: 'short' | 'medium' | 'long' | 'very_long';
      suggestedRoute: string;
      reasoning: string;
    };
  } {
    const calculation = this.calculate(request.messages, request.tools);

    // 基于计算结果提供不同的估算
    const estimates = {
      low: Math.floor(calculation.totalTokens * 0.8),  // 保守估算
      medium: calculation.totalTokens,                // 标准估算
      high: Math.ceil(calculation.totalTokens * 1.2)  // 乐观估算
    };

    // 推荐路由
    let category: 'short' | 'medium' | 'long' | 'very_long';
    let suggestedRoute: string;
    let reasoning: string;

    if (estimates.medium < 1000) {
      category = 'short';
      suggestedRoute = 'default';
      reasoning = '短文本请求，使用默认模型处理';
    } else if (estimates.medium < 8000) {
      category = 'medium';
      suggestedRoute = 'default';
      reasoning = '中等长度请求，使用默认模型处理';
    } else if (estimates.medium < 32000) {
      category = 'long';
      suggestedRoute = 'longContext';
      reasoning = '长文本请求，建议使用长上下文模型';
    } else {
      category = 'very_long';
      suggestedRoute = 'longContext';
      reasoning = '超长文本请求，必须使用长上下文模型';
    }

    return {
      calculation,
      estimates,
      recommendations: {
        category,
        suggestedRoute,
        reasoning
      }
    };
  }
}
