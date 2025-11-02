import type { CompatibilityContext } from '../../compatibility-interface.js';
import type { UnknownObject } from '../../../../../../types/common-types.js';
import type { ModuleDependencies } from '../../../../../../types/module.types.js';
import { BaseHook } from './base-hook.js';

/**
 * 消息接口
 */
interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: any[];
}

/**
 * GLM工具清洗Hook
 * 处理GLM特有的工具消息清洗逻辑
 */
export class GLMToolCleaningHook extends BaseHook {
  readonly name = 'glm.01.tool-cleaning';
  readonly stage = 'incoming_preprocessing';
  readonly priority = 100;

  private readonly MAX_TOOL_CONTENT_LENGTH = 512;
  private readonly NOISE_PATTERNS = [
    'failed in sandbox',
    'unsupported call',
    '工具调用不可用',
    'tool execution failed',
    'function not available'
  ];
  private readonly TRUNCATION_MARKER = '...[truncated to 512B]';

  async execute(data: UnknownObject, context: CompatibilityContext): Promise<UnknownObject> {
    this.checkInitialized();

    if (!this.shouldExecute(data, context)) {
      return data;
    }

    this.logExecution(context, { stage: 'tool-cleaning-start' });

    try {
      const result: any = { ...(data as any) };

      // 处理messages字段
      if (result.messages && Array.isArray(result.messages)) {
        result.messages = this.cleanMessages(result.messages);
      }

      // 处理tools字段
      if (result.tools && Array.isArray(result.tools)) {
        result.tools = this.cleanTools(result.tools);
      }

      // 处理tool_calls字段（如果存在）
      if (Array.isArray(result.tool_calls)) {
        result.tool_calls = this.cleanToolCalls(result.tool_calls);
      }

      this.logExecution(context, { stage: 'tool-cleaning-complete' });

      return result;
    } catch (error) {
      this.logError(error as Error, context, { stage: 'tool-cleaning-error' });
      throw error;
    }
  }

  private cleanMessages(messages: unknown[]): Message[] {
    const cleanedMessages: Message[] = [];

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i] as Message;
      const cleanedMessage = { ...message };

      // 处理最后一条role=tool的消息
      if (this.isLastToolMessage(messages, i)) {
        cleanedMessage.content = this.cleanToolContent(cleanedMessage.content || '');
      }

      // 处理assistant消息中的大段工具结果回灌
      if (message.role === 'assistant') {
        cleanedMessage.content = this.cleanAssistantContent(cleanedMessage.content || '', messages, i);
      }

      // 强制串化tool_calls中的arguments
      if (cleanedMessage.tool_calls && Array.isArray(cleanedMessage.tool_calls)) {
        cleanedMessage.tool_calls = this.cleanToolCalls(cleanedMessage.tool_calls);
      }

      // content数组扁平化为字符串
      if (Array.isArray(cleanedMessage.content)) {
        cleanedMessage.content = cleanedMessage.content.map(item =>
          typeof item === 'string' ? item : JSON.stringify(item)
        ).join('');
      }

      // Strip reasoning思考标签
      if (typeof cleanedMessage.content === 'string') {
        cleanedMessage.content = this.stripReasoningTags(cleanedMessage.content);
      }

      cleanedMessages.push(cleanedMessage);
    }

    return cleanedMessages;
  }

  private cleanTools(tools: unknown[]): unknown[] {
    return tools.map(tool => {
      const cleanedTool: any = { ...(tool as any) };

      // 移除tools[].function.strict（GLM不识别）
      if (typeof cleanedTool === 'object' && cleanedTool !== null) {
        const functionObj = (cleanedTool as any).function;
        if (functionObj && typeof functionObj === 'object') {
          const { strict, ...functionWithoutStrict } = functionObj;
          (cleanedTool as any).function = functionWithoutStrict;
        }
      }

      return cleanedTool;
    });
  }

  private cleanToolCalls(toolCalls: unknown[]): unknown[] {
    return (toolCalls as any[]).map(toolCall => {
      const cleanedToolCall: any = { ...(toolCall as any) };

      if (typeof cleanedToolCall === 'object' && cleanedToolCall !== null) {
        const functionObj = (cleanedToolCall as any).function;
        if (functionObj && typeof functionObj === 'object') {
          // 强制串化arguments
          if (functionObj.arguments && typeof functionObj.arguments !== 'string') {
            functionObj.arguments = JSON.stringify(functionObj.arguments);
          }
        }
      }

      return cleanedToolCall;
    });
  }

  private isLastToolMessage(messages: unknown[], index: number): boolean {
    if (index !== messages.length - 1) {
      return false;
    }

    const message = messages[index] as Message;
    return message.role === 'tool';
  }

  private cleanToolContent(content: string): string {
    if (typeof content !== 'string') {
      return String(content);
    }

    let cleanedContent = content;

    // 去掉噪声片段
    for (const noise of this.NOISE_PATTERNS) {
      const regex = new RegExp(noise, 'gi');
      cleanedContent = cleanedContent.replace(regex, '');
    }

    // 清理多余的空白字符
    cleanedContent = cleanedContent.trim().replace(/\s+/g, ' ');

    // 检查是否需要截断
    if (cleanedContent.length > this.MAX_TOOL_CONTENT_LENGTH) {
      cleanedContent = cleanedContent.substring(0, this.MAX_TOOL_CONTENT_LENGTH) + this.TRUNCATION_MARKER;
    }

    return cleanedContent;
  }

  private cleanAssistantContent(content: string, messages: unknown[], currentIndex: number): string {
    if (typeof content !== 'string') {
      return String(content);
    }

    // 检查是否是最后一轮含tool_calls的assistant
    const isLastToolCallAssistant = this.isLastToolCallAssistant(messages, currentIndex);

    // 检查是否有大段工具结果回灌
    const hasToolResultWrap = this.detectToolResultWrap(content);

    if (isLastToolCallAssistant && hasToolResultWrap) {
      // 将content置空，避免再次被上游当作自由文本误处理
      return '';
    }

    return content;
  }

  private isLastToolCallAssistant(messages: unknown[], currentIndex: number): boolean {
    const currentMessage = messages[currentIndex] as Message;

    // 检查当前消息是否有tool_calls
    if (!currentMessage.tool_calls || !Array.isArray(currentMessage.tool_calls)) {
      return false;
    }

    // 检查是否是最后一个含tool_calls的assistant消息
    for (let i = currentIndex + 1; i < messages.length; i++) {
      const message = messages[i] as Message;
      if (message.role === 'assistant' && message.tool_calls && Array.isArray(message.tool_calls)) {
        return false; // 后面还有含tool_calls的assistant消息
      }
    }

    return true;
  }

  private detectToolResultWrap(content: string): boolean {
    // 检测大段工具结果回灌的模式
    const toolResultPatterns = [
      /tool_result/i,
      /function_result/i,
      /execution_result/i,
      /\{.*result.*\}/i,
      /\"result\"\s*:/i
    ];

    // 检查内容长度（大段文本）
    if (content.length > 1000) {
      return true;
    }

    // 检查是否包含工具结果模式
    for (const pattern of toolResultPatterns) {
      if (pattern.test(content)) {
        return true;
      }
    }

    return false;
  }

  private stripReasoningTags(content: string): string {
    // Strip reasoning思考标签
    const reasoningPatterns = [
      /<reasoning>[\s\S]*?<\/reasoning>/gi,
      /<thinking>[\s\S]*?<\/thinking>/gi,
      /\[REASONING\][\s\S]*?\[\/REASONING\]/gi,
      /\[THINKING\][\s\S]*?\[\/THINKING\]/gi
    ];

    let strippedContent = content;
    for (const pattern of reasoningPatterns) {
      strippedContent = strippedContent.replace(pattern, '');
    }

    return strippedContent.trim();
  }
}
