import type { CompatibilityContext } from '../../compatibility-interface.js';
import type { UnknownObject } from '../../../../modules/pipeline/types/common-types.js';
import type { ModuleDependencies } from '../../../../modules/pipeline/types/module.types.js';
import { BaseHook } from './base-hook.js';

/**
 * iFlow响应校验Hook
 * 校验响应字段的完整性和有效性，特别是工具调用相关的字段
 */
export class iFlowResponseValidationHook extends BaseHook {
  readonly name = 'glm.01.response-validation';
  readonly stage = 'outgoing_validation';
  readonly priority = 300;

  async execute(data: UnknownObject, context: CompatibilityContext): Promise<UnknownObject> {
    this.checkInitialized();

    if (!this.shouldExecute(data, context)) {
      return data;
    }

    this.logExecution(context, { stage: 'response-validation-start' });

    try {
      // 统一解包（provider可能返回 { data, status, headers, metadata } 结构）
      const payload = this.unwrapResponse(data);
      // 执行响应校验（仅校验iFlow最小必要字段）
      this.validateResponse(payload);

      this.logExecution(context, { stage: 'response-validation-success' });

      return data;
    } catch (error) {
      this.logError(error as Error, context, { stage: 'response-validation-error' });
      throw error;
    }
  }

  private validateResponse(response: UnknownObject): void {
    const errors: string[] = [];

    // 基础字段校验（不强制要求 OpenAI 的 object 字段）
    errors.push(...this.validateBasicFields(response));

    // choices字段校验
    if (response.choices) {
      errors.push(...this.validateChoices(response.choices));
    }

    // usage字段校验
    if (response.usage) {
      errors.push(...this.validateUsage(response.usage));
    }

    if (errors.length > 0) {
      throw new Error(`iFlow响应校验失败:\n${errors.join('\n')}`);
    }
  }

  private validateBasicFields(response: UnknownObject): string[] {
    const errors: string[] = [];

    // 检查必需字段
    if (!response.id || typeof response.id !== 'string') {
      errors.push('响应缺少有效的id字段');
    }

    // iFlow 不提供 OpenAI 的 object 字段，不强制

    if (!response.created || typeof response.created !== 'number') {
      errors.push('响应缺少有效的created字段');
    }

    if (!response.model || typeof response.model !== 'string') {
      errors.push('响应缺少有效的model字段');
    }

    return errors;
  }

  private unwrapResponse(response: UnknownObject): UnknownObject {
    try {
      if (response && typeof response === 'object' && 'data' in response && (response as any).data) {
        const d = (response as any).data;
        if (d && typeof d === 'object') { return d as UnknownObject; }
      }
    } catch { /* ignore */ }
    return response;
  }

  private validateChoices(choices: unknown): string[] {
    const errors: string[] = [];

    if (!Array.isArray(choices)) {
      errors.push('choices字段必须是数组');
      return errors;
    }

    if (choices.length === 0) {
      errors.push('choices数组不能为空');
    }

    for (let i = 0; i < choices.length; i++) {
      const choice = choices[i];
      if (!choice || typeof choice !== 'object') {
        errors.push(`choices[${i}]必须是对象`);
        continue;
      }

      const choiceErrors = this.validateChoice(choice as UnknownObject, i);
      errors.push(...choiceErrors);
    }

    return errors;
  }

  private validateChoice(choice: UnknownObject, index: number): string[] {
    const errors: string[] = [];

    // 检查index字段
    if (choice.index === undefined || typeof choice.index !== 'number') {
      errors.push(`choices[${index}].index字段必须是数字`);
    }

    // 检查finish_reason字段
    if (!choice.finish_reason || typeof choice.finish_reason !== 'string') {
      errors.push(`choices[${index}].finish_reason字段必须是有效字符串`);
    }

    // 检查message字段
    if (!choice.message || typeof choice.message !== 'object') {
      errors.push(`choices[${index}].message字段必须是对象`);
    } else {
      const messageErrors = this.validateMessage(choice.message as UnknownObject, index);
      errors.push(...messageErrors);
    }

    return errors;
  }

  private validateMessage(message: UnknownObject, choiceIndex: number): string[] {
    const errors: string[] = [];

    // 检查role字段
    if (!message.role || typeof message.role !== 'string') {
      errors.push(`choices[${choiceIndex}].message.role字段必须是有效字符串`);
    } else if (!['assistant', 'user', 'system', 'tool'].includes(message.role as string)) {
      errors.push(`choices[${choiceIndex}].message.role字段值无效`);
    }

    // 检查content字段
    if (message.content !== undefined && message.content !== null) {
      if (typeof message.content !== 'string') {
        errors.push(`choices[${choiceIndex}].message.content字段必须是字符串或null`);
      }
    }

    // 工具调用由 llmswitch-core 统一校验与修复；此处不阻断（最小清理原则）
    // if (message.tool_calls) {
    //   const toolCallErrors = this.validateToolCalls(message.tool_calls, choiceIndex);
    //   errors.push(...toolCallErrors);
    // }

    return errors;
  }

  private validateToolCalls(toolCalls: unknown, choiceIndex: number): string[] {
    const errors: string[] = [];

    if (!Array.isArray(toolCalls)) {
      errors.push(`choices[${choiceIndex}].message.tool_calls字段必须是数组`);
      return errors;
    }

    if (toolCalls.length === 0) {
      errors.push(`choices[${choiceIndex}].message.tool_calls数组不能为空`);
    }

    for (let i = 0; i < toolCalls.length; i++) {
      const toolCall = toolCalls[i];
      if (!toolCall || typeof toolCall !== 'object') {
        errors.push(`choices[${choiceIndex}].message.tool_calls[${i}]必须是对象`);
        continue;
      }

      const toolCallErrors = this.validateToolCall(toolCall as UnknownObject, choiceIndex, i);
      errors.push(...toolCallErrors);
    }

    return errors;
  }

  private validateToolCall(toolCall: UnknownObject, choiceIndex: number, toolCallIndex: number): string[] {
    const errors: string[] = [];

    // 检查id字段
    if (!toolCall.id || typeof toolCall.id !== 'string') {
      errors.push(`choices[${choiceIndex}].message.tool_calls[${toolCallIndex}].id字段不能为空且必须是字符串`);
    }

    // 检查type字段
    if (!toolCall.type || typeof toolCall.type !== 'string') {
      errors.push(`choices[${choiceIndex}].message.tool_calls[${toolCallIndex}].type字段不能为空且必须是字符串`);
    } else if (toolCall.type !== 'function') {
      errors.push(`choices[${choiceIndex}].message.tool_calls[${toolCallIndex}].type字段值必须是'function'`);
    }

    // 检查function字段
    if (!toolCall.function || typeof toolCall.function !== 'object') {
      errors.push(`choices[${choiceIndex}].message.tool_calls[${toolCallIndex}].function字段必须是对象`);
    } else {
      const functionErrors = this.validateToolCallFunction(toolCall.function as UnknownObject, choiceIndex, toolCallIndex);
      errors.push(...functionErrors);
    }

    return errors;
  }

  private validateToolCallFunction(func: UnknownObject, choiceIndex: number, toolCallIndex: number): string[] {
    const errors: string[] = [];

    // 检查name字段
    if (!func.name || typeof func.name !== 'string') {
      errors.push(`choices[${choiceIndex}].message.tool_calls[${toolCallIndex}].function.name字段不能为空且必须是字符串`);
    }

    // 检查arguments字段
    if (!func.arguments || typeof func.arguments !== 'string') {
      errors.push(`choices[${choiceIndex}].message.tool_calls[${toolCallIndex}].function.arguments字段不能为空且必须是字符串`);
    } else {
      // 验证arguments是否为有效的JSON
      try {
        JSON.parse(func.arguments as string);
      } catch (error) {
        errors.push(`choices[${choiceIndex}].message.tool_calls[${toolCallIndex}].function.arguments字段必须是有效的JSON字符串`);
      }
    }

    return errors;
  }

  private validateUsage(usage: any): string[] {
    const errors: string[] = [];

    if (!usage || typeof usage !== 'object') {
      errors.push('usage字段必须是对象');
      return errors;
    }

    // 检查prompt_tokens
    if (usage.prompt_tokens !== undefined) {
      if (typeof usage.prompt_tokens !== 'number' || usage.prompt_tokens < 0) {
        errors.push('usage.prompt_tokens必须是非负数');
      }
    }

    // 检查completion_tokens
    if (usage.completion_tokens !== undefined) {
      if (typeof usage.completion_tokens !== 'number' || usage.completion_tokens < 0) {
        errors.push('usage.completion_tokens必须是非负数');
      }
    }

    // 检查total_tokens
    if (usage.total_tokens !== undefined) {
      if (typeof usage.total_tokens !== 'number' || usage.total_tokens < 0) {
        errors.push('usage.total_tokens必须是非负数');
      }
    }

    // 验证token数量的一致性
    if (usage.prompt_tokens !== undefined && usage.completion_tokens !== undefined && usage.total_tokens !== undefined) {
      const expectedTotal = usage.prompt_tokens + usage.completion_tokens;
      if (usage.total_tokens !== expectedTotal) {
        errors.push(`usage.total_tokens (${usage.total_tokens}) 应该等于 prompt_tokens (${usage.prompt_tokens}) + completion_tokens (${usage.completion_tokens})`);
      }
    }

    return errors;
  }
}
