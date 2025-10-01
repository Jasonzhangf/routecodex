/**
 * RouteCodex Direct API Key Configuration Utility
 *
 * This module provides utilities to convert environment variable-based
 * API key configurations to direct API key configurations.
 *
 * Migration utility for replacing ${VAR_NAME} patterns with actual values.
 */

import fs from 'fs';
import path from 'path';

/**
 * Configuration migration options
 */
export interface DirectConfigMigrationOptions {
  /** Source configuration file path */
  sourcePath?: string;
  /** Target configuration file path */
  targetPath?: string;
  /** Whether to backup the original file */
  backup?: boolean;
  /** Whether to validate API key format */
  validateKeys?: boolean;
  /** Environment variable mappings (for override) */
  envMappings?: Record<string, string>;
}

/**
 * Migration result information
 */
export interface DirectConfigMigrationResult {
  success: boolean;
  filePath?: string;
  backupPath?: string;
  warnings: string[];
  changes: {
    envVarsReplaced: number;
    keysValidated: number;
    validationFailures: number;
  };
}

/**
 * Configuration validation result
 */
export interface ConfigValidationResult {
  isValid: boolean;
  warnings: string[];
  errors: string[];
  apiKeys: {
    direct: number;
    envVars: number;
    invalid: number;
  };
}

/**
 * Direct API Key Configuration Utility
 */
export class DirectApiKeyConfig {
  private static readonly ENV_VAR_PATTERN = /\$\{([A-Za-z0-9_]+)\}/g;
  private static readonly API_KEY_PATTERNS = [
    /^sk-[A-Za-z0-9]{20,}$/, // OpenAI format
    /^[A-Za-z0-9]{32,}$/, // Generic API key format
    /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}$/, // JWT-like format
  ];

  /**
   * Validate configuration file for API key patterns
   */
  static validateConfig(config: any): ConfigValidationResult {
    const result: ConfigValidationResult = {
      isValid: true,
      warnings: [],
      errors: [],
      apiKeys: {
        direct: 0,
        envVars: 0,
        invalid: 0
      }
    };

    const scanObject = (obj: any, path: string = '') => {
      if (typeof obj === 'string') {
        if (obj.includes('${')) {
          result.apiKeys.envVars++;
          result.warnings.push(`Environment variable found at ${path}: ${obj}`);
        } else if (this.isApiKey(obj)) {
          result.apiKeys.direct++;
        } else if (obj.length > 10 && !this.isApiKey(obj)) {
          result.apiKeys.invalid++;
          result.warnings.push(`Potentially invalid API key format at ${path}`);
        }
      } else if (Array.isArray(obj)) {
        obj.forEach((item, index) => scanObject(item, `${path}[${index}]`));
      } else if (obj && typeof obj === 'object') {
        Object.entries(obj).forEach(([key, value]) => {
          scanObject(value, path ? `${path}.${key}` : key);
        });
      }
    };

    scanObject(config);

    // Determine overall validity
    result.isValid = result.apiKeys.invalid === 0;

    return result;
  }

  /**
   * Check if a string looks like an API key
   */
  private static isApiKey(str: string): boolean {
    return this.API_KEY_PATTERNS.some(pattern => pattern.test(str));
  }

  /**
   * Convert environment variable configuration to direct configuration
   */
  static convertToDirectConfig(
    config: any,
    envMappings: Record<string, string> = {}
  ): any {
    const converted = JSON.parse(JSON.stringify(config));

    const processValue = (value: any): any => {
      if (typeof value === 'string') {
        return this.expandEnvVars(value, envMappings);
      } else if (Array.isArray(value)) {
        return value.map(processValue);
      } else if (value && typeof value === 'object') {
        const result: any = {};
        for (const [key, val] of Object.entries(value)) {
          result[key] = processValue(val);
        }
        return result;
      }
      return value;
    };

    return processValue(converted);
  }

  /**
   * Expand environment variables with custom mappings
   */
  private static expandEnvVars(
    str: string,
    envMappings: Record<string, string>
  ): string {
    return str.replace(this.ENV_VAR_PATTERN, (match, envVar) => {
      // Check custom mappings first, then process.env
      const value = envMappings[envVar] || process.env[envVar];

      if (value) {
        return value;
      }

      // If no value found, keep the original (warn in validation)
      return match;
    });
  }

  /**
   * Migrate configuration file to use direct API keys
   */
  static async migrateConfigFile(
    options: DirectConfigMigrationOptions = {}
  ): Promise<DirectConfigMigrationResult> {
    const {
      sourcePath,
      targetPath,
      backup = true,
      validateKeys = true,
      envMappings = {}
    } = options;

    if (!sourcePath) {
      throw new Error('Source configuration file path is required');
    }

    const result: DirectConfigMigrationResult = {
      success: false,
      warnings: [],
      changes: {
        envVarsReplaced: 0,
        keysValidated: 0,
        validationFailures: 0
      }
    };

    try {
      // Read source configuration
      const sourceContent = fs.readFileSync(sourcePath, 'utf8');
      const sourceConfig = JSON.parse(sourceContent);

      // Validate original configuration
      const validation = this.validateConfig(sourceConfig);
      result.warnings.push(...validation.warnings);
      result.changes.envVarsReplaced = validation.apiKeys.envVars;

      // Convert to direct configuration
      const directConfig = this.convertToDirectConfig(sourceConfig, envMappings);

      // Validate converted configuration
      const convertedValidation = this.validateConfig(directConfig);
      result.changes.keysValidated = convertedValidation.apiKeys.direct;
      result.changes.validationFailures = convertedValidation.apiKeys.invalid;

      if (validateKeys && convertedValidation.apiKeys.invalid > 0) {
        result.warnings.push(
          `Configuration contains ${convertedValidation.apiKeys.invalid} potentially invalid API keys`
        );
      }

      // Determine target path
      const finalTargetPath = targetPath || sourcePath;

      // Create backup if needed
      if (backup && finalTargetPath === sourcePath) {
        const backupPath = this.createBackupPath(sourcePath);
        fs.copyFileSync(sourcePath, backupPath);
        result.backupPath = backupPath;
        result.warnings.push(`Backup created at: ${backupPath}`);
      }

      // Write converted configuration
      const finalContent = JSON.stringify(directConfig, null, 2);
      fs.writeFileSync(finalTargetPath, finalContent, 'utf8');

      result.success = true;
      result.filePath = finalTargetPath;

      return result;

    } catch (error) {
      result.warnings.push(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
      return result;
    }
  }

  /**
   * Generate backup file path
   */
  private static createBackupPath(originalPath: string): string {
    const parsed = path.parse(originalPath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(parsed.dir, `${parsed.name}.backup-${timestamp}${parsed.ext}`);
  }

  /**
   * Generate migration report
   */
  static generateMigrationReport(
    sourcePath: string,
    validation: ConfigValidationResult
  ): string {
    const lines: string[] = [];

    lines.push('# RouteCodex API Key Configuration Migration Report');
    lines.push('');
    lines.push(`## Source File: ${sourcePath}`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');

    lines.push('## Configuration Analysis');
    lines.push('');
    lines.push(`- Direct API Keys: ${validation.apiKeys.direct}`);
    lines.push(`- Environment Variables: ${validation.apiKeys.envVars}`);
    lines.push(`- Potentially Invalid Keys: ${validation.apiKeys.invalid}`);
    lines.push('');

    if (validation.warnings.length > 0) {
      lines.push('## Warnings');
      lines.push('');
      validation.warnings.forEach(warning => {
        lines.push(`- ${warning}`);
      });
      lines.push('');
    }

    if (validation.errors.length > 0) {
      lines.push('## Errors');
      lines.push('');
      validation.errors.forEach(error => {
        lines.push(`- ${error}`);
      });
      lines.push('');
    }

    lines.push('## Migration Status');
    lines.push('');

    if (validation.apiKeys.envVars === 0) {
      lines.push('✅ Configuration already uses direct API keys');
    } else {
      lines.push('⚠️  Configuration uses environment variables - migration recommended');
      lines.push('');
      lines.push('### Migration Command');
      lines.push('```bash');
      lines.push(`# Dry run first`);
      lines.push(`node -e "const { DirectApiKeyConfig } = require('routecodex-config-compat'); console.log(DirectApiKeyConfig.validateConfig(require('${sourcePath}')))"`);
      lines.push('');
      lines.push(`# Perform migration`);
      lines.push(`node -e "const { DirectApiKeyConfig } = require('routecodex-config-compat'); DirectApiKeyConfig.migrateConfigFile({ sourcePath: '${sourcePath}' })"`);
      lines.push('```');
    }

    return lines.join('\n');
  }
}