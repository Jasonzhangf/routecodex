/**
 * RouteCodex Configuration Parser
 * Core configuration parsing and validation engine
 */

import { z } from 'zod';
// Note: Ajv is loaded dynamically to avoid import issues
import {
  ConfigValidationResult,
  ConfigError,
  ConfigWarning,
  JsonValue,
  RouteCodexConfigSchema,
} from '../types/config-types.js';
import {
  createVersionAssertion,
  autoUpgradeConfiguration,
  // getRecommendedSchemaVersion,
} from '../utils/version-management.js';
import {
  createSafeConfig,
  // sanitizeError,
  sanitizeString,
} from '../utils/secret-sanitization.js';
import {
  createJSONPointer,
  createJSONPointerFromZodPath,
  createJSONPointerFromAjvError,
  createMultiFormatError,
} from '../utils/json-pointer.js';
import { SharedModuleConfigResolver } from '../utils/shared-config-paths.js';

export class ConfigParser {
  private ajv: any | null;
  private schema: any;
  private configPath: string;
  private sanitizeOutput: boolean;
  private useUnifiedPathResolver: boolean;

  constructor(configPath: string = '~/.routecodex/config', options: { sanitizeOutput?: boolean; useUnifiedPathResolver?: boolean } = {}) {
    this.configPath = configPath;
    this.sanitizeOutput = options.sanitizeOutput !== false; // Default to true
    this.useUnifiedPathResolver = options.useUnifiedPathResolver !== false; // Default to true for new behavior

    // Initialize Ajv dynamically
    try {
      const Ajv = require('ajv');
      const addFormats = require('ajv-formats');
      this.ajv = new Ajv({
        allErrors: true,
        verbose: true,
        coerceTypes: true,
      });
      addFormats(this.ajv);
    } catch (error) {
      // Fallback if Ajv is not available
      this.ajv = null;
    }

    // Convert Zod schema to JSON Schema for Ajv
    this.schema = this.zodToJsonSchema();
    if (this.ajv) {
      this.ajv.addSchema(this.schema, 'routeCodexConfig');
    }
  }

  /**
   * Parse configuration from JSON string
   */
  async parseFromString(configString: string): Promise<ConfigValidationResult> {
    try {
      const config = JSON.parse(configString);
      return await this.validate(config);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        isValid: false,
        errors: [{
          code: 'INVALID_JSON',
          message: `Invalid JSON: ${this.sanitizeOutput ? sanitizeString(errorMessage) : errorMessage}`,
        }],
        warnings: [],
      };
    }
  }

  /**
   * Parse configuration from file
   */
  async parseFromFile(filePath: string): Promise<ConfigValidationResult> {
    try {
      const fs = await import('fs');
      const path = await import('path');

      const absolutePath = path.resolve(filePath.replace(/^~/, process.env.HOME || ''));

      if (!fs.existsSync(absolutePath)) {
        return {
          isValid: false,
          errors: [{
            code: 'FILE_NOT_FOUND',
            message: `Configuration file not found: ${absolutePath}`,
          }],
          warnings: [],
        };
      }

      const configString = fs.readFileSync(absolutePath, 'utf8');
      return await this.parseFromString(configString);
    } catch (error) {
      return {
        isValid: false,
        errors: [{
          code: 'FILE_READ_ERROR',
          message: `Failed to read configuration file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }],
        warnings: [],
      };
    }
  }

  /**
   * Parse configuration with auto-discovery from ~/.routecodex/config
   */
  async parseFromDefaultPath(configName?: string): Promise<ConfigValidationResult> {
    if (this.useUnifiedPathResolver) {
      // Use unified configuration path resolver
      return await this.parseFromDefaultPathUnified(configName);
    } else {
      // Use legacy path resolution for backward compatibility
      return await this.parseFromDefaultPathLegacy(configName);
    }
  }

  /**
   * Parse configuration using unified path resolver
   */
  private async parseFromDefaultPathUnified(configName?: string): Promise<ConfigValidationResult> {
    try {
      // Use the unified resolver to find configuration
      const result = SharedModuleConfigResolver.resolveConfigPath({
        configName,
        allowDirectoryScan: true,
        strict: false
      });

      if (!result.exists) {
        return {
          isValid: false,
          errors: [{
            code: 'CONFIG_FILE_NOT_FOUND',
            message: `Configuration file not found: ${result.resolvedPath}`,
          }],
          warnings: (result.warnings || []).map(w => ({
            code: 'CONFIG_RESOLUTION_WARNING',
            message: w,
            severity: 'warn' as const
          })),
        };
      }

      // Parse the resolved configuration file
      return await this.parseFromFile(result.resolvedPath);

    } catch (error) {
      return {
        isValid: false,
        errors: [{
          code: 'CONFIG_DISCOVERY_ERROR',
          message: `Failed to discover configuration using unified resolver: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }],
        warnings: [],
      };
    }
  }

  /**
   * Parse configuration using legacy path resolution (backward compatibility)
   */
  private async parseFromDefaultPathLegacy(configName?: string): Promise<ConfigValidationResult> {
    const fs = await import('fs');
    const path = await import('path');

    const configDir = this.configPath.replace(/^~/, process.env.HOME || '');

    try {
      if (!fs.existsSync(configDir)) {
        return {
          isValid: false,
          errors: [{
            code: 'CONFIG_DIR_NOT_FOUND',
            message: `Configuration directory not found: ${configDir}`,
          }],
          warnings: [],
        };
      }

      const files = fs.readdirSync(configDir);
      const configFiles = files.filter(f => f.endsWith('.json'));

      if (configFiles.length === 0) {
        return {
          isValid: false,
          errors: [{
            code: 'NO_CONFIG_FILES',
            message: `No configuration files found in ${configDir}`,
          }],
          warnings: [],
        };
      }

      // If configName specified, try to find exact match
      if (configName) {
        const targetFile = configName.endsWith('.json') ? configName : `${configName}.json`;
        const targetPath = path.join(configDir, targetFile);

        if (fs.existsSync(targetPath)) {
          return await this.parseFromFile(targetPath);
        }

        return {
          isValid: false,
          errors: [{
            code: 'CONFIG_FILE_NOT_FOUND',
            message: `Configuration file not found: ${targetPath}`,
          }],
          warnings: [],
        };
      }

      // Default to first .json file if no specific config requested
      const defaultConfig = path.join(configDir, configFiles[0]);
      return await this.parseFromFile(defaultConfig);

    } catch (error) {
      return {
        isValid: false,
        errors: [{
          code: 'CONFIG_DISCOVERY_ERROR',
          message: `Failed to discover configuration: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }],
        warnings: [],
      };
    }
  }

  /**
   * Validate configuration using Zod and Ajv
   */
  async validate(config: JsonValue): Promise<ConfigValidationResult> {
    const errors: ConfigError[] = [];
    const warnings: ConfigWarning[] = [];

    // Version validation first
    const versionAssertion = createVersionAssertion(config);
    errors.push(...versionAssertion.errors);

    // Add version warnings as ConfigWarning objects
    versionAssertion.warnings.forEach(warning => {
      warnings.push({
        code: 'VERSION_WARNING',
        message: warning,
        path: '/schemaVersion',
        severity: 'warn',
      });
    });

    // Skip further validation if version validation fails
    if (errors.length > 0 && errors.some(e => e.code.startsWith('VERSION_'))) {
      return {
        isValid: false,
        errors,
        warnings,
        normalized: undefined,
        versionInfo: versionAssertion.versionInfo,
      };
    }

    // Zod validation second
    const zodResult = RouteCodexConfigSchema.safeParse(config);

    if (!zodResult.success) {
      // Convert Zod errors to our format with enhanced JSON Pointer reporting
      zodResult.error.errors.forEach((issue) => {
        const path = createJSONPointerFromZodPath(issue.path);
        const multiFormatError = createMultiFormatError({
          code: 'ZOD_VALIDATION_ERROR',
          message: issue.message,
          path,
          expected: this.formatZodExpected(issue),
        }, config);

        errors.push({
          code: multiFormatError.error.code,
          message: multiFormatError.humanReadable,
          path: multiFormatError.jsonPointer,
          expected: multiFormatError.error.expected,
        });

        // Log detailed error information for debugging
        if (process.env.NODE_ENV === 'development' || process.env.DEBUG_JSON_POINTER) {
          console.warn('[JSON Pointer Debug]', {
            originalPath: issue.path,
            jsonPointer: multiFormatError.jsonPointer,
            dotNotation: multiFormatError.dotNotation,
            bracketNotation: multiFormatError.bracketNotation,
            error: multiFormatError.error,
          });
        }
      });
    }

    // Ajv validation for additional checks
    if (this.ajv) {
      const validate = this.ajv.getSchema('routeCodexConfig');
      if (validate) {
        const valid = validate(config);
        if (!valid && validate.errors) {
          validate.errors.forEach((ajvError: any) => {
            const path = createJSONPointerFromAjvError(ajvError);
            const multiFormatError = createMultiFormatError({
              code: 'AJV_VALIDATION_ERROR',
              message: ajvError.message || 'Validation error',
              path,
              expected: this.formatAjvExpected(ajvError),
            }, config);

            errors.push({
              code: multiFormatError.error.code,
              message: multiFormatError.humanReadable,
              path: multiFormatError.jsonPointer,
              expected: multiFormatError.error.expected,
            });

            // Log detailed error information for debugging
            if (process.env.NODE_ENV === 'development' || process.env.DEBUG_JSON_POINTER) {
              console.warn('[JSON Pointer Debug Ajv]', {
                originalError: ajvError,
                jsonPointer: multiFormatError.jsonPointer,
                dotNotation: multiFormatError.dotNotation,
                bracketNotation: multiFormatError.bracketNotation,
                error: multiFormatError.error,
              });
            }
          });
        }
      }
    }

    // Additional business logic validation
    const businessValidation = this.validateBusinessLogic(config);
    errors.push(...businessValidation.errors);
    warnings.push(...businessValidation.warnings);

    // Auto-normalization if validation passes
    let normalized: any = undefined;
    if (errors.length === 0) {
      // Apply auto-upgrade if needed
      const upgradedConfig = autoUpgradeConfiguration(config);
      normalized = this.normalizeConfig(upgradedConfig);

      // Apply sanitization if enabled
      if (this.sanitizeOutput && normalized) {
        normalized = createSafeConfig(normalized);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      normalized,
      versionInfo: versionAssertion.versionInfo,
    };
  }

  /**
   * Validate business logic rules
   */
  private validateBusinessLogic(config: JsonValue): { errors: ConfigError[]; warnings: ConfigWarning[] } {
    const errors: ConfigError[] = [];
    const warnings: ConfigWarning[] = [];

    if (typeof config !== 'object' || config === null) {
      return { errors, warnings };
    }

    const cfg = config as any;

    // Check provider consistency
    if (cfg.virtualrouter?.providers) {
      const providers = cfg.virtualrouter.providers;

      Object.entries(providers).forEach(([providerId, provider]: [string, any]) => {
        // Check if provider has enabled models
        if (provider.enabled && (!provider.models || Object.keys(provider.models).length === 0)) {
          const path = createJSONPointer(['virtualrouter', 'providers', providerId]);
          warnings.push({
            code: 'NO_MODELS_FOR_PROVIDER',
            message: `Provider '${providerId}' is enabled but has no models configured`,
            path,
            severity: 'warn',
          });
        }

        // Check API key configuration（仅在明确为 apikey/bearer 场景下校验）
        const hasOAuth = Boolean(provider.oauth || provider.auth?.oauth);
        const explicitAuthType = (provider.auth?.type || '').toLowerCase();
        const needsApiKey = !hasOAuth && (explicitAuthType === 'apikey' || explicitAuthType === 'bearer');
        if (needsApiKey) {
          const missingApiKey = !provider.apiKey || (Array.isArray(provider.apiKey) && provider.apiKey.length === 0);
          if (missingApiKey) {
            const path = createJSONPointer(['virtualrouter', 'providers', providerId, 'apiKey']);
            errors.push({
              code: 'MISSING_API_KEY',
              message: `Provider '${providerId}' requires apiKey for auth.type='${explicitAuthType}', but none was provided`,
              path,
            });
          }
        }

        // Check for sensitive data in logs (warning only)
        if (provider.apiKey && typeof provider.apiKey === 'string' && provider.apiKey.length < 8) {
          const path = createJSONPointer(['virtualrouter', 'providers', providerId, 'apiKey']);
          warnings.push({
            code: 'WEAK_API_KEY',
            message: `API key for provider '${providerId}' appears to be weak or test data`,
            path,
            severity: 'warn',
          });
        }
      });
    }

    // Check routing consistency
    if (cfg.virtualrouter?.routing) {
      const routing = cfg.virtualrouter.routing;
      const providers = cfg.virtualrouter?.providers || {};

      Object.entries(routing).forEach(([routeType, targets]: [string, any]) => {
        if (Array.isArray(targets)) {
          targets.forEach((target: string, index: number) => {
            const [providerId, modelId] = target.split('.');

            if (!providers[providerId]) {
              const path = createJSONPointer(['virtualrouter', 'routing', routeType, String(index)]);
              errors.push({
                code: 'UNKNOWN_PROVIDER_IN_ROUTING',
                message: `Route target '${target}' references unknown provider '${providerId}'`,
                path,
              });
            } else if (modelId && !providers[providerId].models?.[modelId]) {
              const path = createJSONPointer(['virtualrouter', 'routing', routeType, String(index)]);
              warnings.push({
                code: 'UNKNOWN_MODEL_IN_ROUTING',
                message: `Route target '${target}' references unknown model '${modelId}' for provider '${providerId}'`,
                path,
                severity: 'warn',
              });
            }
          });
        }
      });
    }

    return { errors, warnings };
  }

  /**
   * Normalize configuration (auto-fix common issues)
   */
  private normalizeConfig(config: JsonValue): any {
    if (typeof config !== 'object' || config === null) {
      return config;
    }

    const normalized = JSON.parse(JSON.stringify(config));

    // Add default version if missing
    if (!normalized.version) {
      normalized.version = '1.0.0';
    }

    // NOTE: Provider类型规范化统一由兼容层(config-compat)处理，
    // 引擎层仅负责验证与最小规范化，避免在此处引入错误映射或行为漂移。

    return normalized;
  }

  /**
   * Convert Zod schema to JSON Schema
   */
  private zodToJsonSchema(): any {
    // This is a simplified conversion - in practice, you might want to use a library
    // like zod-to-json-schema for more complex cases
    return {
      type: 'object',
      properties: {
        version: { type: 'string' },
        schemaVersion: { type: 'string' },
        port: { type: 'number', minimum: 1 },
        virtualrouter: {
          type: 'object',
          properties: {
            inputProtocol: { type: 'string', enum: ['openai', 'anthropic', 'custom'] },
            outputProtocol: { type: 'string', enum: ['openai', 'anthropic', 'custom'] },
            providers: { type: 'object' },
            routing: { type: 'object' },
            dryRun: { type: 'object' },
          },
          required: ['inputProtocol', 'outputProtocol', 'providers', 'routing'],
        },
      },
      required: ['version', 'virtualrouter'],
    };
  }

  /**
   * Format Zod expected value
   */
  private formatZodExpected(issue: z.ZodIssue): string {
    switch (issue.code) {
      case 'invalid_type':
        return `Expected ${issue.expected}, received ${issue.received}`;
      case 'invalid_enum_value':
        return `Expected one of: ${issue.options.join(', ')}`;
      case 'too_small':
      case 'too_big':
        return issue.message || 'Size constraint failed';
      default:
        return issue.message || 'Validation error';
    }
  }

  /**
   * Format Ajv expected value
   */
  private formatAjvExpected(error: any): string {
    if (error.params?.allowedValues) {
      return `Expected one of: ${error.params.allowedValues.join(', ')}`;
    }
    if (error.params?.type) {
      return `Expected type: ${error.params.type}`;
    }
    return error.message || 'Validation error';
  }

  /**
   * Enable or disable output sanitization
   */
  setSanitization(enabled: boolean): void {
    this.sanitizeOutput = enabled;
  }

  /**
   * Get current sanitization status
   */
  getSanitizationStatus(): boolean {
    return this.sanitizeOutput;
  }

  /**
   * Sanitize a configuration object
   */
  sanitize(config: JsonValue): JsonValue {
    return createSafeConfig(config);
  }

  /**
   * Check if a configuration contains sensitive data
   */
  containsSensitiveData(config: JsonValue): boolean {
    const configStr = JSON.stringify(config);
    return configStr.includes('apiKey') ||
           configStr.includes('secret') ||
           configStr.includes('token') ||
           configStr.includes('password');
  }
}
