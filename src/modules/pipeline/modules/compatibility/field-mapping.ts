/**
 * Field Mapping Compatibility Implementation
 *
 * Provides JSON-based field mapping and transformation capabilities.
 * Supports various transformation types including mapping, renaming, extraction,
 * combination, and conditional transformations.
 */

import type { CompatibilityModule, ModuleConfig, ModuleDependencies, TransformationRule } from '../../interfaces/pipeline-interfaces.js';
import { TransformationEngine } from '../../utils/transformation-engine.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';

/**
 * Field Mapping Compatibility Module
 */
export class FieldMappingCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'field-mapping';
  readonly rules: TransformationRule[];
  readonly config: ModuleConfig;

  private isInitialized = false;
  private transformationEngine: TransformationEngine;
  private logger: PipelineDebugLogger;

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.logger = dependencies.logger as any;
    this.id = `compatibility-${Date.now()}`;
    this.config = config;
    this.rules = config.config?.rules || [];
    this.transformationEngine = new TransformationEngine();
  }

  /**
   * Initialize the module
   */
  async initialize(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'initializing', {
        config: this.config,
        ruleCount: this.rules.length
      });

      // Validate configuration and rules
      this.validateConfig();
      this.validateRules();

      // Initialize transformation engine
      await this.transformationEngine.initialize({
        maxDepth: 10,
        maxTimeMs: 5000,
        enableCache: true,
        cacheSize: 1000
      });

      this.isInitialized = true;
      this.logger.logModule(this.id, 'initialized', {
        rulesValidated: true,
        engineInitialized: true
      });

    } catch (error) {
      this.logger.logModule(this.id, 'initialization-error', { error });
      throw error;
    }
  }

  /**
   * Process incoming request - Apply field transformations
   */
  async processIncoming(request: any): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('Field Mapping Compatibility is not initialized');
    }

    try {
      // Apply request transformations if rules are defined
      if (this.rules.length > 0) {
        const transformedRequest = await this.applyTransformations(request, this.rules);
        this.logger.logTransformation(this.id, 'request-field-mapping', request, transformedRequest);
        return transformedRequest;
      }

      this.logger.logModule(this.id, 'no-request-transformations', {
        ruleCount: this.rules.length
      });

      return request;

    } catch (error) {
      this.logger.logModule(this.id, 'request-transform-error', { error, request });
      throw error;
    }
  }

  /**
   * Process outgoing response - Apply response transformations
   */
  async processOutgoing(response: any): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('Field Mapping Compatibility is not initialized');
    }

    try {
      // Apply response transformations if response rules are defined
      const responseRules = this.getResponseRules();
      if (responseRules.length > 0) {
        const transformedResponse = await this.applyTransformations(response, responseRules);
        this.logger.logTransformation(this.id, 'response-field-mapping', response, transformedResponse);
        return transformedResponse;
      }

      this.logger.logModule(this.id, 'no-response-transformations', {
        ruleCount: responseRules.length
      });

      return response;

    } catch (error) {
      this.logger.logModule(this.id, 'response-transform-error', { error, response });
      throw error;
    }
  }

  /**
   * Apply compatibility transformations
   */
  async applyTransformations(data: any, rules: TransformationRule[]): Promise<any> {
    return this.transformationEngine.transform(data, rules, {
      pipelineContext: {
        pipelineId: this.id,
        timestamp: Date.now(),
        requestId: 'unknown'
      },
      metadata: {
        ruleId: 'batch-transformation',
        ruleType: 'compatibility',
        attempt: 1
      },
      state: {},
      logger: (message: string, level: 'info' | 'warn' | 'error' = 'info') => {
        this.logger.logModule(this.id, `transformation-${level}`, { message });
      }
    });
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'cleanup-start');

      // Reset state
      this.isInitialized = false;

      // Clean up transformation engine
      await this.transformationEngine.cleanup();

      this.logger.logModule(this.id, 'cleanup-complete');

    } catch (error) {
      this.logger.logModule(this.id, 'cleanup-error', { error });
      throw error;
    }
  }

  /**
   * Get module status
   */
  getStatus(): {
    id: string;
    type: string;
    isInitialized: boolean;
    ruleCount: number;
    lastActivity: number;
    engineStatus: any;
  } {
    return {
      id: this.id,
      type: this.type,
      isInitialized: this.isInitialized,
      ruleCount: this.rules.length,
      lastActivity: Date.now(),
      engineStatus: this.transformationEngine.getStatus()
    };
  }

  /**
   * Get transformation statistics
   */
  async getTransformationStats(): Promise<any> {
    return this.transformationEngine.getStatistics();
  }

  /**
   * Add transformation rule dynamically
   */
  addRule(rule: TransformationRule): void {
    this.rules.push(rule);
    this.logger.logModule(this.id, 'rule-added', { rule });
  }

  /**
   * Remove transformation rule
   */
  removeRule(ruleId: string): boolean {
    const index = this.rules.findIndex(rule => rule.id === ruleId);
    if (index >= 0) {
      const removed = this.rules.splice(index, 1)[0];
      this.logger.logModule(this.id, 'rule-removed', { rule: removed });
      return true;
    }
    return false;
  }

  /**
   * Validate module configuration
   */
  private validateConfig(): void {
    if (!this.config.type || this.config.type !== 'field-mapping') {
      throw new Error('Invalid Compatibility type configuration');
    }

    if (!this.config.config) {
      throw new Error('Compatibility configuration is required');
    }

    const config = this.config.config;
    config.enableValidation = config.enableValidation ?? true;
    config.continueOnError = config.continueOnError ?? false;
    config.maxTransformations = config.maxTransformations ?? 100;

    this.logger.logModule(this.id, 'config-validation-success', {
      type: this.config.type,
      enableValidation: config.enableValidation,
      continueOnError: config.continueOnError,
      maxTransformations: config.maxTransformations
    });
  }

  /**
   * Validate transformation rules
   */
  private validateRules(): void {
    const errors: string[] = [];

    this.rules.forEach((rule, index) => {
      try {
        this.validateTransformationRule(rule);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push(`Rule ${index} (${rule.id}): ${errorMessage}`);
      }
    });

    if (errors.length > 0) {
      throw new Error(`Transformation rule validation failed:\n${errors.join('\n')}`);
    }

    this.logger.logModule(this.id, 'rules-validation-success', {
      ruleCount: this.rules.length,
      errors: errors.length
    });
  }

  /**
   * Validate individual transformation rule
   */
  private validateTransformationRule(rule: TransformationRule): void {
    if (!rule.id) {
      throw new Error('Rule ID is required');
    }

    if (!rule.transform) {
      throw new Error('Rule transform type is required');
    }

    // Validate specific transformation types
    switch (rule.transform) {
      case 'mapping':
        if (!rule.sourcePath) {
          throw new Error('Mapping transformation requires source path');
        }
        if (!rule.targetPath) {
          throw new Error('Mapping transformation requires target path');
        }
        if (!rule.mapping) {
          throw new Error('Mapping transformation requires mapping configuration');
        }
        break;

      case 'conditional':
        if (!rule.condition) {
          throw new Error('Conditional transformation requires condition configuration');
        }
        break;

      case 'combine':
        if (!rule.sourcePaths || !Array.isArray(rule.sourcePaths)) {
          throw new Error('Combine transformation requires sourcePaths array');
        }
        if (!rule.targetPath) {
          throw new Error('Combine transformation requires target path');
        }
        break;

      case 'structure':
        if (!rule.structure) {
          throw new Error('Structure transformation requires structure configuration');
        }
        break;

      default:
        if (!rule.sourcePath) {
          throw new Error(`${rule.transform} transformation requires source path`);
        }
        if (!rule.targetPath) {
          throw new Error(`${rule.transform} transformation requires target path`);
        }
        break;
    }
  }

  /**
   * Get response transformation rules
   */
  private getResponseRules(): TransformationRule[] {
    // Extract response rules from configuration
    const responseMappings = this.config.config?.responseMappings || [];

    return responseMappings.map((mapping: any) => ({
      id: mapping.id || `response-${Date.now()}`,
      transform: mapping.transform || 'mapping',
      sourcePath: mapping.sourcePath,
      targetPath: mapping.targetPath,
      mapping: mapping.mapping,
      defaultValue: mapping.defaultValue,
      condition: mapping.condition,
      removeSource: mapping.removeSource ?? false
    }));
  }

  /**
   * Create default transformation rules
   */
  private createDefaultRules(): TransformationRule[] {
    return [
      {
        id: 'model-mapping',
        transform: 'mapping',
        sourcePath: 'model',
        targetPath: 'model',
        mapping: {
          'gpt-4': 'qwen3-coder-plus',
          'gpt-3.5-turbo': 'qwen-turbo'
        }
      },
      {
        id: 'max-tokens-mapping',
        transform: 'mapping',
        sourcePath: 'max_tokens',
        targetPath: 'max_tokens',
        mapping: {
          '4096': 8192,
          '8192': 16384,
          '16384': 32768
        }
      }
    ];
  }

  /**
   * Extract transformation metadata for debugging
   */
  private extractTransformationMetadata(data: any): Record<string, any> {
    return {
      dataType: typeof data,
      isArray: Array.isArray(data),
      isObject: data && typeof data === 'object' && !Array.isArray(data),
      keys: data && typeof data === 'object' ? Object.keys(data) : [],
      size: JSON.stringify(data).length,
      timestamp: Date.now()
    };
  }

  /**
   * Handle transformation errors gracefully
   */
  private async handleTransformationError(error: any, data: any, rules: TransformationRule[]): Promise<any> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    const errorInfo = {
      error: errorMessage,
      stack: errorStack,
      dataType: typeof data,
      ruleCount: rules.length,
      timestamp: Date.now()
    };

    this.logger.logModule(this.id, 'transformation-error', errorInfo);

    // If continueOnError is enabled, return original data
    if (this.config.config?.continueOnError) {
      this.logger.logModule(this.id, 'transformation-error-continue', {
        message: 'Returning original data due to continueOnError flag'
      });
      return data;
    }

    // Otherwise, re-throw the error
    throw error;
  }

  /**
   * Create transformation context
   */
  private createTransformationContext(requestId?: string): any {
    return {
      pipelineContext: {
        pipelineId: this.id,
        requestId: requestId || 'unknown',
        timestamp: Date.now()
      },
      metadata: {
        ruleId: 'field-mapping',
        ruleType: 'compatibility',
        attempt: 1
      },
      state: {},
      logger: (message: string, level: 'info' | 'warn' | 'error' = 'info') => {
        this.logger.logModule(this.id, `transformation-${level}`, {
          message,
          requestId
        });
      }
    };
  }
}