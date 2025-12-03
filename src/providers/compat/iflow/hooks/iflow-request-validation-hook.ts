import type { CompatibilityContext } from '../../compatibility-interface.js';
import type { UnknownObject } from '../../../../modules/pipeline/types/common-types.js';
import type { ModuleDependencies } from '../../../../modules/pipeline/types/module.types.js';
import { BaseHook } from './base-hook.js';

/**
 * 校验规则接口
 */
interface ValidationRule {
  field: string;
  required?: boolean;
  checkEmpty?: boolean;
  type?: string;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  allowedValues?: string[];
  conditional?: {
    when: string;
    errorMessage?: string;
  };
  errorMessage: string;
}

/**
 * iFlow请求校验Hook
 * 校验请求字段的完整性和有效性
 */
export class iFlowRequestValidationHook extends BaseHook {
  readonly name = 'glm.02.request-validation';
  readonly stage = 'incoming_validation';
  readonly priority = 300;

  private validationRules: ValidationRule[] = [];

  async initialize(): Promise<void> {
    await super.initialize();
    this.setupValidationRules();

    this.dependencies.logger?.logModule('iflow-request-validation', 'rules-loaded', {
      rulesCount: this.validationRules.length
    });
  }

  async execute(data: UnknownObject, context: CompatibilityContext): Promise<UnknownObject> {
    this.checkInitialized();

    if (!this.shouldExecute(data, context)) {
      return data;
    }

    this.logExecution(context, { stage: 'validation-start' });

    try {
      // 执行所有校验规则
      this.validateData(data);

      this.logExecution(context, { stage: 'validation-success' });

      return data;
    } catch (error) {
      this.logError(error as Error, context, { stage: 'validation-error' });
      throw error;
    }
  }

  private setupValidationRules(): void {
    this.validationRules = [
      {
        field: 'model',
        required: true,
        checkEmpty: true,
        errorMessage: 'model字段不能为空'
      },
      {
        field: 'messages',
        required: true,
        checkEmpty: true,
        type: 'array',
        minLength: 1,
        errorMessage: 'messages字段不能为空且至少包含一条消息'
      },
      {
        field: 'messages[*].role',
        required: true,
        checkEmpty: true,
        allowedValues: ['system', 'user', 'assistant', 'tool'],
        errorMessage: 'messages中的role字段必须是有效值 (system, user, assistant, tool)'
      },
      {
        field: 'messages[*].content',
        required: true,
        conditional: {
          when: "messages[i].role !== 'tool'",
          errorMessage: '非tool角色的消息content不能为空'
        },
        errorMessage: 'messages中的content字段不能为空'
      },
      {
        field: 'messages[*].tool_calls',
        conditional: {
          when: "messages[i].role === 'assistant'",
          errorMessage: 'assistant角色的tool_calls字段如果存在必须有效'
        },
        type: 'array',
        errorMessage: 'tool_calls字段必须是数组'
      },
      {
        field: 'temperature',
        type: 'number',
        min: 0,
        max: 2,
        errorMessage: 'temperature字段必须是0-2之间的数字'
      },
      {
        field: 'max_tokens',
        type: 'number',
        min: 1,
        max: 32768,
        errorMessage: 'max_tokens字段必须是1-32768之间的数字'
      },
      {
        field: 'top_p',
        type: 'number',
        min: 0,
        max: 1,
        errorMessage: 'top_p字段必须是0-1之间的数字'
      },
      {
        field: 'frequency_penalty',
        type: 'number',
        min: -2,
        max: 2,
        errorMessage: 'frequency_penalty字段必须是-2到2之间的数字'
      },
      {
        field: 'presence_penalty',
        type: 'number',
        min: -2,
        max: 2,
        errorMessage: 'presence_penalty字段必须是-2到2之间的数字'
      }
    ];
  }

  private validateData(data: UnknownObject): void {
    const errors: string[] = [];

    for (const rule of this.validationRules) {
      try {
        this.validateRule(data, rule);
      } catch (error) {
        if (error instanceof Error) {
          errors.push(error.message);
        } else {
          errors.push(String(error));
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(`iFlow请求校验失败:\n${errors.join('\n')}`);
    }
  }

  private validateRule(data: UnknownObject, rule: ValidationRule): void {
    const fieldValue = this.getFieldValue(data, rule.field);

    // 检查必需字段
    if (rule.required && fieldValue === undefined) {
      throw new Error(rule.errorMessage);
    }

    // 如果字段不存在且不是必需的，跳过其他校验
    if (fieldValue === undefined && !rule.required) {
      return;
    }

    // 检查条件校验
    if (rule.conditional && !this.evaluateConditional(data, rule.conditional, rule.field)) {
      return;
    }

    // 检查空值
    if (rule.checkEmpty && (fieldValue === null || fieldValue === '' ||
        (Array.isArray(fieldValue) && fieldValue.length === 0))) {
      throw new Error(rule.errorMessage);
    }

    // 类型校验
    if (rule.type && !this.validateType(fieldValue, rule.type)) {
      throw new Error(rule.errorMessage);
    }

    // 长度校验
    if (typeof fieldValue === 'string' || Array.isArray(fieldValue)) {
      const length = fieldValue.length;

      if (rule.minLength !== undefined && length < rule.minLength) {
        throw new Error(rule.errorMessage);
      }

      if (rule.maxLength !== undefined && length > rule.maxLength) {
        throw new Error(rule.errorMessage);
      }
    }

    // 数值范围校验
    if (typeof fieldValue === 'number') {
      if (rule.min !== undefined && fieldValue < rule.min) {
        throw new Error(rule.errorMessage);
      }

      if (rule.max !== undefined && fieldValue > rule.max) {
        throw new Error(rule.errorMessage);
      }
    }

    // 允许值校验（支持通配符字段返回数组的情况，如 messages[*].role）
    if (rule.allowedValues) {
      if (Array.isArray(fieldValue)) {
        for (let i = 0; i < fieldValue.length; i++) {
          const v = fieldValue[i];
          if (!rule.allowedValues.includes(String(v))) {
            throw new Error(rule.errorMessage);
          }
        }
      } else {
        if (!rule.allowedValues.includes(String(fieldValue))) {
          throw new Error(rule.errorMessage);
        }
      }
    }
  }

  private getFieldValue(data: UnknownObject, fieldPath: string): any {
    // 处理通配符路径，如 messages[*].role
    if (fieldPath.includes('[*]')) {
      return this.getArrayFieldValues(data, fieldPath);
    }

    // 处理普通路径，如 model, messages
    return fieldPath.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : undefined;
    }, data as any);
  }

  private getArrayFieldValues(data: UnknownObject, fieldPath: string): any[] {
    const parts = fieldPath.split('[*]');
    if (parts.length !== 2) {
      return [];
    }

    const arrayPath = parts[0];
    const fieldPathInArray = parts[1].replace(/^\./, ''); // 移除开头的点

    const arrayValue = arrayPath.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : undefined;
    }, data as any);

    if (!Array.isArray(arrayValue)) {
      return [];
    }

    return arrayValue.map(item => {
      if (!fieldPathInArray) {
        return item;
      }

      return fieldPathInArray.split('.').reduce((current, key) => {
        return current && current[key] !== undefined ? current[key] : undefined;
      }, item as any);
    });
  }

  private evaluateConditional(data: UnknownObject, conditional: any, currentField: string): boolean {
    // 简单的条件评估
    // 例如: "messages[i].role !== 'tool'"

    // 获取当前字段对应的数组值
    const arrayValues = this.getArrayFieldValues(data, currentField);

    for (let i = 0; i < arrayValues.length; i++) {
      const condition = conditional.when.replace(/\bi\b/g, i.toString());

      // 替换字段引用
      let evaluatedCondition = condition;

      // 替换 messages[i].role 等引用
      evaluatedCondition = evaluatedCondition.replace(
        /messages\[i\]\.role/g,
        `JSON.stringify(this.getArrayFieldValues(data, 'messages[*].role')[i])`
      );

      try {
        // 简单的条件评估
        if (evaluatedCondition.includes("!== 'tool'")) {
          const roleValue = this.getArrayFieldValues(data, 'messages[*].role')[i];
          if (roleValue === 'tool') {
            return false;
          }
        }
      } catch (error) {
        // 条件评估失败，默认为不满足条件
        return false;
      }
    }

    return true;
  }

  private validateType(value: any, expectedType: string): boolean {
    switch (expectedType) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number' && !isNaN(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'array':
        return Array.isArray(value);
      case 'object':
        return typeof value === 'object' && value !== null && !Array.isArray(value);
      default:
        return true;
    }
  }
}
