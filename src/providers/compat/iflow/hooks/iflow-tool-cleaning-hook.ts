import type { CompatibilityContext } from '../../compatibility-interface.js';
import type { UnknownObject } from '../../../../modules/pipeline/types/common-types.js';
import { BaseHook } from './base-hook.js';
// 统一的工具结果文本提取器：保证 tool 消息 content 为非空字符串
import { extractToolText } from '../../../core/utils/tool-result-text.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * 消息接口
 */
interface Message {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
}

/**
 * iFlow工具清洗Hook
 * 处理iFlow特有的工具消息清洗逻辑
 */
export class iFlowToolCleaningHook extends BaseHook {
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
      const result: UnknownObject = { ...data };

      // 处理messages字段
      if (Array.isArray(result.messages)) {
        result.messages = this.cleanMessages(result.messages);
      }

      // 处理tools字段（最小清理：移除 function.strict，仅做噪声清理；规范化交由形状过滤器处理）
      if (Array.isArray(result.tools)) {
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
      const message = this.coerceMessage(messages[i]);
      if (!message) {
        cleanedMessages.push(messages[i] as Message);
        continue;
      }
      const cleanedMessage: Message = { ...message };

      // 对 role:'tool' 的消息，统一拍平为非空字符串（失败严格报错；禁止兜底/静默）
      if (cleanedMessage.role === 'tool') {
        const text = extractToolText(cleanedMessage.content);
        if (!(typeof text === 'string' && text.trim().length)) {
          const err = new Error('ERR_COMPAT_TOOL_TEXT_EMPTY: tool message content is empty or invalid');
          (err as { code?: string }).code = 'ERR_COMPAT_TOOL_TEXT_EMPTY';
          throw err;
        }
        cleanedMessage.content = text.trim();
      }

      // 处理最后一条role=tool的消息（在文本拍平后，再做噪声清理与截断）
      if (this.isLastToolMessage(messages, i)) {
        const toolContent = typeof cleanedMessage.content === 'string'
          ? cleanedMessage.content
          : String(cleanedMessage.content ?? '');
        cleanedMessage.content = this.cleanToolContent(toolContent);
      }

      // 处理assistant消息中的大段工具结果回灌
      if (message.role === 'assistant') {
        const assistantContent = typeof cleanedMessage.content === 'string' ? cleanedMessage.content : '';
        cleanedMessage.content = this.cleanAssistantContent(assistantContent, messages, i);
      }

      // 不在此处处理 tool_calls 参数形状；交由形状过滤器统一处理

      // llmswitch-core现在返回字符串，不再需要数组拍平处理
      // 保留此逻辑仅用于兼容旧的数组格式数据
      if (Array.isArray(cleanedMessage.content)) {
        console.warn('iFlow Tool Cleaning: 接收到数组格式的content，可能来自旧版本兼容');
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
    // 最小清理：仅移除 tools[].function.strict（iFlow不识别），其余规范化由形状过滤器处理
    return tools.map(tool => {
      if (!isRecord(tool)) {
        return tool;
      }
      const cleanedTool: UnknownObject = { ...tool };
      const fn = isRecord(cleanedTool.function) ? { ...cleanedTool.function } : undefined;
      if (fn) {
        if ('strict' in fn) {
          delete fn.strict;
        }
        cleanedTool.function = fn;
      }
      return cleanedTool;
    });
  }

  private cleanToolCalls(toolCalls: unknown[]): unknown[] {
    return toolCalls.map(tc => {
      if (!isRecord(tc)) {
        return tc;
      }
      const copy: UnknownObject = { ...tc };
      const fn: UnknownObject = isRecord(copy.function) ? { ...copy.function } : {};
      const args = 'arguments' in fn ? fn.arguments : undefined;
      if (typeof args === 'string') {
        try {
          fn.arguments = JSON.parse(args);
        } catch {
          const err = new Error('ERR_COMPAT_TOOLCALL_ARGS_INVALID: arguments not JSON');
          (err as { code?: string }).code = 'ERR_COMPAT_TOOLCALL_ARGS_INVALID';
          throw err;
        }
      }
      copy.function = fn;
      return copy;
    });
  }

  private isLastToolMessage(messages: unknown[], index: number): boolean {
    if (index !== messages.length - 1) {
      return false;
    }

    const message = this.coerceMessage(messages[index]);
    return message?.role === 'tool';
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
    const currentMessage = this.coerceMessage(messages[currentIndex]);
    if (!currentMessage || currentMessage.role !== 'assistant') {
      return false;
    }

    // 检查当前消息是否有tool_calls
    if (!Array.isArray(currentMessage.tool_calls)) {
      return false;
    }

    // 检查是否是最后一个含tool_calls的assistant消息
    for (let i = currentIndex + 1; i < messages.length; i++) {
      const message = this.coerceMessage(messages[i]);
      if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
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
      /"result"\s*:/i
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

  private coerceMessage(candidate: unknown): Message | null {
    if (!isRecord(candidate)) {
      return null;
    }
    return candidate as Message;
  }
}
