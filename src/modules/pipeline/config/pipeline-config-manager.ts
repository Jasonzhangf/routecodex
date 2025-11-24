/**
 * Pipeline Configuration Manager Implementation
 *
 * Provides configuration loading, validation, and management for
 * pipeline configurations with support for hot reload and caching.
 */

import type {
  PipelineManagerConfig,
  PipelineConfig,
  PipelineConfigValidation
} from '../types/pipeline-types.js';
import { PipelineDebugLogger } from '../utils/debug-logger.js';
import fs from 'fs/promises';
// import path from 'path';

/**
 * Configuration source type
 */
export type ConfigSource = 'file' | 'object' | 'url' | 'env';

/**
 * Configuration source information
 */
export interface ConfigSourceInfo {
  type: ConfigSource;
  location: string;
  lastModified?: number;
  checksum?: string;
}

/**
 * Configuration watcher interface
 */
export interface ConfigWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  onConfigChange(callback: (config: PipelineManagerConfig) => void): void;
}

/**
 * Pipeline Configuration Manager
 */
export class PipelineConfigManager {
  private config: PipelineManagerConfig | null = null;
  private configSource: ConfigSourceInfo | null = null;
  private validationCache: Map<string, PipelineConfigValidation> = new Map();
  private watcher: ConfigWatcher | null = null;
  private logger: PipelineDebugLogger;
  private isInitialized = false;

  constructor(
    private debugCenter: any, // DebugCenter - avoiding circular import
    private options: {
      enableWatcher?: boolean;
      enableCache?: boolean;
      validationStrict?: boolean;
      configPath?: string;
    } = {}
  ) {
    this.logger = new PipelineDebugLogger(debugCenter, {
      maxLogEntries: 100,
      logLevel: 'detailed'
    });
  }

  /**
   * Initialize the configuration manager
   */
  async initialize(): Promise<void> {
    try {
      this.logger.logModule('config-manager', 'initializing', {
        options: this.options
      });

      // Initialize default configuration if needed
      if (!this.config && this.options.configPath) {
        await this.loadConfig(this.options.configPath);
      }

      // Start config watcher if enabled
      if (this.options.enableWatcher && this.configSource?.type === 'file') {
        await this.startConfigWatcher();
      }

      this.isInitialized = true;
      this.logger.logModule('config-manager', 'initialized');

    } catch (error) {
      this.logger.logModule('config-manager', 'initialization-error', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Load pipeline configuration from source
   */
  async loadConfig(source: string | PipelineManagerConfig): Promise<PipelineManagerConfig> {
    try {
      let config: PipelineManagerConfig;
      let sourceInfo: ConfigSourceInfo;

      if (typeof source === 'string') {
        // Load from file or URL
        if (source.startsWith('http://') || source.startsWith('https://')) {
          config = await this.loadFromUrl(source);
          sourceInfo = { type: 'url', location: source };
        } else {
          config = await this.loadFromFile(source);
          sourceInfo = { type: 'file', location: source };
        }
      } else {
        // Use provided object
        config = source;
        sourceInfo = { type: 'object', location: 'memory' };
      }

      // Validate configuration
      const validation = await this.validateConfig(config);
      if (!validation.isValid) {
        throw new Error(`Configuration validation failed:\n${validation.errors.join('\n')}`);
      }

      // Use normalized configuration if available
      this.config = (validation.normalizedConfig as unknown as PipelineManagerConfig) || config;
      this.configSource = sourceInfo;

      // Cache validation result
      if (this.config) {
        this.validationCache.set(this.generateConfigKey(this.config), validation);
      }

      this.logger.logModule('config-manager', 'config-loaded', {
        sourceType: sourceInfo.type,
        pipelineCount: this.config?.pipelines.length || 0,
        validationErrors: validation.errors.length,
        validationWarnings: validation.warnings.length
      });

      return this.config!;

    } catch (error) {
      this.logger.logModule('config-manager', 'load-error', {
        source: typeof source === 'string' ? source : 'object',
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): PipelineManagerConfig | null {
    return this.config ? { ...this.config } : null;
  }

  /**
   * Get pipeline configuration by ID
   */
  getPipelineConfig(pipelineId: string): PipelineConfig | null {
    if (!this.config) {
      return null;
    }

    return this.config.pipelines.find(p => p.id === pipelineId) || null;
  }

  /**
   * Validate configuration
   */
  async validateConfig(config: PipelineManagerConfig): Promise<PipelineConfigValidation> {
    const configKey = this.generateConfigKey(config);

    // Check cache first
    if (this.options.enableCache !== false && this.validationCache.has(configKey)) {
      return this.validationCache.get(configKey)!;
    }

    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Basic structure validation
      this.validateBasicStructure(config, errors, warnings);

      // Pipeline validation
      this.validatePipelines(config, errors, warnings);

      // Module validation
      this.validateModules(config, errors, warnings);

      // Provider validation
      this.validateProviders(config, errors, warnings);

      const result: PipelineConfigValidation = {
        isValid: errors.length === 0,
        errors,
        warnings
      };

      // Cache result
      if (this.options.enableCache !== false) {
        this.validationCache.set(configKey, result);
      }

      return result;

    } catch (error) {
      return {
        isValid: false,
        errors: [`Validation error: ${error instanceof Error ? error.message : String(error)}`],
        warnings: []
      };
    }
  }

  /**
   * Update configuration
   */
  async updateConfig(updates: Partial<PipelineManagerConfig>): Promise<void> {
    if (!this.config) {
      throw new Error('No configuration loaded');
    }

    const updatedConfig = {
      ...this.config,
      ...updates,
      pipelines: updates.pipelines || this.config.pipelines
    };

    // Validate updated configuration
    const validation = await this.validateConfig(updatedConfig);
    if (!validation.isValid) {
      throw new Error(`Configuration update validation failed:\n${validation.errors.join('\n')}`);
    }

    this.config = updatedConfig;

    // Update cache
    const configKey = this.generateConfigKey(this.config);
    this.validationCache.set(configKey, validation);

    this.logger.logModule('config-manager', 'config-updated', {
      updatedFields: Object.keys(updates),
      validationErrors: validation.errors.length
    });
  }

  /**
   * Add new pipeline configuration
   */
  async addPipeline(pipelineConfig: PipelineConfig): Promise<void> {
    if (!this.config) {
      throw new Error('No configuration loaded');
    }

    // Check for duplicate ID
    if (this.config.pipelines.some(p => p.id === pipelineConfig.id)) {
      throw new Error(`Pipeline with ID '${pipelineConfig.id}' already exists`);
    }

    // Validate pipeline configuration
    const pipelineErrors = this.validatePipelineConfiguration(pipelineConfig);
    if (pipelineErrors.length > 0) {
      throw new Error(`Pipeline validation failed:\n${pipelineErrors.join('\n')}`);
    }

    this.config.pipelines.push(pipelineConfig);

    // Clear validation cache
    this.validationCache.clear();

    this.logger.logModule('config-manager', 'pipeline-added', {
      pipelineId: pipelineConfig.id,
      providerType: pipelineConfig.provider.type
    });
  }

  /**
   * Remove pipeline configuration
   */
  async removePipeline(pipelineId: string): Promise<void> {
    if (!this.config) {
      throw new Error('No configuration loaded');
    }

    const index = this.config.pipelines.findIndex(p => p.id === pipelineId);
    if (index === -1) {
      throw new Error(`Pipeline with ID '${pipelineId}' not found`);
    }

    this.config.pipelines.splice(index, 1);

    // Clear validation cache
    this.validationCache.clear();

    this.logger.logModule('config-manager', 'pipeline-removed', {
      pipelineId,
      remainingPipelines: this.config.pipelines.length
    });
  }

  /**
   * Export configuration to file
   */
  async exportConfig(filePath: string): Promise<void> {
    if (!this.config) {
      throw new Error('No configuration to export');
    }

    try {
      const configString = JSON.stringify(this.config, null, 2);
      await fs.writeFile(filePath, configString, 'utf-8');

      this.logger.logModule('config-manager', 'config-exported', {
        filePath,
        size: configString.length
      });

    } catch (error) {
      this.logger.logModule('config-manager', 'export-error', {
        filePath,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Reload configuration from source
   */
  async reloadConfig(): Promise<void> {
    if (!this.configSource) {
      throw new Error('No configuration source available');
    }

    this.logger.logModule('config-manager', 'reloading-config', {
      source: this.configSource
    });

    await this.loadConfig(this.configSource.location);
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    try {
      this.logger.logModule('config-manager', 'cleanup-start');

      // Stop config watcher
      if (this.watcher) {
        await this.watcher.stop();
        this.watcher = null;
      }

      // Clear caches
      this.validationCache.clear();

      // Reset state
      this.config = null;
      this.configSource = null;
      this.isInitialized = false;

      this.logger.logModule('config-manager', 'cleanup-complete');

    } catch (error) {
      this.logger.logModule('config-manager', 'cleanup-error', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get configuration statistics
   */
  getStatistics(): {
    isInitialized: boolean;
    hasConfig: boolean;
    configSource: ConfigSourceInfo | null;
    pipelineCount: number;
    validationCacheSize: number;
    watcherActive: boolean;
  } {
    return {
      isInitialized: this.isInitialized,
      hasConfig: this.config !== null,
      configSource: this.configSource,
      pipelineCount: this.config?.pipelines.length || 0,
      validationCacheSize: this.validationCache.size,
      watcherActive: this.watcher !== null
    };
  }

  /**
   * Load configuration from file
   */
  private async loadFromFile(filePath: string): Promise<PipelineManagerConfig> {
    try {
      const configContent = await fs.readFile(filePath, 'utf-8');
      const config = JSON.parse(configContent);

      // Add file metadata
      const stats = await fs.stat(filePath);
      (config as any)._metadata = {
        sourceFile: filePath,
        lastModified: stats.mtime.getTime(),
        fileSize: stats.size
      };

      return config as PipelineManagerConfig;

    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      if ('code' in errorObj && (errorObj as any).code === 'ENOENT') {
        throw new Error(`Configuration file not found: ${filePath}`);
      }
      if (errorObj instanceof SyntaxError) {
        throw new Error(`Invalid JSON in configuration file: ${filePath}`);
      }
      throw errorObj;
    }
  }

  /**
   * Load configuration from URL
   */
  private async loadFromUrl(_url: string): Promise<PipelineManagerConfig> {
    // Would implement HTTP/HTTPS configuration loading here
    // For now, throw an error as this is not implemented
    throw new Error('URL configuration loading not implemented yet');
  }

  /**
   * Validate basic configuration structure
   */
  private validateBasicStructure(
    config: PipelineManagerConfig,
    errors: string[],
    _warnings: string[]
  ): void {
    if (!config.pipelines || !Array.isArray(config.pipelines)) {
      errors.push('Configuration must contain a pipelines array');
      return;
    }

    if (config.pipelines.length === 0) {
      _warnings.push('No pipelines configured - at least one pipeline is recommended');
    }
  }

  /**
   * Validate pipeline configurations
   */
  private validatePipelines(
    config: PipelineManagerConfig,
    errors: string[],
    _warnings: string[]
  ): void {
    const pipelineIds = new Set<string>();

    config.pipelines.forEach((pipeline, index) => {
      if (!pipeline.id) {
        errors.push(`Pipeline at index ${index} must have an ID`);
        return;
      }

      if (pipelineIds.has(pipeline.id)) {
        errors.push(`Duplicate pipeline ID: ${pipeline.id}`);
        return;
      }

      pipelineIds.add(pipeline.id);

      // Validate individual pipeline
      const pipelineErrors = this.validatePipelineConfiguration(pipeline);
      errors.push(...pipelineErrors);
    });
  }

  /**
   * Validate module configurations
   */
  private validateModules(
    config: PipelineManagerConfig,
    errors: string[],
    _warnings: string[]
  ): void {
    config.pipelines.forEach(pipeline => {
      const modules = pipeline.modules;

      if (!modules.llmSwitch) {
        errors.push(`Pipeline ${pipeline.id} must have llmSwitch module configuration`);
      }


      if (!modules.provider) {
        errors.push(`Pipeline ${pipeline.id} must have provider module configuration`);
      }

      // Validate module types (presence only; concrete availability is runtime-registered by ModuleRegistry)
      Object.entries(modules).forEach(([moduleType, moduleConfig]) => {
        if (!moduleConfig.type) {
          errors.push(`Pipeline ${pipeline.id} ${moduleType} module must have a type`);
        }
      });
    });
  }

  /**
   * Validate provider configurations
   */
  private validateProviders(
    config: PipelineManagerConfig,
    errors: string[],
    _warnings: string[]
  ): void {
    config.pipelines.forEach(pipeline => {
      const provider = pipeline.provider;

      if (!provider.type) {
        errors.push(`Pipeline ${pipeline.id} provider must have a type`);
        return;
      }

      if (!provider.baseUrl) {
        errors.push(`Pipeline ${pipeline.id} provider must have a baseUrl`);
      }

      if (!provider.auth) {
        errors.push(`Pipeline ${pipeline.id} provider must have auth configuration`);
        return;
      }

      const auth = provider.auth;
      if (!auth.type) {
        errors.push(`Pipeline ${pipeline.id} provider auth must have a type`);
      }

      if (auth.type === 'apikey' && !auth.apiKey) {
        errors.push(`Pipeline ${pipeline.id} provider API key auth requires apiKey`);
      }

      if (auth.type === 'oauth' && !auth.clientId) {
        errors.push(`Pipeline ${pipeline.id} provider OAuth auth requires clientId`);
      }
    });
  }

  /**
   * Validate individual pipeline configuration
   */
  private validatePipelineConfiguration(pipeline: PipelineConfig): string[] {
    const errors: string[] = [];

    if (!pipeline.id || typeof pipeline.id !== 'string') {
      errors.push('Pipeline ID must be a non-empty string');
    }

    if (!pipeline.provider || typeof pipeline.provider !== 'object') {
      errors.push('Pipeline must have a provider configuration');
    }

    if (!pipeline.modules || typeof pipeline.modules !== 'object') {
      errors.push('Pipeline must have a modules configuration');
    }

    return errors;
  }

  /**
   * Generate configuration cache key
   */
  private generateConfigKey(config: PipelineManagerConfig): string {
    const configString = JSON.stringify({
      pipelines: config.pipelines.map(p => ({
        id: p.id,
        provider: p.provider.type,
        modules: Object.keys(p.modules)
      }))
    });

    // Simple hash function
    let hash = 0;
    for (let i = 0; i < configString.length; i++) {
      const char = configString.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }

    return Math.abs(hash).toString(36);
  }

  /**
   * Start configuration watcher
   */
  private async startConfigWatcher(): Promise<void> {
    if (!this.configSource || this.configSource.type !== 'file') {
      return;
    }

    // Would implement file system watcher here
    // For now, just log that watcher would be started
    this.logger.logModule('config-manager', 'watcher-started', {
      configFile: this.configSource.location
    });
  }
}
