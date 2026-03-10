/**
 * 配置驱动的规则加载器
 * 基于设计文档中的配置驱动验证规则系统
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { load } from 'js-yaml';

export interface ValidationRule {
  name: string;
  description: string;
  enabled: boolean;
  severity: 'error' | 'warning' | 'info';
  ruleType: 'field-check' | 'custom' | 'sequence-check' | 'content-validation';
  implementation?: string;
  parameters?: Record<string, any>;
  conditions?: {
    field?: string;
    operator: 'equals' | 'contains' | 'exists' | 'not-exists' | 'greater-than' | 'less-than';
    value?: any;
  }[];
}

export interface RuleSet {
  name: string;
  version: string;
  description: string;
  rules: ValidationRule[];
}

export interface TestConfig {
  receivers: {
    [name: string]: {
      type: 'lmstudio' | 'stub' | 'custom';
      endpoint?: string;
      apiKey?: string;
      timeoutMs?: number;
      debugMode?: boolean;
    };
  };
  validation: {
    ruleSets: string[];
    strictMode: boolean;
    failOnWarnings: boolean;
  };
  samples: {
    directories: string[];
    patterns: string[];
    excludePatterns?: string[];
  };
  execution: {
    parallel: boolean;
    maxConcurrency: number;
    retryCount: number;
    outputFormat: 'json' | 'junit' | 'console';
    reportPath?: string;
  };
}

export interface LoadedRule {
  rule: ValidationRule;
  executor: (data: any, context?: any) => { valid: boolean; errors: string[]; warnings: string[] };
  source: string;
}

/**
 * 配置驱动的规则加载器
 */
export class ConfigDrivenRuleLoader {
  private ruleSets: Map<string, RuleSet> = new Map();
  private loadedRules: Map<string, LoadedRule> = new Map();
  private configPath: string;
  private config: TestConfig | null = null;

  constructor(configPath: string) {
    this.configPath = configPath;
  }

  /**
   * 加载测试配置
   */
  async loadConfig(): Promise<TestConfig> {
    if (!existsSync(this.configPath)) {
      throw new Error(`Config file not found: ${this.configPath}`);
    }

    const configContent = readFileSync(this.configPath, 'utf8');
    const config = load(configContent) as TestConfig;

    // 验证配置结构
    this.validateConfig(config);

    this.config = config;
    return config;
  }

  /**
   * 加载所有规则集
   */
  async loadRuleSets(): Promise<void> {
    if (!this.config) {
      throw new Error('Config not loaded. Call loadConfig() first.');
    }

    const configDir = dirname(this.configPath);

    for (const ruleSetPath of this.config.validation.ruleSets) {
      const fullPath = resolve(configDir, ruleSetPath);
      await this.loadRuleSet(fullPath);
    }
  }

  /**
   * 加载单个规则集
   */
  async loadRuleSet(ruleSetPath: string): Promise<RuleSet> {
    if (!existsSync(ruleSetPath)) {
      throw new Error(`Rule set file not found: ${ruleSetPath}`);
    }

    const ruleSetContent = readFileSync(ruleSetPath, 'utf8');
    const ruleSet = load(ruleSetContent) as RuleSet;

    // 验证规则集结构
    this.validateRuleSet(ruleSet);

    this.ruleSets.set(ruleSetPath, ruleSet);

    // 编译规则
    for (const rule of ruleSet.rules) {
      if (rule.enabled) {
        await this.compileRule(rule, ruleSetPath);
      }
    }

    return ruleSet;
  }

  /**
   * 获取所有已加载的规则
   */
  getLoadedRules(): LoadedRule[] {
    return Array.from(this.loadedRules.values());
  }

  /**
   * 获取特定类型的规则
   */
  getRulesByType(ruleType: ValidationRule['ruleType']): LoadedRule[] {
    return Array.from(this.loadedRules.values()).filter(
      loadedRule => loadedRule.rule.ruleType === ruleType
    );
  }

  /**
   * 获取已启用的规则
   */
  getEnabledRules(): LoadedRule[] {
    return Array.from(this.loadedRules.values()).filter(
      loadedRule => loadedRule.rule.enabled
    );
  }

  /**
   * 执行规则
   */
  executeRules(data: any, context?: any): { valid: boolean; errors: string[]; warnings: string[]; executed: string[] } {
    const enabledRules = this.getEnabledRules();
    const result = {
      valid: true,
      errors: [] as string[],
      warnings: [] as string[],
      executed: [] as string[]
    };

    for (const loadedRule of enabledRules) {
      try {
        // 检查规则条件
        if (this.shouldExecuteRule(loadedRule.rule, data)) {
          const ruleResult = loadedRule.executor(data, context);

          result.errors.push(...ruleResult.errors);
          result.warnings.push(...ruleResult.warnings);
          result.executed.push(loadedRule.rule.name);

          if (ruleResult.errors.length > 0) {
            result.valid = false;
          }
        }
      } catch (error) {
        const message = getErrorMessage(error);
        result.errors.push(`Rule execution failed for ${loadedRule.rule.name}: ${message}`);
        result.valid = false;
      }
    }

    return result;
  }

  /**
   * 获取配置
   */
  getConfig(): TestConfig | null {
    return this.config;
  }

  /**
   * 重新加载规则
   */
  async reloadRules(): Promise<void> {
    this.ruleSets.clear();
    this.loadedRules.clear();
    await this.loadRuleSets();
  }

  private validateConfig(config: any): void {
    if (!config.receivers || typeof config.receivers !== 'object') {
      throw new Error('Invalid config: receivers section is required');
    }

    if (!config.validation || !Array.isArray(config.validation.ruleSets)) {
      throw new Error('Invalid config: validation.ruleSets array is required');
    }

    if (!config.samples || !Array.isArray(config.samples.directories)) {
      throw new Error('Invalid config: samples.directories array is required');
    }
  }

  private validateRuleSet(ruleSet: any): void {
    if (!ruleSet.name || !ruleSet.version || !Array.isArray(ruleSet.rules)) {
      throw new Error('Invalid rule set: name, version, and rules array are required');
    }

    for (const rule of ruleSet.rules) {
      this.validateRule(rule);
    }
  }

  private validateRule(rule: any): void {
    if (!rule.name || !rule.description || typeof rule.enabled !== 'boolean') {
      throw new Error('Invalid rule: name, description, and enabled are required');
    }

    if (!['error', 'warning', 'info'].includes(rule.severity)) {
      throw new Error('Invalid rule: severity must be error, warning, or info');
    }

    if (!['field-check', 'custom', 'sequence-check', 'content-validation'].includes(rule.ruleType)) {
      throw new Error('Invalid rule: ruleType must be field-check, custom, sequence-check, or content-validation');
    }

    if (rule.ruleType === 'custom' && !rule.implementation) {
      throw new Error('Invalid custom rule: implementation is required');
    }
  }

  private async compileRule(rule: ValidationRule, source: string): Promise<void> {
    let executor: (data: any, context?: any) => { valid: boolean; errors: string[]; warnings: string[] };

    switch (rule.ruleType) {
      case 'field-check':
        executor = this.compileFieldCheckRule(rule);
        break;
      case 'sequence-check':
        executor = this.compileSequenceCheckRule(rule);
        break;
      case 'content-validation':
        executor = this.compileContentValidationRule(rule);
        break;
      case 'custom':
        executor = await this.compileCustomRule(rule);
        break;
      default:
        throw new Error(`Unknown rule type: ${rule.ruleType}`);
    }

    this.loadedRules.set(rule.name, {
      rule,
      executor,
      source
    });
  }

  private compileFieldCheckRule(rule: ValidationRule): (data: any) => { valid: boolean; errors: string[]; warnings: string[] } {
    const parameters = rule.parameters || {};
    const field = parameters.field;
    const ruleToApply = parameters.rule;

    return (data: any) => {
      const result = { valid: true, errors: [] as string[], warnings: [] as string[] };

      if (!field) {
        result.errors.push('Field check rule missing field parameter');
        result.valid = false;
        return result;
      }

      const fieldValue = this.getNestedValue(data, field);

      switch (ruleToApply) {
        case 'required':
          if (fieldValue === undefined || fieldValue === null || fieldValue === '') {
            result.errors.push(`Required field '${field}' is missing or empty`);
            result.valid = false;
          }
          break;

        case 'non-empty':
          if (fieldValue !== undefined && fieldValue !== null &&
              (typeof fieldValue === 'string' && fieldValue.trim() === '' ||
               (Array.isArray(fieldValue) && fieldValue.length === 0) ||
               (typeof fieldValue === 'object' && Object.keys(fieldValue).length === 0))) {
            result.errors.push(`Field '${field}' must not be empty`);
            result.valid = false;
          }
          break;

        case 'valid-email':
          if (fieldValue && !this.isValidEmail(fieldValue)) {
            result.errors.push(`Field '${field}' must be a valid email address`);
            result.valid = false;
          }
          break;

        case 'url':
          if (fieldValue && !this.isValidUrl(fieldValue)) {
            result.errors.push(`Field '${field}' must be a valid URL`);
            result.valid = false;
          }
          break;

        default:
          result.warnings.push(`Unknown field check rule: ${ruleToApply}`);
      }

      return result;
    };
  }

  private compileSequenceCheckRule(rule: ValidationRule): (data: any) => { valid: boolean; errors: string[]; warnings: string[] } {
    const parameters = rule.parameters || {};
    const expectedSequence = parameters.expectedSequence || [];

    return (data: any) => {
      const result = { valid: true, errors: [] as string[], warnings: [] as string[] };

      if (!Array.isArray(data)) {
        result.errors.push('Sequence check rule requires array data');
        result.valid = false;
        return result;
      }

      const actualSequence = data.map(item => item.type || item.event);

      // 检查核心事件序列
      let expectedIndex = 0;
      for (const event of actualSequence) {
        if (expectedIndex < expectedSequence.length && event === expectedSequence[expectedIndex]) {
          expectedIndex++;
        }
      }

      if (expectedIndex < expectedSequence.length) {
        result.warnings.push(`Event sequence incomplete. Expected: ${expectedSequence.join(' -> ')}, Actual: ${actualSequence.join(' -> ')}`);
      }

      return result;
    };
  }

  private compileContentValidationRule(rule: ValidationRule): (data: any) => { valid: boolean; errors: string[]; warnings: string[] } {
    const parameters = rule.parameters || {};

    return (data: any) => {
      const result = { valid: true, errors: [] as string[], warnings: [] as string[] };

      if (parameters.minLength && typeof data === 'string') {
        if (data.length < parameters.minLength) {
          result.errors.push(`Content length ${data.length} is less than minimum ${parameters.minLength}`);
          result.valid = false;
        }
      }

      if (parameters.maxLength && typeof data === 'string') {
        if (data.length > parameters.maxLength) {
          result.errors.push(`Content length ${data.length} exceeds maximum ${parameters.maxLength}`);
          result.valid = false;
        }
      }

      if (parameters.pattern && typeof data === 'string') {
        const regex = new RegExp(parameters.pattern);
        if (!regex.test(data)) {
          result.errors.push(`Content does not match required pattern: ${parameters.pattern}`);
          result.valid = false;
        }
      }

      return result;
    };
  }

  private async compileCustomRule(rule: ValidationRule): Promise<(data: any) => { valid: boolean; errors: string[]; warnings: string[] }> {
    const implementation = rule.implementation!;

    // 内置的自定义规则实现
    switch (implementation) {
      case 'validateToolCalls':
        return this.compileValidateToolCallsRule(rule);

      case 'validateStreamingCapability':
        return this.compileValidateStreamingCapabilityRule(rule);

      case 'validateToolDefinitions':
        return this.compileValidateToolDefinitionsRule(rule);

      case 'validateToolCallStructure':
        return this.compileValidateToolCallStructureRule(rule);

      default:
        throw new Error(`Unknown custom rule implementation: ${implementation}`);
    }
  }

  private compileValidateToolCallsRule(rule: ValidationRule): (data: any) => { valid: boolean; errors: string[]; warnings: string[] } {
    const parameters = rule.parameters || {};

    return (data: any) => {
      const result = { valid: true, errors: [] as string[], warnings: [] as string[] };

      const toolCalls = this.extractToolCalls(data);
      if (parameters.expectedTools && Array.isArray(parameters.expectedTools)) {
        const actualTools = toolCalls.map(tc => tc.function?.name || tc.name);
        const missing = parameters.expectedTools.filter((tool: string) => !actualTools.includes(tool));

        if (missing.length > 0) {
          result.errors.push(`Missing expected tools: ${missing.join(', ')}`);
          result.valid = false;
        }
      }

      if (parameters.validateArguments) {
        toolCalls.forEach((tc: any, index: number) => {
          const args = tc.function?.arguments || tc.arguments;
          try {
            JSON.parse(args);
          } catch (error) {
            const message = getErrorMessage(error);
            result.errors.push(`Invalid JSON in tool call ${index} arguments: ${message}`);
            result.valid = false;
          }
        });
      }

      return result;
    };
  }

  private compileValidateStreamingCapabilityRule(rule: ValidationRule): (data: any) => { valid: boolean; errors: string[]; warnings: string[] } {
    const parameters = rule.parameters || {};

    return (data: any) => {
      const result = { valid: true, errors: [] as string[], warnings: [] as string[] };

      if (parameters.expectedEvents && Array.isArray(parameters.expectedEvents)) {
        const actualEvents = Array.isArray(data) ? data.map(item => item.type || item.event) : [];
        const hasExpectedEvents = parameters.expectedEvents.every((event: string) => actualEvents.includes(event));

        if (!hasExpectedEvents) {
          result.warnings.push(`Missing expected streaming events: ${parameters.expectedEvents.join(', ')}`);
        }
      }

      return result;
    };
  }

  private compileValidateToolDefinitionsRule(rule: ValidationRule): (data: any) => { valid: boolean; errors: string[]; warnings: string[] } {
    const parameters = rule.parameters || {};

    return (data: any) => {
      const result = { valid: true, errors: [] as string[], warnings: [] as string[] };

      const tools = data.tools || [];
      if (!Array.isArray(tools)) {
        result.errors.push('Tools must be an array');
        result.valid = false;
        return result;
      }

      if (parameters.expectedTools && Array.isArray(parameters.expectedTools)) {
        const actualTools = tools.map((tool: any) => tool.name);
        const missing = parameters.expectedTools.filter((tool: string) => !actualTools.includes(tool));

        if (missing.length > 0) {
          result.errors.push(`Missing expected tool definitions: ${missing.join(', ')}`);
          result.valid = false;
        }
      }

      if (parameters.validateParameters) {
        tools.forEach((tool: any, index: number) => {
          if (tool.parameters && typeof tool.parameters !== 'object') {
            result.errors.push(`Tool ${index} parameters must be an object`);
            result.valid = false;
          }
        });
      }

      return result;
    };
  }

  private compileValidateToolCallStructureRule(rule: ValidationRule): (data: any) => { valid: boolean; errors: string[]; warnings: string[] } {
    const parameters = rule.parameters || {};
    const requiredFields = parameters.requiredFields || ['id', 'type'];
    const functionRequiredFields = parameters.functionRequiredFields || ['name', 'arguments'];

    return (data: any) => {
      const result = { valid: true, errors: [] as string[], warnings: [] as string[] };

      const toolCalls = this.extractToolCalls(data);

      toolCalls.forEach((tc: any, index: number) => {
        requiredFields.forEach((field: string) => {
          if (!tc[field]) {
            result.errors.push(`Tool call ${index} missing required field: ${field}`);
            result.valid = false;
          }
        });

        if (tc.function) {
          functionRequiredFields.forEach((field: string) => {
            if (!tc.function[field]) {
              result.errors.push(`Tool call ${index} function missing required field: ${field}`);
              result.valid = false;
            }
          });
        }
      });

      return result;
    };
  }

  private shouldExecuteRule(rule: ValidationRule, data: any): boolean {
    if (!rule.conditions || rule.conditions.length === 0) {
      return true;
    }

    return rule.conditions.every(condition => {
      if (!condition.field) {
        return false;
      }

      const fieldValue = this.getNestedValue(data, condition.field);

      switch (condition.operator) {
        case 'exists':
          return fieldValue !== undefined && fieldValue !== null;
        case 'not-exists':
          return fieldValue === undefined || fieldValue === null;
        case 'equals':
          return fieldValue === condition.value;
        case 'contains':
          return typeof fieldValue === 'string' && fieldValue.includes(condition.value);
        case 'greater-than':
          return typeof fieldValue === 'number' && fieldValue > condition.value;
        case 'less-than':
          return typeof fieldValue === 'number' && fieldValue < condition.value;
        default:
          return false;
      }
    });
  }

  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : undefined;
    }, obj);
  }

  private extractToolCalls(data: any): any[] {
    if (data.tool_calls) {
      return data.tool_calls;
    }

    if (data.output && Array.isArray(data.output)) {
      return data.output.filter((item: any) => item.type === 'function_call');
    }

    if (data.required_action && data.required_action.submit_tool_outputs) {
      return data.required_action.submit_tool_outputs.tool_calls;
    }

    return [];
  }

  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
