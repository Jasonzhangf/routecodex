/**
 * Field Mapping Rules
 * 字段映射规则定义
 */

import type {
  ModelMappingRule,
  ParameterMappingRule,
  MappingCondition,
  ParamTransformer,
  ParamValidator,
  ValidationResult,
  ConversionContext
} from './types.js';

/**
 * 字段映射规则管理器
 */
export class FieldMappingRules {
  private modelMappings: Map<string, ModelMappingRule[]> = new Map();
  private parameterMappings: Map<string, ParameterMappingRule[]> = new Map();
  private defaultMappings: ParameterMappingRule[] = [];
  private config: {
    defaultMaxTokens: number;
    defaultModel: string;
  };

  constructor(config?: { defaultMaxTokens?: number; defaultModel?: string; pipelineConfigs?: any }) {
    // Extract defaults from pipeline configs if available
    let defaultMaxTokens = 32000;
    let defaultModel = 'qwen3-coder-plus';

    if (config?.pipelineConfigs && Object.keys(config.pipelineConfigs).length > 0) {
      const firstConfigKey = Object.keys(config.pipelineConfigs)[0];
      const firstConfig = config.pipelineConfigs[firstConfigKey];
      defaultMaxTokens = firstConfig.model?.maxTokens || 32000;

      // Extract model ID from the pipeline config key (format: provider.model.keyId)
      const keyParts = firstConfigKey.split('.');
      if (keyParts.length >= 2) {
        defaultModel = keyParts[1]; // Use the modelId from the config key
      }
    }

    this.config = {
      defaultMaxTokens: config?.defaultMaxTokens || defaultMaxTokens,
      defaultModel: config?.defaultModel || defaultModel
    };
    this.initializeDefaultRules();
  }

  /**
   * 初始化默认规则
   */
  private initializeDefaultRules(): void {
    // 默认参数映射规则
    this.defaultMappings = [
      {
        sourceField: 'model',
        transformer: this.transformModel.bind(this),
        validator: this.validateModel.bind(this)
      },
      {
        sourceField: 'max_tokens',
        transformer: this.transformMaxTokens.bind(this),
        validator: this.validateMaxTokens.bind(this)
      },
      {
        sourceField: 'temperature',
        transformer: this.transformTemperature.bind(this),
        validator: this.validateTemperature.bind(this),
        defaultValue: 0.7
      },
      {
        sourceField: 'top_p',
        transformer: this.transformTopP.bind(this),
        validator: this.validateTopP.bind(this),
        defaultValue: 1.0
      },
      {
        sourceField: 'stream',
        transformer: this.transformStream.bind(this),
        defaultValue: false
      },
      {
        sourceField: 'stop',
        transformer: this.transformStop.bind(this)
      }
    ];

    // 初始化模型映射规则
    this.initializeModelMappings();
  }

  /**
   * 初始化模型映射规则
   */
  private initializeModelMappings(): void {
    // 通用模型映射规则
    const genericModelMappings: ModelMappingRule[] = [
      {
        pattern: 'gpt-4',
        targetModel: 'qwen3-coder-plus',
        provider: 'qwen',
        priority: 1
      },
      {
        pattern: 'gpt-3.5-turbo',
        targetModel: 'qwen3-coder',
        provider: 'qwen',
        priority: 1
      },
      {
        pattern: 'claude-3-sonnet',
        targetModel: 'glm-4',
        provider: 'iflow',
        priority: 1
      },
      {
        pattern: 'claude-3-haiku',
        targetModel: 'deepseek-r1',
        provider: 'iflow',
        priority: 1
      },
      {
        pattern: 'gemini-pro',
        targetModel: 'Qwen3-Coder-480B',
        provider: 'modelscope',
        priority: 1
      }
    ];

    this.modelMappings.set('generic', genericModelMappings);
  }

  /**
   * 添加模型映射规则
   */
  addModelMapping(category: string, rule: ModelMappingRule): void {
    if (!this.modelMappings.has(category)) {
      this.modelMappings.set(category, []);
    }
    this.modelMappings.get(category)!.push(rule);

    // 按优先级排序
    this.modelMappings.get(category)!.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 添加参数映射规则
   */
  addParameterMapping(category: string, rule: ParameterMappingRule): void {
    if (!this.parameterMappings.has(category)) {
      this.parameterMappings.set(category, []);
    }
    this.parameterMappings.get(category)!.push(rule);
  }

  /**
   * 获取模型映射规则
   */
  getModelMappings(category: string = 'generic'): ModelMappingRule[] {
    return this.modelMappings.get(category) || [];
  }

  /**
   * 获取参数映射规则
   */
  getParameterMappings(category: string = 'default'): ParameterMappingRule[] {
    const specificMappings = this.parameterMappings.get(category) || [];
    return [...specificMappings, ...this.defaultMappings];
  }

  /**
   * 查找匹配的模型映射规则
   */
  findModelMapping(modelName: string, category: string = 'generic'): ModelMappingRule | null {
    const rules = this.getModelMappings(category);

    for (const rule of rules) {
      if (this.isModelMatch(modelName, rule.pattern)) {
        return rule;
      }
    }

    return null;
  }

  /**
   * 检查模型是否匹配规则
   */
  private isModelMatch(modelName: string, pattern: string): boolean {
    // 支持通配符匹配
    if (pattern.includes('*')) {
      const regexPattern = pattern.replace(/\*/g, '.*');
      return new RegExp(`^${regexPattern}$`).test(modelName);
    }

    // 精确匹配
    return modelName.toLowerCase() === pattern.toLowerCase();
  }

  /**
   * 模型转换器
   */
  private transformModel(value: any, context: ConversionContext): string {
    const { pipelineConfig, routingInfo } = context;

    // 如果配置中有指定的实际模型ID，优先使用
    if (pipelineConfig.model?.actualModelId) {
      return pipelineConfig.model.actualModelId;
    }

    // 尝试从模型映射规则查找
    const mappingRule = this.findModelMapping(value);
    if (mappingRule) {
      return mappingRule.targetModel;
    }

    // 如果没有找到映射规则，检查路由信息中的模型ID
    if (routingInfo.modelId) {
      return routingInfo.modelId;
    }

    // 默认返回原始值
    return String(value);
  }

  /**
   * 模型验证器
   */
  private validateModel(value: any, context: ConversionContext): ValidationResult {
    if (!value || typeof value !== 'string') {
      return {
        isValid: false,
        errors: ['Model field is required and must be a string']
      };
    }

    const mappingRule = this.findModelMapping(value);
    if (!mappingRule) {
      return {
        isValid: true,
        warnings: [`No mapping rule found for model: ${value}`]
      };
    }

    return { isValid: true };
  }

  /**
   * MaxTokens转换器
   */
  private transformMaxTokens(value: any, context: ConversionContext): number {
    const { pipelineConfig } = context;

    // 如果配置中有maxTokens，优先使用配置值
    if (pipelineConfig.model?.maxTokens) {
      return pipelineConfig.model.maxTokens;
    }

    // 验证输入值
    if (typeof value === 'number' && value > 0) {
      return Math.min(value, pipelineConfig.model?.maxTokens || this.config.defaultMaxTokens);
    }

    // 默认值
    return this.config.defaultMaxTokens;
  }

  /**
   * MaxTokens验证器
   */
  private validateMaxTokens(value: any, context: ConversionContext): ValidationResult {
    const numValue = Number(value);

    if (isNaN(numValue) || numValue <= 0) {
      return {
        isValid: false,
        errors: ['max_tokens must be a positive number']
      };
    }

    const { pipelineConfig } = context;
    const maxAllowed = pipelineConfig.model?.maxTokens || this.config.defaultMaxTokens;

    if (numValue > maxAllowed) {
      return {
        isValid: true,
        warnings: [`max_tokens ${numValue} exceeds maximum allowed ${maxAllowed}, will be capped`]
      };
    }

    return { isValid: true };
  }

  /**
   * Temperature转换器
   */
  private transformTemperature(value: any, context: ConversionContext): number {
    const numValue = Number(value);

    if (isNaN(numValue) || numValue < 0 || numValue > 2) {
      return 0.7; // 默认温度
    }

    return numValue;
  }

  /**
   * Temperature验证器
   */
  private validateTemperature(value: any, context: ConversionContext): ValidationResult {
    const numValue = Number(value);

    if (isNaN(numValue)) {
      return {
        isValid: false,
        errors: ['temperature must be a number']
      };
    }

    if (numValue < 0 || numValue > 2) {
      return {
        isValid: false,
        errors: ['temperature must be between 0 and 2']
      };
    }

    return { isValid: true };
  }

  /**
   * TopP转换器
   */
  private transformTopP(value: any, context: ConversionContext): number {
    const numValue = Number(value);

    if (isNaN(numValue) || numValue <= 0 || numValue > 1) {
      return 1.0; // 默认top_p
    }

    return numValue;
  }

  /**
   * TopP验证器
   */
  private validateTopP(value: any, context: ConversionContext): ValidationResult {
    const numValue = Number(value);

    if (isNaN(numValue)) {
      return {
        isValid: false,
        errors: ['top_p must be a number']
      };
    }

    if (numValue <= 0 || numValue > 1) {
      return {
        isValid: false,
        errors: ['top_p must be between 0 and 1']
      };
    }

    return { isValid: true };
  }

  /**
   * Stream转换器
   */
  private transformStream(value: any, context: ConversionContext): boolean {
    return Boolean(value);
  }

  /**
   * Stop转换器
   */
  private transformStop(value: any, context: ConversionContext): string[] | undefined {
    if (Array.isArray(value)) {
      return value.map(item => String(item));
    }

    if (typeof value === 'string') {
      return [value];
    }

    return undefined;
  }

  /**
   * 验证映射条件
   */
  validateConditions(conditions: MappingCondition[], context: ConversionContext): boolean {
    for (const condition of conditions) {
      const fieldValue = this.getFieldValue(condition.field, context);

      if (!this.evaluateCondition(fieldValue, condition.operator, condition.value)) {
        return false;
      }
    }

    return true;
  }

  /**
   * 获取字段值
   */
  private getFieldValue(field: string, context: ConversionContext): any {
    const { originalRequest, pipelineConfig, routingInfo } = context;

    // 支持嵌套字段访问
    const fieldPath = field.split('.');
    let value: any = originalRequest;

    for (const segment of fieldPath) {
      if (value && typeof value === 'object') {
        value = value[segment];
      } else {
        return undefined;
      }
    }

    return value;
  }

  /**
   * 评估条件
   */
  private evaluateCondition(value: any, operator: string, expected: any): boolean {
    switch (operator) {
      case 'eq':
        return value === expected;
      case 'gt':
        return Number(value) > Number(expected);
      case 'lt':
        return Number(value) < Number(expected);
      case 'gte':
        return Number(value) >= Number(expected);
      case 'lte':
        return Number(value) <= Number(expected);
      case 'contains':
        return String(value).includes(String(expected));
      default:
        return false;
    }
  }

  /**
   * 获取所有规则的统计信息
   */
  getRuleStatistics(): {
    modelMappings: number;
    parameterMappings: number;
    categories: string[];
  } {
    return {
      modelMappings: Array.from(this.modelMappings.values())
        .reduce((total, rules) => total + rules.length, 0),
      parameterMappings: Array.from(this.parameterMappings.values())
        .reduce((total, rules) => total + rules.length, 0),
      categories: Array.from(this.modelMappings.keys())
    };
  }
}
