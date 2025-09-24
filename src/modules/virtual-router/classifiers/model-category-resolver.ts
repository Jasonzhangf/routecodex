/**
 * Model Category Resolver
 * 模型类别解析器 - 基于配置文件解析模型类别
 */

export interface ModelCategoryConfig {
  // 模型类别定义
  categories: {
    [category: string]: ModelCategoryDefinition;
  };

  // 模型映射规则
  modelMappings: {
    [modelPattern: string]: {
      category: string;
      priority: number;
      conditions?: ModelCondition[];
    };
  };

  // 分类规则
  classificationRules: ClassificationRule[];

  // 默认配置
  defaults: {
    defaultCategory: string;
    fallbackCategory: string;
    confidenceThreshold: number;
  };
}

export interface ModelCategoryDefinition {
  name: string;
  description: string;
  routeTarget: string;
  capabilities: ModelCapability[];
  characteristics: ModelCharacteristic[];
  suitableFor: string[];
  notSuitableFor?: string[];
}

export interface ModelCapability {
  name: string;
  description: string;
  required?: boolean;
}

export interface ModelCharacteristic {
  name: string;
  value: any;
  description: string;
}

export interface ModelCondition {
  field: string;
  operator: 'equals' | 'contains' | 'starts_with' | 'ends_with' | 'regex' | 'greater_than' | 'less_than';
  value: any;
}

export interface ClassificationRule {
  id: string;
  name: string;
  priority: number;
  conditions: RuleCondition[];
  actions: RuleAction[];
  enabled: boolean;
}

export interface RuleCondition {
  field: string;
  operator: string;
  value: any;
}

export interface RuleAction {
  type: 'set_category' | 'set_priority' | 'modify_confidence';
  target: string;
  value?: any;
}

export interface ModelCategoryResult {
  category: string;
  definition: ModelCategoryDefinition;
  confidence: number;
  reasoning: string;
  matchedRules: string[];
  fallbackUsed: boolean;
}

export class ModelCategoryResolver {
  private config: ModelCategoryConfig;
  private defaultConfig: ModelCategoryConfig;

  constructor(config: ModelCategoryConfig) {
    this.config = config;
    this.defaultConfig = this.getDefaultConfig();
  }

  /**
   * 解析模型类别
   */
  resolveCategory(
    modelName: string,
    context?: {
      tokenCount?: number;
      hasTools?: boolean;
      toolTypes?: string[];
      thinking?: boolean;
    }
  ): ModelCategoryResult {
    // 1. 基于模型名称直接匹配
    const directMatch = this.findDirectMatch(modelName);
    if (directMatch) {
      return this.createResult(
        directMatch.category,
        directMatch.priority,
        `Direct match for model: ${modelName}`,
        ['direct_match'],
        false
      );
    }

    // 2. 基于模式匹配
    const patternMatch = this.findPatternMatch(modelName);
    if (patternMatch) {
      return this.createResult(
        patternMatch.category,
        patternMatch.priority,
        `Pattern match for model: ${modelName}`,
        ['pattern_match'],
        false
      );
    }

    // 3. 基于规则匹配
    const ruleMatch = this.applyRules(modelName, context);
    if (ruleMatch) {
      return this.createResult(
        ruleMatch.category,
        ruleMatch.priority,
        ruleMatch.reasoning,
        ruleMatch.matchedRules,
        false
      );
    }

    // 4. 基于上下文推断
    if (context) {
      const contextMatch = this.inferFromContext(context);
      if (contextMatch) {
        return this.createResult(
          contextMatch.category,
          contextMatch.priority,
          contextMatch.reasoning,
          ['context_inference'],
          false
        );
      }
    }

    // 5. 使用默认类别
    return this.createResult(
      this.config.defaults.defaultCategory,
      50,
      `No specific match found, using default category`,
      ['default_fallback'],
      true
    );
  }

  /**
   * 查找直接匹配
   */
  private findDirectMatch(modelName: string): { category: string; priority: number } | null {
    const mapping = this.config.modelMappings[modelName];
    if (mapping) {
      return {
        category: mapping.category,
        priority: mapping.priority
      };
    }
    return null;
  }

  /**
   * 查找模式匹配
   */
  private findPatternMatch(modelName: string): { category: string; priority: number } | null {
    const normalizedName = modelName.toLowerCase();

    for (const [pattern, mapping] of Object.entries(this.config.modelMappings)) {
      if (this.isPatternMatch(normalizedName, pattern.toLowerCase())) {
        return {
          category: mapping.category,
          priority: mapping.priority
        };
      }
    }

    return null;
  }

  /**
   * 检查模式匹配
   */
  private isPatternMatch(modelName: string, pattern: string): boolean {
    // 支持通配符 *
    if (pattern.includes('*')) {
      const regexPattern = pattern.replace(/\*/g, '.*');
      return new RegExp(`^${regexPattern}$`).test(modelName);
    }

    // 支持包含匹配
    if (pattern.startsWith('*') && pattern.endsWith('*')) {
      const searchTerm = pattern.slice(1, -1);
      return modelName.includes(searchTerm);
    }

    // 支持前缀匹配
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      return modelName.startsWith(prefix);
    }

    // 支持后缀匹配
    if (pattern.startsWith('*')) {
      const suffix = pattern.slice(1);
      return modelName.endsWith(suffix);
    }

    // 精确匹配
    return modelName === pattern;
  }

  /**
   * 应用分类规则
   */
  private applyRules(
    modelName: string,
    context?: any
  ): { category: string; priority: number; reasoning: string; matchedRules: string[] } | null {
    const matchedRules: string[] = [];
    let bestMatch: { category: string; priority: number } | null = null;

    // 按优先级排序规则
    const sortedRules = this.config.classificationRules
      .filter(rule => rule.enabled)
      .sort((a, b) => b.priority - a.priority);

    for (const rule of sortedRules) {
      if (this.evaluateRule(rule, modelName, context)) {
        matchedRules.push(rule.id);

        // 执行规则动作
        for (const action of rule.actions) {
          if (action.type === 'set_category') {
            bestMatch = {
              category: action.target,
              priority: rule.priority
            };
          }
        }
      }
    }

    if (bestMatch) {
      return {
        category: bestMatch.category,
        priority: bestMatch.priority,
        reasoning: `Matched rules: ${matchedRules.join(', ')}`,
        matchedRules
      };
    }

    return null;
  }

  /**
   * 评估规则条件
   */
  private evaluateRule(rule: ClassificationRule, modelName: string, context?: any): boolean {
    for (const condition of rule.conditions) {
      if (!this.evaluateCondition(condition, modelName, context)) {
        return false;
      }
    }
    return true;
  }

  /**
   * 评估单个条件
   */
  private evaluateCondition(condition: RuleCondition, modelName: string, context?: any): boolean {
    const fieldValue = this.getFieldValue(condition.field, modelName, context);

    switch (condition.operator) {
      case 'equals':
        return fieldValue === condition.value;
      case 'contains':
        return String(fieldValue).includes(String(condition.value));
      case 'starts_with':
        return String(fieldValue).startsWith(String(condition.value));
      case 'ends_with':
        return String(fieldValue).endsWith(String(condition.value));
      case 'regex':
        return new RegExp(condition.value).test(String(fieldValue));
      case 'greater_than':
        return Number(fieldValue) > Number(condition.value);
      case 'less_than':
        return Number(fieldValue) < Number(condition.value);
      default:
        return false;
    }
  }

  /**
   * 获取字段值
   */
  private getFieldValue(field: string, modelName: string, context?: any): any {
    switch (field) {
      case 'model':
        return modelName;
      case 'model_lower':
        return modelName.toLowerCase();
      case 'token_count':
        return context?.tokenCount || 0;
      case 'has_tools':
        return context?.hasTools || false;
      case 'has_thinking':
        return context?.thinking || false;
      case 'tool_types':
        return context?.toolTypes || [];
      default:
        return null;
    }
  }

  /**
   * 基于上下文推断
   */
  private inferFromContext(context: any): { category: string; priority: number; reasoning: string } | null {
    if (!context) {return null;}

    // 基于Token数量推断
    if (context.tokenCount > 50000) {
      return {
        category: 'longContext',
        priority: 80,
        reasoning: 'High token count suggests long context usage'
      };
    }

    // 基于工具使用推断
    if (context.hasTools) {
      if (context.toolTypes?.includes('webSearch')) {
        return {
          category: 'webSearch',
          priority: 75,
          reasoning: 'Web search tools detected'
        };
      }

      if (context.toolTypes?.includes('codeExecution')) {
        return {
          category: 'coding',
          priority: 75,
          reasoning: 'Code execution tools detected'
        };
      }

      return {
        category: 'default',
        priority: 60,
        reasoning: 'General tool usage detected'
      };
    }

    // 基于思考模式推断
    if (context.thinking) {
      return {
        category: 'thinking',
        priority: 85,
        reasoning: 'Thinking mode enabled'
      };
    }

    return null;
  }

  /**
   * 创建结果对象
   */
  private createResult(
    category: string,
    priority: number,
    reasoning: string,
    matchedRules: string[],
    fallbackUsed: boolean
  ): ModelCategoryResult {
    const definition = this.config.categories[category] || this.defaultConfig.categories[category];
    const confidence = Math.min(100, priority);

    return {
      category,
      definition: definition || this.getDefaultCategoryDefinition(category),
      confidence,
      reasoning,
      matchedRules,
      fallbackUsed
    };
  }

  /**
   * 获取默认类别定义
   */
  private getDefaultCategoryDefinition(category: string): ModelCategoryDefinition {
    return {
      name: category,
      description: `Auto-generated category for ${category}`,
      routeTarget: category,
      capabilities: [
        { name: 'text_generation', description: 'Basic text generation' }
      ],
      characteristics: [
        { name: 'category', value: category, description: 'Model category' }
      ],
      suitableFor: ['general_purpose']
    };
  }

  /**
   * 获取默认配置
   */
  private getDefaultConfig(): ModelCategoryConfig {
    return {
      categories: {
        default: {
          name: 'default',
          description: 'Default category for general purpose models',
          routeTarget: 'default',
          capabilities: [
            { name: 'text_generation', description: 'Basic text generation' },
            { name: 'conversation', description: 'General conversation' }
          ],
          characteristics: [
            { name: 'speed', value: 'balanced', description: 'Balanced performance' }
          ],
          suitableFor: ['general_conversation', 'simple_tasks']
        },
        longContext: {
          name: 'longContext',
          description: 'Models optimized for long context processing',
          routeTarget: 'longContext',
          capabilities: [
            { name: 'long_context', description: 'Extended context window' },
            { name: 'memory', description: 'Better memory retention' }
          ],
          characteristics: [
            { name: 'context_window', value: 'large', description: 'Large context window' }
          ],
          suitableFor: ['long_documents', 'complex_analysis', 'reasoning']
        },
        thinking: {
          name: 'thinking',
          description: 'Models optimized for complex reasoning',
          routeTarget: 'thinking',
          capabilities: [
            { name: 'reasoning', description: 'Advanced reasoning capabilities' },
            { name: 'problem_solving', description: 'Complex problem solving' }
          ],
          characteristics: [
            { name: 'reasoning_depth', value: 'high', description: 'Deep reasoning' }
          ],
          suitableFor: ['complex_reasoning', 'problem_solving', 'analysis']
        },
        coding: {
          name: 'coding',
          description: 'Models optimized for code generation and programming',
          routeTarget: 'coding',
          capabilities: [
            { name: 'code_generation', description: 'Code generation' },
            { name: 'debugging', description: 'Code debugging' }
          ],
          characteristics: [
            { name: 'code_expertise', value: 'high', description: 'High code expertise' }
          ],
          suitableFor: ['programming', 'code_generation', 'debugging']
        },
        webSearch: {
          name: 'webSearch',
          description: 'Models optimized for web search and information retrieval',
          routeTarget: 'webSearch',
          capabilities: [
            { name: 'web_search', description: 'Web search capabilities' },
            { name: 'information_retrieval', description: 'Information retrieval' }
          ],
          characteristics: [
            { name: 'search_capability', value: 'integrated', description: 'Integrated search' }
          ],
          suitableFor: ['research', 'information_gathering', 'current_events']
        }
      },
      modelMappings: {
        '*haiku*': { category: 'default', priority: 70 },
        '*opus*': { category: 'thinking', priority: 85 },
        '*sonnet*': { category: 'default', priority: 75 },
        '*gpt-4*': { category: 'thinking', priority: 80 },
        '*gpt-3.5*': { category: 'default', priority: 70 },
        '*claude-3*': { category: 'default', priority: 75 },
        '*claude-2*': { category: 'default', priority: 60 }
      },
      classificationRules: [
        {
          id: 'haiku_background',
          name: 'Haiku as Background Model',
          priority: 90,
          enabled: true,
          conditions: [
            { field: 'model_lower', operator: 'contains', value: 'haiku' }
          ],
          actions: [
            { type: 'set_category', target: 'default' }
          ]
        },
        {
          id: 'thinking_mode',
          name: 'Thinking Mode Detection',
          priority: 95,
          enabled: true,
          conditions: [
            { field: 'has_thinking', operator: 'equals', value: true }
          ],
          actions: [
            { type: 'set_category', target: 'thinking' }
          ]
        },
        {
          id: 'long_context_threshold',
          name: 'Long Context Threshold',
          priority: 85,
          enabled: true,
          conditions: [
            { field: 'token_count', operator: 'greater_than', value: 50000 }
          ],
          actions: [
            { type: 'set_category', target: 'longContext' }
          ]
        }
      ],
      defaults: {
        defaultCategory: 'default',
        fallbackCategory: 'default',
        confidenceThreshold: 60
      }
    };
  }

  /**
   * 获取配置建议
   */
  getConfigurationSuggestions(): {
    missingCategories: string[];
    suggestedMappings: Array<{ pattern: string; category: string; reasoning: string }>;
    suggestedRules: Array<{
      id: string;
      name: string;
      conditions: Array<{ field: string; operator: string; value: any }>;
      action: { type: string; target: string };
    }>;
  } {
    const suggestions = {
      missingCategories: [],
      suggestedMappings: [],
      suggestedRules: []
    } as any;

    // 分析当前配置，提供建议
    return suggestions;
  }
}