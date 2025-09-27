/**
 * JSON Configuration Provider
 * Handles loading and saving JSON configuration files
 */

import fs from 'fs/promises';
import path from 'path';
import type { RouteCodexConfig, ConfigProvider } from '../config-types';
import { ErrorHandlingUtils } from '../../utils/error-handling-utils';

/**
 * JSON configuration provider implementation
 */
export class JsonConfigProvider implements ConfigProvider {
  name = 'json';
  priority = 100; // High priority for JSON files
  private errorUtils: ReturnType<typeof ErrorHandlingUtils.createModuleErrorHandler>;

  constructor() {
    this.errorUtils = ErrorHandlingUtils.createModuleErrorHandler('json-config-provider');
    this.registerErrorHandlers();
  }

  /**
   * Register error handlers
   */
  private registerErrorHandlers(): void {
    this.errorUtils.registerMessage(
      'json_file_not_found',
      'JSON configuration file not found: {path}',
      'medium',
      'config',
      'The specified JSON configuration file does not exist',
      'Check the file path or create the configuration file'
    );

    this.errorUtils.registerMessage(
      'json_parse_error',
      'Failed to parse JSON configuration file: {path}',
      'critical',
      'config',
      'JSON configuration file contains invalid syntax',
      'Validate JSON syntax and fix any errors'
    );

    this.errorUtils.registerMessage(
      'json_save_error',
      'Failed to save JSON configuration file: {path}',
      'high',
      'config',
      'Unable to write JSON configuration file',
      'Check file permissions and disk space'
    );

    this.errorUtils.registerMessage(
      'json_schema_error',
      'JSON configuration does not match expected schema: {error}',
      'high',
      'config',
      'Configuration structure is invalid',
      'Check configuration against schema and fix structure'
    );
  }

  /**
   * Check if this provider can handle the given file path
   */
  canHandle(filePath: string): boolean {
    return filePath.endsWith('.json');
  }

  /**
   * Load configuration from JSON file
   */
  async load(filePath: string): Promise<RouteCodexConfig> {
    try {
      // Ensure file exists
      try {
        await fs.access(filePath);
      } catch (error) {
        throw new Error(`Configuration file not found: ${filePath}`);
      }

      // Read file content
      const content = await fs.readFile(filePath, 'utf-8');

      // Parse JSON
      let config: RouteCodexConfig;
      try {
        config = JSON.parse(content);
      } catch (error) {
        throw new Error(`Invalid JSON syntax: ${error}`);
      }

      // Validate basic structure
      this.validateBasicStructure(config);

      return config;
    } catch (error) {
      await this.errorUtils.handle(error as Error, 'load', {
        additionalContext: {
          filePath,
          context: 'JSON configuration loading'
        }
      });

      throw error;
    }
  }

  /**
   * Save configuration to JSON file
   */
  async save(filePath: string, config: RouteCodexConfig): Promise<void> {
    try {
      // Ensure directory exists
      const dir = path.dirname(filePath);
      try {
        await fs.access(dir);
      } catch {
        await fs.mkdir(dir, { recursive: true });
      }

      // Convert config to JSON with pretty formatting
      const jsonContent = JSON.stringify(config, null, 2);

      // Write to file
      await fs.writeFile(filePath, jsonContent, 'utf-8');

      // Verify file was written correctly
      const verifyContent = await fs.readFile(filePath, 'utf-8');
      const verifyConfig = JSON.parse(verifyContent);

      if (JSON.stringify(verifyConfig) !== jsonContent) {
        throw new Error('Configuration file verification failed');
      }
    } catch (error) {
      await this.errorUtils.handle(error as Error, 'save', {
        additionalContext: {
          filePath,
          context: 'JSON configuration saving'
        }
      });

      throw error;
    }
  }

  /**
   * Validate basic configuration structure
   */
  private validateBasicStructure(config: any): void {
    const requiredFields = ['version', 'environment', 'debug', 'logLevel'];
    const missingFields = requiredFields.filter(field => !(field in config));

    if (missingFields.length > 0) {
      throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
    }

    // Validate environment
    const validEnvironments = ['development', 'production', 'test'];
    if (!validEnvironments.includes(config.environment)) {
      throw new Error(`Invalid environment: ${config.environment}`);
    }

    // Validate log level
    const validLogLevels = ['error', 'warn', 'info', 'debug'];
    if (!validLogLevels.includes(config.logLevel)) {
      throw new Error(`Invalid log level: ${config.logLevel}`);
    }
  }

  /**
   * Create a backup of the configuration file
   */
  async createBackup(filePath: string): Promise<string> {
    try {
      const backupPath = `${filePath}.backup.${Date.now()}`;
      await fs.copyFile(filePath, backupPath);
      return backupPath;
    } catch (error) {
      await this.errorUtils.handle(error as Error, 'createBackup', {
        additionalContext: {
          filePath,
          context: 'JSON configuration backup'
        }
      });

      throw error;
    }
  }

  /**
   * Restore configuration from backup
   */
  async restoreBackup(backupPath: string, targetPath?: string): Promise<void> {
    try {
      const target = targetPath || backupPath.replace('.backup.', '.').replace(/\.\d+$/, '');
      await fs.copyFile(backupPath, target);
    } catch (error) {
      await this.errorUtils.handle(error as Error, 'restoreBackup', {
        additionalContext: {
          backupPath,
          context: 'JSON configuration restore'
        }
      });

      throw error;
    }
  }

  /**
   * Format JSON configuration with consistent formatting
   */
  formatConfig(config: RouteCodexConfig): string {
    return JSON.stringify(config, null, 2);
  }

  /**
   * Minify JSON configuration (remove whitespace)
   */
  minifyConfig(config: RouteCodexConfig): string {
    return JSON.stringify(config);
  }

  /**
   * Get JSON configuration file info
   */
  async getFileInfo(filePath: string): Promise<{
    exists: boolean;
    size: number;
    modified: Date;
    isValid?: boolean;
    error?: string;
  }> {
    try {
      const stats = await fs.stat(filePath);
      const exists = true;
      const size = stats.size;
      const modified = stats.mtime;

      // Try to validate the file
      let isValid = true;
      let error: string | undefined;

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const config = JSON.parse(content);
        this.validateBasicStructure(config);
      } catch (e) {
        isValid = false;
        error = e instanceof Error ? e.message : String(e);
      }

      return {
        exists,
        size,
        modified,
        isValid,
        error
      };
    } catch (e) {
      return {
        exists: false,
        size: 0,
        modified: new Date(0)
      };
    }
  }

  /**
   * Clean up old backup files
   */
  async cleanupBackups(filePath: string, keepCount: number = 5): Promise<void> {
    try {
      const dir = path.dirname(filePath);
      const basename = path.basename(filePath);
      const files = await fs.readdir(dir);

      const backupFiles = await Promise.all(
        files
          .filter(file => file.startsWith(`${basename}.backup.`))
          .map(async file => {
            const fullPath = path.join(dir, file);
            const stats = await fs.stat(fullPath);
            return {
              name: file,
              path: fullPath,
              time: stats.mtime
            } as const;
          })
      );

      // Sort by modification time (newest first)
      const sortedBackups = backupFiles.sort((a, b) => b.time.getTime() - a.time.getTime());

      // Keep only the most recent backups
      const toDelete = sortedBackups.slice(keepCount);

      for (const backup of toDelete) {
        try {
          await fs.unlink(backup.path);
        } catch (error) {
          console.warn(`Failed to delete backup file ${backup.path}:`, error);
        }
      }
    } catch (error) {
      await this.errorUtils.handle(error as Error, 'cleanupBackups', {
        additionalContext: {
          filePath,
          context: 'JSON configuration backup cleanup'
        }
      });
    }
  }
}
