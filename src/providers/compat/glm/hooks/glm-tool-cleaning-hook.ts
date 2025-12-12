import type { CompatibilityContext } from '../../compatibility-interface.js';
import type { UnknownObject } from '../../../../modules/pipeline/types/common-types.js';
import { BaseHook } from './base-hook.js';
import { extractToolText } from '../../../core/utils/tool-result-text.js';
import { sanitizeGLMToolsSchema } from '../utils/tool-schema-helpers.js';

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
  tool_calls?: ToolCall[];
}

interface ToolCall extends UnknownObject {
  id?: string;
  type?: string;
  function?: ToolCallFunction;
}

interface ToolCallFunction extends UnknownObject {
  arguments?: unknown;
}

/**
 * GLM工具清洗Hook
 * 处理GLM特有的工具消息清洗逻辑
 */
export class iFlowToolCleaningHook extends BaseHook {
  readonly name = 'glm.01.tool-cleaning';
  readonly stage = 'incoming_preprocessing';
  readonly priority = 100;

  async execute(data: UnknownObject, context: CompatibilityContext): Promise<UnknownObject> {
    this.checkInitialized();

    if (!this.shouldExecute(data, context)) {
      return data;
    }

    this.logExecution(context, { stage: 'tool-cleaning-start' });

    try {
      const result: UnknownObject = { ...data };

      if (Array.isArray(result.messages)) {
        result.messages = this.cleanMessages(result.messages);
      }

      if (Array.isArray(result.tools)) {
        const sanitizedTools = sanitizeGLMToolsSchema({ tools: result.tools }).tools;
        result.tools = Array.isArray(sanitizedTools) ? sanitizedTools : result.tools;
      }

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
    return messages.map((rawMessage, index) => {
      const message = this.cloneMessage(rawMessage);

      if (message.role === 'tool') {
        message.content = this.normalizeToolContent(message.content);
      }

      if (this.isLastToolMessage(messages, index) && typeof message.content === 'string') {
        message.content = this.cleanToolContent(message.content);
      }

      if (message.role === 'assistant') {
        message.content = this.cleanAssistantContent(message.content, messages, index);
      }

      if (Array.isArray(message.tool_calls)) {
        message.tool_calls = this.normalizeToolCallArguments(message.tool_calls);
      }

      if (Array.isArray(message.content)) {
        message.content = this.flattenLegacyContent(message.content);
      }

      return message;
    });
  }

  private cloneMessage(rawMessage: unknown): Message {
    if (
      !rawMessage ||
      typeof rawMessage !== 'object' ||
      !('role' in rawMessage) ||
      typeof (rawMessage as { role?: unknown }).role !== 'string'
    ) {
      return { role: 'assistant', content: '' };
    }

    const message = rawMessage as Message;
    return {
      role: message.role,
      content: message.content ?? '',
      tool_calls: Array.isArray(message.tool_calls) ? [...message.tool_calls] : undefined
    };
  }

  private normalizeToolContent(content: unknown): string {
    const text = extractToolText(content);
    if (!(typeof text === 'string' && text.trim().length)) {
      const err = new Error('ERR_COMPAT_TOOL_TEXT_EMPTY: tool message content is empty or invalid');
      (err as Error & { code?: string }).code = 'ERR_COMPAT_TOOL_TEXT_EMPTY';
      throw err;
    }
    return text.trim();
  }

  private normalizeToolCallArguments(toolCalls: ToolCall[]): ToolCall[] {
    return toolCalls.map(call => {
      if (!call || typeof call !== 'object') {
        return call;
      }
      const fn = call.function;
      if (this.isToolFunction(fn) && fn.arguments !== undefined && typeof fn.arguments !== 'string') {
        try {
          fn.arguments = JSON.stringify(fn.arguments);
        } catch {
          // 保持原状，后续环节会兜底
        }
        call.function = fn;
      }
      return call;
    });
  }

  private cleanToolCalls(toolCalls: unknown[]): ToolCall[] {
    return toolCalls.map(toolCall => {
      const normalized = this.cloneToolCall(toolCall);
      const fn = normalized.function;
      if (!this.isToolFunction(fn)) {
        return normalized;
      }
      const args = fn.arguments;
      if (typeof args === 'string') {
        try {
          fn.arguments = JSON.parse(args);
        } catch {
          const err = new Error('ERR_COMPAT_TOOLCALL_ARGS_INVALID: arguments not JSON');
          (err as Error & { code?: string }).code = 'ERR_COMPAT_TOOLCALL_ARGS_INVALID';
          throw err;
        }
      }
      normalized.function = fn;
      return normalized;
    });
  }

  private cloneToolCall(toolCall: unknown): ToolCall {
    if (!toolCall || typeof toolCall !== 'object') {
      return {};
    }
    const call = toolCall as ToolCall;
    return {
      ...call,
      function: call.function ? { ...call.function } : undefined
    };
  }

  private isToolFunction(value: unknown): value is ToolCallFunction {
    return Boolean(value && typeof value === 'object');
  }

  private isLastToolMessage(messages: unknown[], index: number): boolean {
    if (index !== messages.length - 1) {
      return false;
    }
    const message = messages[index] as Message;
    return message.role === 'tool';
  }

  private cleanToolContent(content: string): string {
    return content;
  }

  private cleanAssistantContent(content: unknown, messages: unknown[], currentIndex: number): string {
    const normalizedContent = typeof content === 'string' ? content : String(content ?? '');
    const isLastToolCallAssistant = this.isLastToolCallAssistant(messages, currentIndex);
    const hasToolResultWrap = this.detectToolResultWrap(normalizedContent);

    if (isLastToolCallAssistant && hasToolResultWrap) {
      return '';
    }

    return normalizedContent;
  }

  private isLastToolCallAssistant(messages: unknown[], currentIndex: number): boolean {
    const currentMessage = messages[currentIndex] as Message;

    if (!Array.isArray(currentMessage.tool_calls) || currentMessage.tool_calls.length === 0) {
      return false;
    }

    for (let i = currentIndex + 1; i < messages.length; i++) {
      const message = messages[i] as Message;
      if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        return false;
      }
    }

    return true;
  }

  private detectToolResultWrap(content: string): boolean {
    const toolResultPatterns = [
      /tool_result/i,
      /function_result/i,
      /execution_result/i,
      /\{.*result.*\}/i,
      /"result"\s*:/i
    ];

    if (content.length > 1000) {
      return true;
    }

    return toolResultPatterns.some(pattern => pattern.test(content));
  }

  private flattenLegacyContent(items: unknown[]): string {
    return items
      .map(item => (typeof item === 'string' ? item : JSON.stringify(item)))
      .join('');
  }
}
