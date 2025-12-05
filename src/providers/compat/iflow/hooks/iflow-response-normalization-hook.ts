import type { CompatibilityContext } from '../../compatibility-interface.js';
import type { UnknownObject } from '../../../../modules/pipeline/types/common-types.js';
import { BaseHook } from './base-hook.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

type UsageShape = Record<string, unknown> & {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

/**
 * iFlow响应标准化Hook
 * 将iFlow特有的响应格式转换为标准OpenAI格式
 */
export class iFlowResponseNormalizationHook extends BaseHook {
  readonly name = 'glm.02.response-normalization';
  readonly stage = 'outgoing_postprocessing';
  readonly priority = 200;

  async execute(data: UnknownObject, context: CompatibilityContext): Promise<UnknownObject> {
    this.checkInitialized();

    if (!this.shouldExecute(data, context)) {
      return data;
    }

    this.logExecution(context, { stage: 'normalization-start' });

    try {
      const result = { ...data };

      // 标准化usage字段
      if (result.usage) {
        result.usage = this.normalizeUsageFields(result.usage);
      }

      // 标准化时间戳
      if (result.created_at) {
        result.created = result.created_at;
        delete result.created_at;
      }

      // 处理reasoning_content
      if (result.reasoning_content) {
        result.reasoning_content = this.extractReasoningContent(result.reasoning_content);
      }

      // 标准化choices字段
      if (result.choices && Array.isArray(result.choices)) {
        result.choices = this.normalizeChoices(result.choices);
      }

      // 处理model字段
      if (typeof result.model === 'string') {
        result.model = this.normalizeModelName(result.model);
      }

      this.logExecution(context, { stage: 'normalization-complete' });

      return result;
    } catch (error) {
      this.logError(error as Error, context, { stage: 'normalization-error' });
      throw error;
    }
  }

  private normalizeUsageFields(usage: unknown): UnknownObject {
    const normalizedUsage: UsageShape = isRecord(usage) ? { ...usage } : {};

    // iFlow可能使用不同的字段名
    const fieldMappings: Record<string, string> = {
      input_tokens: 'prompt_tokens',
      output_tokens: 'completion_tokens',
      total_input_tokens: 'prompt_tokens',
      total_output_tokens: 'completion_tokens'
    };

    for (const [glmField, standardField] of Object.entries(fieldMappings)) {
      if (normalizedUsage[glmField] !== undefined) {
        normalizedUsage[standardField] = normalizedUsage[glmField];
        delete normalizedUsage[glmField];
      }
    }

    // 确保所有必需字段都存在
    if (normalizedUsage.prompt_tokens === undefined) {
      normalizedUsage.prompt_tokens = 0;
    }

    if (normalizedUsage.completion_tokens === undefined) {
      normalizedUsage.completion_tokens = 0;
    }

    if (normalizedUsage.total_tokens === undefined) {
      const promptTokens = typeof normalizedUsage.prompt_tokens === 'number'
        ? normalizedUsage.prompt_tokens
        : 0;
      const completionTokens = typeof normalizedUsage.completion_tokens === 'number'
        ? normalizedUsage.completion_tokens
        : 0;
      normalizedUsage.total_tokens = promptTokens + completionTokens;
    }

    return normalizedUsage;
  }

  private extractReasoningContent(reasoningContent: unknown): string {
    if (typeof reasoningContent === 'string') {
      return this.extractReasoningBlocks(reasoningContent);
    }

    if (isRecord(reasoningContent)) {
      // 处理对象形式的reasoning_content
      if (typeof reasoningContent.text === 'string') {
        return this.extractReasoningBlocks(reasoningContent.text);
      }
      if (typeof reasoningContent.content === 'string') {
        return this.extractReasoningBlocks(reasoningContent.content);
      }
      if (Array.isArray(reasoningContent.blocks)) {
        return reasoningContent.blocks.join('\n\n');
      }
      if (reasoningContent.blocks !== undefined) {
        return String(reasoningContent.blocks);
      }
      return JSON.stringify(reasoningContent);
    }

    return String(reasoningContent);
  }

  private extractReasoningBlocks(content: string): string {
    if (typeof content !== 'string') {
      return String(content);
    }

    // 提取各种格式的reasoning块
    const reasoningPatterns = [
      /```reasoning\n(.*?)\n```/gs,
      /```thinking\n(.*?)\n```/gs,
      /<reasoning>(.*?)<\/reasoning>/gs,
      /<thinking>(.*?)<\/thinking>/gs,
      /\[REASONING\](.*?)\[\/REASONING\]/gs,
      /\[THINKING\](.*?)\[\/THINKING\]/gs
    ];

    const extractedBlocks: string[] = [];

    for (const pattern of reasoningPatterns) {
      const matches = content.match(pattern);
      if (matches) {
        extractedBlocks.push(
          ...matches.map(match => {
            // 移除标记符号，只保留内容
            return match
              .replace(/```(reasoning|thinking)\n/g, '')
              .replace(/```$/g, '')
              .replace(/<\/?(reasoning|thinking)>/g, '')
              .replace(/\[\/?(REASONING|THINKING)\]/g, '')
              .trim();
          }).filter(block => block.length > 0)
        );
      }
    }

    // 如果没有找到格式化的块，尝试提取内容
    if (extractedBlocks.length === 0) {
      // 检查是否包含reasoning相关的关键词
      const reasoningKeywords = ['reasoning:', 'thinking:', '分析:', '思考:', '推理:'];
      const lines = content.split('\n');

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (reasoningKeywords.some(keyword =>
          trimmedLine.toLowerCase().startsWith(keyword.toLowerCase()))) {
          const extracted = trimmedLine.substring(trimmedLine.indexOf(':') + 1).trim();
          if (extracted.length > 0) {
            extractedBlocks.push(extracted);
          }
        }
      }
    }

    // 去重并返回
    return [...new Set(extractedBlocks)].join('\n\n');
  }

  private normalizeChoices(choices: unknown[]): unknown[] {
    return choices.map(choice => {
      if (!isRecord(choice)) {
        return choice;
      }

      const normalizedChoice: UnknownObject = { ...choice };

      // 标准化finish_reason
      if (typeof normalizedChoice.finish_reason === 'string') {
        normalizedChoice.finish_reason = this.normalizeFinishReason(normalizedChoice.finish_reason);
      }

      // 标准化message字段
      if (isRecord(normalizedChoice.message)) {
        normalizedChoice.message = this.normalizeChoiceMessage(normalizedChoice.message);
      }

      return normalizedChoice;
    });
  }

  private normalizeFinishReason(finishReason: string): string {
    // iFlow可能使用不同的finish_reason值
    const reasonMappings: Record<string, string> = {
      'stop': 'stop',
      'length': 'length',
      'function_call': 'function_call',
      'tool_calls': 'tool_calls',
      'content_filter': 'content_filter',
      'eos': 'stop',
      'max_tokens': 'length',
      'tool': 'tool_calls'
    };

    return reasonMappings[finishReason] || finishReason;
  }

  private normalizeChoiceMessage(message: UnknownObject): UnknownObject {
    const normalizedMessage = { ...message };

    // 标准化content字段
    if ('content' in normalizedMessage) {
      normalizedMessage.content = this.normalizeMessageContent(normalizedMessage.content);
    }

    // 标准化tool_calls字段
    if ('tool_calls' in normalizedMessage) {
      normalizedMessage.tool_calls = this.normalizeToolCalls(normalizedMessage.tool_calls);
    }

    return normalizedMessage;
  }

  private normalizeMessageContent(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      // 将content数组扁平化为字符串
      return content.map(item => {
        if (typeof item === 'string') {
          return item;
        }
        if (typeof item === 'object' && item !== null) {
          return JSON.stringify(item);
        }
        return String(item);
      }).join('');
    }

    if (typeof content === 'object' && content !== null) {
      return JSON.stringify(content);
    }

    return String(content);
  }

  private normalizeToolCalls(toolCalls: unknown): unknown {
    if (!Array.isArray(toolCalls)) {
      return toolCalls;
    }

    return toolCalls.map(toolCall => {
      if (!isRecord(toolCall)) {
        return toolCall;
      }

      const normalizedToolCall: UnknownObject = { ...toolCall };

      // 确保arguments字段是字符串
      const fnPayload = isRecord(normalizedToolCall.function) ? normalizedToolCall.function : undefined;
      if (fnPayload && 'arguments' in fnPayload && typeof fnPayload.arguments !== 'string') {
        try {
          fnPayload.arguments = JSON.stringify(fnPayload.arguments);
        } catch {
          // 如果序列化失败，保持原样
        }
      }

      return normalizedToolCall;
    });
  }

  private normalizeModelName(model: string): string {
    // 标准化模型名称
    const modelMappings: Record<string, string> = {
      'iflow-4': 'iflow-4',
      'iflow-4-0520': 'iflow-4',
      'iflow-4-0920': 'iflow-4',
      'iflow-4-air': 'iflow-4',
      'iflow-4-airx': 'iflow-4',
      'iflow-4-flash': 'iflow-4-flash',
      'iflow-4-long': 'iflow-4-long',
      'iflow-3-turbo': 'iflow-3-turbo',
      'iflow-4v': 'iflow-4v',
      'iflow-4v-plus': 'iflow-4v'
    };

    return modelMappings[model] || model;
  }
}
