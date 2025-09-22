/**
 * Transformation Engine Implementation
 *
 * Provides JSON-based data transformation capabilities with support for
 * various transformation types including mapping, renaming, extraction,
 * combination, and conditional transformations.
 */

import type {
  TransformationRule,
  TransformationContext,
  TransformationResult,
  TransformationEngineConfig,
  TransformationValidationRule,
  ValidationResult
} from '../types/transformation-types.js';
import type { TransformationLog } from '../interfaces/pipeline-interfaces.js';

/**
 * JSON Path utility functions
 */
class JSONPathUtils {
  /**
   * Get value from object using JSON path
   */
  static getValue(obj: any, path: string): any {
    const normalizedPath = path.replace(/\[('([^']*)'|"([^"]*)")\]/g, '.$1$2');
    const keys = normalizedPath.split('.');

    let current = obj;
    for (const key of keys) {
      if (current === null || current === undefined) {
        return undefined;
      }
      current = current[key];
    }

    return current;
  }

  /**
   * Set value in object using JSON path
   */
  static setValue(obj: any, path: string, value: any): void {
    const normalizedPath = path.replace(/\[('([^']*)'|"([^"]*)")\]/g, '.$1$2');
    const keys = normalizedPath.split('.');

    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!(key in current) || typeof current[key] !== 'object') {
        current[key] = {};
      }
      current = current[key];
    }

    const lastKey = keys[keys.length - 1];
    current[lastKey] = value;
  }

  /**
   * Delete value from object using JSON path
   */
  static deleteValue(obj: any, path: string): boolean {
    const normalizedPath = path.replace(/\[('([^']*)'|"([^"]*)")\]/g, '.$1$2');
    const keys = normalizedPath.split('.');

    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!(key in current) || typeof current[key] !== 'object') {
        return false;
      }
      current = current[key];
    }

    const lastKey = keys[keys.length - 1];
    if (lastKey in current) {
      delete current[lastKey];
      return true;
    }

    return false;
  }
}

/**
 * Transformation Engine Implementation
 */
export class TransformationEngine {
  private config: TransformationEngineConfig;
  private cache: Map<string, { result: TransformationResult; expires: number }> = new Map();
  private customFunctions: Map<string, Function> = new Map();
  private statistics = {
    totalTransformations: 0,
    successfulTransformations: 0,
    failedTransformations: 0,
    totalTime: 0,
    cacheHits: 0,
    cacheMisses: 0
  };

  constructor(config: TransformationEngineConfig = {}) {
    this.config = {
      maxDepth: config.maxDepth || 10,
      maxTimeMs: config.maxTimeMs || 5000,
      enableCache: config.enableCache ?? true,
      cacheSize: config.cacheSize || 1000,
      customFunctions: config.customFunctions || {},
      validationRules: config.validationRules || []
    };

    // Register custom functions
    if (this.config.customFunctions) {
      Object.entries(this.config.customFunctions).forEach(([name, fn]) => {
        this.customFunctions.set(name, fn);
      });
    }
  }

  /**
   * Initialize the transformation engine
   */
  async initialize(config?: TransformationEngineConfig): Promise<void> {
    if (config) {
      this.config = { ...this.config, ...config };
    }

    // Initialize cache
    if (this.config.enableCache) {
      this.cache = new Map();
    }

    // Clean up expired cache entries
    this.cleanupCache();
  }

  /**
   * Apply transformation rules to data
   */
  async transform(
    data: any,
    rules: TransformationRule[],
    context?: Partial<TransformationContext>
  ): Promise<TransformationResult> {
    const startTime = Date.now();
    const transformationId = this.generateTransformationId(data, rules);

    // Check cache first
    if (this.config.enableCache) {
      const cached = this.cache.get(transformationId);
      if (cached && cached.expires > Date.now()) {
        this.statistics.cacheHits++;
        return cached.result;
      }
      this.statistics.cacheMisses++;
    }

    try {
      // Create transformation context
      const fullContext: TransformationContext = {
        pipelineContext: {
          pipelineId: 'unknown',
          requestId: 'unknown',
          timestamp: Date.now(),
          ...context?.pipelineContext
        },
        metadata: {
          ruleId: 'unknown',
          ruleType: 'batch',
          attempt: 1,
          ...context?.metadata
        },
        state: context?.state || {},
        logger: context?.logger || (() => {})
      };

      // Validate input data
      const validations = await this.validateData(data);

      // Apply transformations
      const transformedData = { ...data };
      const logs: TransformationLog[] = [];
      let currentDepth = 0;

      for (const rule of rules) {
        if (currentDepth >= this.config.maxDepth!) {
          throw new Error(`Maximum transformation depth exceeded: ${this.config.maxDepth}`);
        }

        const result = await this.applyRule(transformedData, rule, fullContext);
        if (result.transformed) {
          Object.assign(transformedData, result.data);
          logs.push(result.log);
        }

        currentDepth++;
      }

      // Validate output data
      const outputValidations = await this.validateData(transformedData);

      // Create result
      const result: TransformationResult = {
        data: transformedData,
        logs: logs as any,
        validations: [...validations, ...outputValidations],
        metrics: {
          totalTransformations: rules.length,
          totalTime: Date.now() - startTime,
          averageTime: (Date.now() - startTime) / rules.length,
          cacheHits: this.statistics.cacheHits,
          cacheMisses: this.statistics.cacheMisses
        }
      };

      // Cache result
      if (this.config.enableCache) {
        this.cache.set(transformationId, {
          result,
          expires: Date.now() + 300000 // 5 minutes
        });

        // Limit cache size
        if (this.config.cacheSize && this.cache.size > this.config.cacheSize) {
          const oldestKey = this.cache.keys().next().value;
          if (oldestKey) {
            this.cache.delete(oldestKey);
          }
        }
      }

      // Update statistics
      this.updateStatistics(true, Date.now() - startTime);

      return result;

    } catch (error) {
      this.updateStatistics(false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Validate data against configured rules
   */
  async validateData(data: any): Promise<ValidationResult[]> {
    const results: ValidationResult[] = [];

    for (const rule of this.config.validationRules || []) {
      try {
        const result = await this.applyValidationRule(data, rule);
        results.push(result);
      } catch (error) {
        results.push({
          ruleId: rule.id,
          isValid: false,
          errorMessage: `Validation error: ${error instanceof Error ? error.message : String(error)}`,
          context: { rule, error: error instanceof Error ? error.message : String(error) }
        });
      }
    }

    return results;
  }

  /**
   * Clean up engine resources
   */
  async cleanup(): Promise<void> {
    this.cache.clear();
    this.customFunctions.clear();
    this.resetStatistics();
  }

  /**
   * Get transformation statistics
   */
  getStatistics() {
    return {
      ...this.statistics,
      averageTime: this.statistics.totalTransformations > 0
        ? this.statistics.totalTime / this.statistics.totalTransformations
        : 0,
      successRate: this.statistics.totalTransformations > 0
        ? this.statistics.successfulTransformations / this.statistics.totalTransformations
        : 0
    };
  }

  /**
   * Reset statistics
   */
  resetStatistics(): void {
    this.statistics = {
      totalTransformations: 0,
      successfulTransformations: 0,
      failedTransformations: 0,
      totalTime: 0,
      cacheHits: 0,
      cacheMisses: 0
    };
  }

  /**
   * Get engine status
   */
  getStatus() {
    return {
      isInitialized: true,
      cacheSize: this.cache.size,
      maxCacheSize: this.config.cacheSize,
      customFunctionsCount: this.customFunctions.size,
      statistics: this.getStatistics()
    };
  }

  /**
   * Apply a single transformation rule
   */
  private async applyRule(
    data: any,
    rule: TransformationRule,
    context: TransformationContext
  ): Promise<{ transformed: boolean; data: any; log: TransformationLog }> {
    const startTime = Date.now();

    try {
      let result = data;

      switch (rule.transform) {
        case 'mapping':
          result = await this.applyMappingRule(data, rule, context);
          break;
        case 'rename':
          result = await this.applyRenameRule(data, rule, context);
          break;
        case 'extract':
          result = await this.applyExtractRule(data, rule, context);
          break;
        case 'combine':
          result = await this.applyCombineRule(data, rule, context);
          break;
        case 'conditional':
          result = await this.applyConditionalRule(data, rule, context);
          break;
        default:
          throw new Error(`Unknown transformation type: ${rule.transform}`);
      }

      return {
        transformed: true,
        data: result,
        log: {
          ruleId: rule.id,
          sourcePath: rule.sourcePath || '',
          targetPath: rule.targetPath || '',
          originalValue: JSONPathUtils.getValue(data, rule.sourcePath || ''),
          transformedValue: JSONPathUtils.getValue(result, rule.targetPath || ''),
          duration: Date.now() - startTime
        } as TransformationLog
      };

    } catch (error) {
      context.logger(`Transformation rule ${rule.id} failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
      throw error;
    }
  }

  /**
   * Apply mapping transformation rule
   */
  private async applyMappingRule(
    data: any,
    rule: TransformationRule,
    context: TransformationContext
  ): Promise<any> {
    const sourceValue = JSONPathUtils.getValue(data, rule.sourcePath || '');

    if (sourceValue === undefined && rule.defaultValue !== undefined && rule.targetPath) {
      JSONPathUtils.setValue(data, rule.targetPath, rule.defaultValue);
      return data;
    }

    if (rule.mapping && rule.mapping[sourceValue] !== undefined && rule.targetPath) {
      JSONPathUtils.setValue(data, rule.targetPath, rule.mapping[sourceValue]);
    } else if (rule.targetPath) {
      JSONPathUtils.setValue(data, rule.targetPath, sourceValue);
    }

    if (rule.removeSource && rule.sourcePath) {
      JSONPathUtils.deleteValue(data, rule.sourcePath);
    }

    return data;
  }

  /**
   * Apply rename transformation rule
   */
  private async applyRenameRule(
    data: any,
    rule: TransformationRule,
    context: TransformationContext
  ): Promise<any> {
    const sourceValue = JSONPathUtils.getValue(data, rule.sourcePath || '');

    if (sourceValue !== undefined && rule.targetPath) {
      JSONPathUtils.setValue(data, rule.targetPath, sourceValue);
      if (rule.removeSource && rule.sourcePath) {
        JSONPathUtils.deleteValue(data, rule.sourcePath);
      }
    }

    return data;
  }

  /**
   * Apply extract transformation rule
   */
  private async applyExtractRule(
    data: any,
    rule: TransformationRule,
    context: TransformationContext
  ): Promise<any> {
    const sourceValue = JSONPathUtils.getValue(data, rule.sourcePath || '');
    let extractedValue = sourceValue;

    const extractRule = rule as any;
    if (extractRule.extractor === 'regex' && extractRule.pattern && typeof sourceValue === 'string') {
      const regex = new RegExp(extractRule.pattern);
      const match = sourceValue.match(regex);
      extractedValue = match ? match[1] || match[0] : sourceValue;
    }

    JSONPathUtils.setValue(data, rule.targetPath || '', extractedValue);

    if (rule.removeSource) {
      JSONPathUtils.deleteValue(data, rule.sourcePath || '');
    }

    return data;
  }

  /**
   * Apply combine transformation rule
   */
  private async applyCombineRule(
    data: any,
    rule: TransformationRule,
    context: TransformationContext
  ): Promise<any> {
    const combineRule = rule as any;
    const sourcePaths = combineRule.sourcePaths || [rule.sourcePath];
    const values = sourcePaths.map((path: string) => JSONPathUtils.getValue(data, path));

    let combinedValue: any;

    switch (combineRule.combiner) {
      case 'concat':
        combinedValue = values.filter((v: any) => v !== undefined).join(combineRule.separator || '');
        break;
      case 'merge':
        combinedValue = Object.assign({}, ...values.filter((v: any) => v !== undefined && typeof v === 'object'));
        break;
      default:
        combinedValue = values[0]; // fallback to first value
    }

    JSONPathUtils.setValue(data, rule.targetPath || '', combinedValue);

    if (rule.removeSource) {
      sourcePaths.forEach((path: string) => {
        if (path) {
          JSONPathUtils.deleteValue(data, path);
        }
      });
    }

    return data;
  }

  /**
   * Apply conditional transformation rule
   */
  private async applyConditionalRule(
    data: any,
    rule: TransformationRule,
    context: TransformationContext
  ): Promise<any> {
    const condition = rule.condition!;
    const fieldValue = JSONPathUtils.getValue(data, condition.field);

    let conditionMet = false;

    switch (condition.operator) {
      case 'equals':
        conditionMet = fieldValue === condition.value;
        break;
      case 'contains':
        conditionMet = String(fieldValue).includes(String(condition.value));
        break;
      case 'exists':
        conditionMet = fieldValue !== undefined;
        break;
      case 'gt':
        conditionMet = Number(fieldValue) > Number(condition.value);
        break;
      case 'lt':
        conditionMet = Number(fieldValue) < Number(condition.value);
        break;
      case 'regex':
        conditionMet = new RegExp(condition.value).test(String(fieldValue));
        break;
    }

    const targetRule = conditionMet ? (rule as any).thenRule : (rule as any).elseRule;

    if (targetRule) {
      return this.applyRule(data, targetRule, context);
    }

    return data;
  }

  /**
   * Apply validation rule
   */
  private async applyValidationRule(data: any, rule: TransformationValidationRule): Promise<ValidationResult> {
    const value = JSONPathUtils.getValue(data, rule.targetPath);

    switch (rule.type) {
      case 'required':
        return {
          ruleId: rule.id,
          isValid: value !== undefined && value !== null && value !== '',
          errorMessage: value === undefined || value === null || value === '' ? rule.errorMessage : undefined,
          context: { value, rule }
        };

      case 'type':
        const expectedType = rule.parameters.type;
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        return {
          ruleId: rule.id,
          isValid: actualType === expectedType,
          errorMessage: actualType !== expectedType ? rule.errorMessage : undefined,
          context: { value, expectedType, actualType, rule }
        };

      case 'format':
        const pattern = rule.parameters.pattern;
        const regex = new RegExp(pattern);
        const isValid = regex.test(String(value));
        return {
          ruleId: rule.id,
          isValid,
          errorMessage: !isValid ? rule.errorMessage : undefined,
          context: { value, pattern, rule }
        };

      default:
        return {
          ruleId: rule.id,
          isValid: true,
          context: { value, rule }
        };
    }
  }

  /**
   * Generate transformation ID for caching
   */
  private generateTransformationId(data: any, rules: TransformationRule[]): string {
    const dataHash = this.simpleHash(JSON.stringify(data));
    const rulesHash = this.simpleHash(JSON.stringify(rules));
    return `${dataHash}:${rulesHash}`;
  }

  /**
   * Simple hash function for caching
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Clean up expired cache entries
   */
  private cleanupCache(): void {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (value.expires <= now) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Update transformation statistics
   */
  private updateStatistics(success: boolean, time: number): void {
    this.statistics.totalTransformations++;
    this.statistics.totalTime += time;

    if (success) {
      this.statistics.successfulTransformations++;
    } else {
      this.statistics.failedTransformations++;
    }
  }
}

/**
 * Create transformation engine with default configuration
 */
export function createTransformationEngine(config?: TransformationEngineConfig): TransformationEngine {
  return new TransformationEngine(config);
}