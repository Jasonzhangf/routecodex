import type { CompatibilityContext } from '../../compatibility-interface.js';
import type { UnknownObject } from '../../../../modules/pipeline/types/common-types.js';
import { BaseHook } from './base-hook.js';

const isRecord = (value: unknown): value is UnknownObject => typeof value === 'object' && value !== null;

type UsageRecord = Record<string, unknown> & {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

interface ChoiceMessage extends UnknownObject {
  content?: unknown;
  tool_calls?: UnknownObject[];
}

interface ChoiceRecord extends UnknownObject {
  finish_reason?: string;
  message?: ChoiceMessage;
}

/**
 * GLM响应标准化Hook
 * 将GLM特有的响应格式转换为标准OpenAI格式
 */
export class GLMResponseNormalizationHook extends BaseHook {
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

      if (isRecord(result.usage)) {
        result.usage = this.normalizeUsageFields(result.usage);
      }

      if (typeof result.created_at === 'number') {
        result.created = result.created_at;
        delete result.created_at;
      }

      if (result.reasoning_content !== undefined) {
        result.reasoning_content = this.extractReasoningContent(result.reasoning_content);
      }

      if (Array.isArray(result.choices)) {
        result.choices = this.normalizeChoices(result.choices);
      }

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

  private normalizeUsageFields(usage: UsageRecord): UsageRecord {
    const normalizedUsage: UsageRecord = { ...usage };

    const fieldMappings: Record<string, keyof UsageRecord> = {
      input_tokens: 'prompt_tokens',
      output_tokens: 'completion_tokens',
      total_input_tokens: 'prompt_tokens',
      total_output_tokens: 'completion_tokens'
    };

    for (const [glmField, standardField] of Object.entries(fieldMappings)) {
      const value = normalizedUsage[glmField];
      if (typeof value === 'number') {
        normalizedUsage[standardField] = value;
        delete normalizedUsage[glmField];
      }
    }

    normalizedUsage.prompt_tokens = typeof normalizedUsage.prompt_tokens === 'number'
      ? normalizedUsage.prompt_tokens
      : 0;
    normalizedUsage.completion_tokens = typeof normalizedUsage.completion_tokens === 'number'
      ? normalizedUsage.completion_tokens
      : 0;

    if (typeof normalizedUsage.total_tokens !== 'number') {
      normalizedUsage.total_tokens = normalizedUsage.prompt_tokens + normalizedUsage.completion_tokens;
    }

    return normalizedUsage;
  }

  private extractReasoningContent(reasoningContent: unknown): string {
    if (typeof reasoningContent === 'string') {
      return this.extractReasoningBlocks(reasoningContent);
    }

    if (isRecord(reasoningContent)) {
      if (typeof reasoningContent.text === 'string') {
        return this.extractReasoningBlocks(reasoningContent.text);
      }
      if (typeof reasoningContent.content === 'string') {
        return this.extractReasoningBlocks(reasoningContent.content);
      }
      if (Array.isArray(reasoningContent.blocks)) {
        return reasoningContent.blocks.map(block => String(block)).join('\n\n');
      }
      return JSON.stringify(reasoningContent);
    }

    return String(reasoningContent ?? '');
  }

  private extractReasoningBlocks(content: string): string {
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
      const matches = content.matchAll(pattern);
      for (const match of matches) {
        const block = match[1] ?? '';
        const normalized = String(block)
          .replace(/```(reasoning|thinking)\n?/g, '')
          .replace(/```$/g, '')
          .trim();
        if (normalized.length > 0) {
          extractedBlocks.push(normalized);
        }
      }
    }

    if (extractedBlocks.length === 0) {
      const reasoningKeywords = ['reasoning:', 'thinking:', '分析:', '思考:', '推理:'];
      const lines = content.split('\n');

      for (const line of lines) {
        const trimmedLine = line.trim();
        const keyword = reasoningKeywords.find(keyword => trimmedLine.toLowerCase().startsWith(keyword.toLowerCase()));
        if (keyword) {
          const idx = trimmedLine.indexOf(':');
          const snippet = idx >= 0 ? trimmedLine.slice(idx + 1).trim() : trimmedLine;
          if (snippet.length > 0) {
            extractedBlocks.push(snippet);
          }
        }
      }
    }

    return [...new Set(extractedBlocks)].join('\n\n');
  }

  private normalizeChoices(choices: unknown[]): ChoiceRecord[] {
    return choices.map(choice => {
      if (!isRecord(choice)) {
        return choice as ChoiceRecord;
      }

      const normalizedChoice: ChoiceRecord = { ...choice };

      if (typeof normalizedChoice.finish_reason === 'string') {
        normalizedChoice.finish_reason = this.normalizeFinishReason(normalizedChoice.finish_reason);
      }

      if (isRecord(normalizedChoice.message)) {
        normalizedChoice.message = this.normalizeChoiceMessage(normalizedChoice.message);
      }

      return normalizedChoice;
    }) as ChoiceRecord[];
  }

  private normalizeFinishReason(finishReason: string): string {
    const reasonMappings: Record<string, string> = {
      stop: 'stop',
      length: 'length',
      function_call: 'function_call',
      tool_calls: 'tool_calls',
      content_filter: 'content_filter',
      eos: 'stop',
      max_tokens: 'length',
      tool: 'tool_calls'
    };

    return reasonMappings[finishReason] ?? finishReason;
  }

  private normalizeChoiceMessage(message: ChoiceMessage): ChoiceMessage {
    const normalizedMessage: ChoiceMessage = { ...message };

    if (normalizedMessage.content !== undefined) {
      normalizedMessage.content = this.normalizeMessageContent(normalizedMessage.content);
    }

    if (Array.isArray(normalizedMessage.tool_calls)) {
      normalizedMessage.tool_calls = this.normalizeToolCalls(normalizedMessage.tool_calls);
    }

    return normalizedMessage;
  }

  private normalizeMessageContent(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content.map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join('');
    }

    if (isRecord(content)) {
      return JSON.stringify(content);
    }

    return String(content ?? '');
  }

  private normalizeToolCalls(toolCalls: UnknownObject[]): UnknownObject[] {
    return toolCalls.map(toolCall => {
      if (!isRecord(toolCall)) {
        return toolCall;
      }

      const normalizedToolCall: UnknownObject = { ...toolCall };
      const func = normalizedToolCall.function;

      if (isRecord(func) && func.arguments !== undefined && typeof func.arguments !== 'string') {
        try {
          func.arguments = JSON.stringify(func.arguments);
        } catch {
          // 保持原状，交由后续环节处理
        }
        normalizedToolCall.function = func;
      }

      return normalizedToolCall;
    });
  }

  private normalizeModelName(model: string): string {
    const modelMappings: Record<string, string> = {
      'glm-4': 'glm-4',
      'glm-4-0520': 'glm-4',
      'glm-4-0920': 'glm-4',
      'glm-4-air': 'glm-4',
      'glm-4-airx': 'glm-4',
      'glm-4-flash': 'glm-4-flash',
      'glm-4-long': 'glm-4-long',
      'glm-3-turbo': 'glm-3-turbo',
      'glm-4v': 'glm-4v',
      'glm-4v-plus': 'glm-4v'
    };

    return modelMappings[model] ?? model;
  }
}
