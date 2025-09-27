/**
 * RouteCodex Configuration Validator
 * Provides comprehensive validation for RouteCodex configuration
 */

import type { RouteCodexConfig } from './config-types';
import { ErrorHandlingUtils } from '../utils/error-handling-utils';

/**
 * Simple validation result interface
 */
interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Configuration validator with custom validation logic
 */
export class ConfigValidator {
  private customValidators: Map<
    string,
    {
      validate: (config: RouteCodexConfig) => boolean | Promise<boolean>;
      message: string;
    }
  > = new Map();
  private errorUtils: ReturnType<typeof ErrorHandlingUtils.createModuleErrorHandler>;

  constructor() {
    this.errorUtils = ErrorHandlingUtils.createModuleErrorHandler('config-validator');
    this.registerErrorHandlers();
  }

  /**
   * Register error handlers
   */
  private registerErrorHandlers(): void {
    this.errorUtils.registerMessage(
      'validation_failed',
      'Configuration validation failed: {errors}',
      'high',
      'config',
      'Configuration validation encountered errors',
      'Check configuration file structure and values'
    );

    this.errorUtils.registerMessage(
      'schema_validation_failed',
      'Schema validation failed: {errors}',
      'high',
      'config',
      'Configuration schema validation failed',
      'Fix schema violations in configuration'
    );
  }

  /**
   * Validate configuration against schema
   */
  async validate(config: RouteCodexConfig): Promise<ValidationResult> {
    try {
      const errors: string[] = [];

      // Basic structure validation
      errors.push(...this.validateBasicStructure(config));

      // Server configuration validation
      errors.push(...this.validateServerConfig(config.server));

      // Providers validation
      errors.push(...this.validateProviders(config.providers));

      // Routing validation
      errors.push(...this.validateRouting(config.routing));

      // Dynamic routing validation
      errors.push(...this.validateDynamicRouting(config.dynamicRouting));

      // Security validation
      errors.push(...this.validateSecurity(config.security));

      // Monitoring validation
      errors.push(...this.validateMonitoring(config.monitoring));

      // Cache validation
      errors.push(...this.validateCache(config.cache));

      // Custom validators
      for (const [name, validator] of this.customValidators) {
        try {
          const isValid = await validator.validate(config);
          if (!isValid) {
            errors.push(validator.message);
          }
        } catch (error) {
          errors.push(`Custom validator '${name}' failed: ${error}`);
        }
      }

      return {
        valid: errors.length === 0,
        errors,
      };
    } catch (error) {
      await this.errorUtils.handle(error as Error, 'validate', {
        additionalContext: {
          context: 'Configuration validation',
        },
      });

      return {
        valid: false,
        errors: [`Validation failed: ${error}`],
      };
    }
  }

  /**
   * Validate basic configuration structure
   */
  private validateBasicStructure(config: RouteCodexConfig): string[] {
    const errors: string[] = [];

    if (!config.version || typeof config.version !== 'string') {
      errors.push('Version is required and must be a string');
    }

    if (!['development', 'production', 'test'].includes(config.environment)) {
      errors.push('Environment must be one of: development, production, test');
    }

    if (typeof config.debug !== 'boolean') {
      errors.push('Debug must be a boolean');
    }

    if (!['error', 'warn', 'info', 'debug'].includes(config.logLevel)) {
      errors.push('Log level must be one of: error, warn, info, debug');
    }

    return errors;
  }

  /**
   * Validate server configuration
   */
  private validateServerConfig(server: any): string[] {
    const errors: string[] = [];

    if (!server.host || typeof server.host !== 'string') {
      errors.push('Server host is required and must be a string');
    }

    if (typeof server.port !== 'number' || server.port < 1 || server.port > 65535) {
      errors.push('Server port must be a number between 1 and 65535');
    }

    if (server.cors) {
      if (typeof server.cors.enabled !== 'boolean') {
        errors.push('CORS enabled must be a boolean');
      }
      if (!server.cors.origin || !['string', 'object'].includes(typeof server.cors.origin)) {
        errors.push('CORS origin is required');
      }
    }

    if (server.rateLimit) {
      if (typeof server.rateLimit.enabled !== 'boolean') {
        errors.push('Rate limit enabled must be a boolean');
      }
      if (typeof server.rateLimit.windowMs !== 'number' || server.rateLimit.windowMs < 1) {
        errors.push('Rate limit window must be a positive number');
      }
      if (typeof server.rateLimit.max !== 'number' || server.rateLimit.max < 1) {
        errors.push('Rate limit max must be a positive number');
      }
    }

    return errors;
  }

  /**
   * Validate providers configuration
   */
  private validateProviders(providers: any): string[] {
    const errors: string[] = [];

    if (!providers || typeof providers !== 'object') {
      errors.push('Providers must be an object');
      return errors;
    }

    for (const [id, provider] of Object.entries(providers)) {
      const providerObj = provider as any;
      if (!providerObj.id || providerObj.id !== id) {
        errors.push(`Provider ${id} must have matching ID`);
      }

      if (!['openai', 'anthropic', 'custom', 'pass-through'].includes(providerObj.type)) {
        errors.push(`Provider ${id} type must be one of: openai, anthropic, custom, pass-through`);
      }

      if (typeof providerObj.enabled !== 'boolean') {
        errors.push(`Provider ${id} enabled must be a boolean`);
      }

      if (providerObj.models && typeof providerObj.models === 'object') {
        for (const [modelId, model] of Object.entries(providerObj.models)) {
          const modelObj = model as any;
          if (typeof modelObj.maxTokens !== 'number' || modelObj.maxTokens < 1) {
            errors.push(`Model ${modelId} in provider ${id} must have positive maxTokens`);
          }
        }
      }
    }

    return errors;
  }

  /**
   * Validate routing configuration
   */
  private validateRouting(routing: any): string[] {
    const errors: string[] = [];

    if (!routing || typeof routing !== 'object') {
      errors.push('Routing configuration must be an object');
      return errors;
    }

    if (!['round-robin', 'load-based', 'priority', 'custom'].includes(routing.strategy)) {
      errors.push('Routing strategy must be one of: round-robin, load-based, priority, custom');
    }

    if (routing.rules && Array.isArray(routing.rules)) {
      for (let i = 0; i < routing.rules.length; i++) {
        const rule = routing.rules[i];
        if (!rule.pattern || typeof rule.pattern !== 'string') {
          errors.push(`Rule ${i} must have a pattern`);
        }
        if (!rule.provider || typeof rule.provider !== 'string') {
          errors.push(`Rule ${i} must have a provider`);
        }
      }
    }

    return errors;
  }

  /**
   * Validate dynamic routing configuration
   */
  private validateDynamicRouting(dynamicRouting: any): string[] {
    const errors: string[] = [];

    if (!dynamicRouting || typeof dynamicRouting !== 'object') {
      errors.push('Dynamic routing configuration must be an object');
      return errors;
    }

    if (typeof dynamicRouting.enabled !== 'boolean') {
      errors.push('Dynamic routing enabled must be a boolean');
    }

    if (dynamicRouting.categories && typeof dynamicRouting.categories === 'object') {
      const validCategories = [
        'default',
        'longcontext',
        'thinking',
        'background',
        'websearch',
        'vision',
        'coding',
      ];

      for (const [category, config] of Object.entries(dynamicRouting.categories)) {
        if (!validCategories.includes(category)) {
          errors.push(`Invalid dynamic routing category: ${category}`);
          continue;
        }

        const categoryConfig = config as any;
        if (category === 'default') {
          if (!categoryConfig.targets || !Array.isArray(categoryConfig.targets)) {
            errors.push(`Category ${category} must have targets array`);
          }
        } else {
          if (typeof categoryConfig.enabled !== 'boolean') {
            errors.push(`Category ${category} enabled must be a boolean`);
          }
          if (
            categoryConfig.enabled &&
            (!categoryConfig.targets || !Array.isArray(categoryConfig.targets))
          ) {
            errors.push(`Enabled category ${category} must have targets array`);
          }
        }
      }
    }

    return errors;
  }

  /**
   * Validate security configuration
   */
  private validateSecurity(security: any): string[] {
    const errors: string[] = [];

    if (!security || typeof security !== 'object') {
      errors.push('Security configuration must be an object');
      return errors;
    }

    if (security.authentication && typeof security.authentication.enabled !== 'boolean') {
      errors.push('Authentication enabled must be a boolean');
    }

    if (security.authorization && typeof security.authorization.enabled !== 'boolean') {
      errors.push('Authorization enabled must be a boolean');
    }

    if (security.encryption && typeof security.encryption.enabled !== 'boolean') {
      errors.push('Encryption enabled must be a boolean');
    }

    return errors;
  }

  /**
   * Validate monitoring configuration
   */
  private validateMonitoring(monitoring: any): string[] {
    const errors: string[] = [];

    if (!monitoring || typeof monitoring !== 'object') {
      errors.push('Monitoring configuration must be an object');
      return errors;
    }

    if (typeof monitoring.enabled !== 'boolean') {
      errors.push('Monitoring enabled must be a boolean');
    }

    if (monitoring.metrics && typeof monitoring.metrics.enabled !== 'boolean') {
      errors.push('Metrics enabled must be a boolean');
    }

    if (
      monitoring.logging &&
      !['error', 'warn', 'info', 'debug'].includes(monitoring.logging.level)
    ) {
      errors.push('Logging level must be one of: error, warn, info, debug');
    }

    return errors;
  }

  /**
   * Validate cache configuration
   */
  private validateCache(cache: any): string[] {
    const errors: string[] = [];

    if (!cache || typeof cache !== 'object') {
      errors.push('Cache configuration must be an object');
      return errors;
    }

    if (typeof cache.enabled !== 'boolean') {
      errors.push('Cache enabled must be a boolean');
    }

    if (cache.enabled && !['memory', 'redis', 'file'].includes(cache.type)) {
      errors.push('Cache type must be one of: memory, redis, file');
    }

    return errors;
  }

  /**
   * Validate specific configuration section
   */
  async validateSection(
    config: RouteCodexConfig,
    section: keyof RouteCodexConfig
  ): Promise<{ valid: boolean; errors: string[] }> {
    const sectionConfig = config[section];
    const errors: string[] = [];

    switch (section) {
      case 'server':
        errors.push(...this.validateServerConfig(sectionConfig));
        break;
      case 'providers':
        errors.push(...this.validateProviders(sectionConfig));
        break;
      case 'routing':
        errors.push(...this.validateRouting(sectionConfig));
        break;
      case 'dynamicRouting':
        errors.push(...this.validateDynamicRouting(sectionConfig));
        break;
      case 'security':
        errors.push(...this.validateSecurity(sectionConfig));
        break;
      case 'monitoring':
        errors.push(...this.validateMonitoring(sectionConfig));
        break;
      case 'cache':
        errors.push(...this.validateCache(sectionConfig));
        break;
      default:
        errors.push(`Unknown section: ${String(section)}`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Add custom validator
   */
  addCustomValidator(
    name: string,
    validate: (config: RouteCodexConfig) => boolean | Promise<boolean>,
    message: string
  ): void {
    this.customValidators.set(name, { validate, message });
  }

  /**
   * Remove custom validator
   */
  removeCustomValidator(name: string): void {
    this.customValidators.delete(name);
  }

  /**
   * Get configuration schema (simplified version)
   */
  getSchema(): any {
    return {
      type: 'object',
      properties: {
        version: { type: 'string', minLength: 1 },
        environment: { enum: ['development', 'production', 'test'] },
        debug: { type: 'boolean' },
        logLevel: { enum: ['error', 'warn', 'info', 'debug'] },
        server: {
          type: 'object',
          properties: {
            host: { type: 'string', minLength: 1 },
            port: { type: 'integer', minimum: 1, maximum: 65535 },
          },
          required: ['host', 'port'],
        },
        providers: {
          type: 'object',
          patternProperties: {
            '.*': {
              type: 'object',
              properties: {
                id: { type: 'string', minLength: 1 },
                type: { enum: ['openai', 'anthropic', 'custom', 'pass-through'] },
                enabled: { type: 'boolean' },
              },
              required: ['id', 'type', 'enabled'],
            },
          },
        },
      },
      required: ['version', 'environment', 'debug', 'logLevel', 'server'],
    };
  }
}
