/**
 * Configuration Manager
 * Manages loading, validation, and runtime configuration updates
 */

import { BaseModule, type ModuleInfo } from './base-module.js';
import { DebugEventBus } from '../utils/external-mocks.js';
import { ErrorHandlingCenter, type ErrorContext } from 'rcc-errorhandling';
import {
  type ServerConfig,
  type ProviderConfig,
  type ModelConfig,
  RouteCodexError
} from '../server/types.js';
import path from 'path';
import fs from 'fs';

/**
 * Configuration validation result
 */
export interface ConfigValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  config?: ServerConfig;
}

/**
 * Configuration change event
 */
export interface ConfigChangeEvent {
  type: 'added' | 'removed' | 'modified';
  path: string;
  oldValue?: any;
  newValue?: any;
  timestamp: number;
}

/**
 * Configuration Manager class
 */
export class ConfigManager extends BaseModule {
  private _config: ServerConfig;
  private configPath: string;
  private errorHandling: ErrorHandlingCenter;
  private watchers: fs.FSWatcher[] = [];
  private validationCache: Map<string, ConfigValidationResult> = new Map();
  private changeCallbacks: Set<(event: ConfigChangeEvent) => void> = new Set();

  // Expose config for compatibility with new configuration system
  public get config(): ServerConfig {
    return { ...this._config };
  }

  constructor(configPath: string, initialConfig?: Partial<ServerConfig>) {
    const moduleInfo: ModuleInfo = {
      id: 'config-manager',
      name: 'ConfigManager',
      version: '0.0.1',
      description: 'Configuration management for RouteCodex server'
    };

    super(moduleInfo);

    this.configPath = configPath;
    this.errorHandling = new ErrorHandlingCenter();
    this.debugEventBus = DebugEventBus.getInstance();

    // Initialize with default config
    this._config = this.mergeWithDefaults(initialConfig || {});
  }

  /**
   * Initialize the configuration manager
   */
  public async initialize(): Promise<void> {
    try {
      // Load configuration from file
      await this.loadConfiguration();

      // Validate configuration
      const validation = this.validateConfiguration();
      if (!validation.isValid) {
        throw new Error(`Configuration validation failed: ${validation.errors.join(', ')}`);
      }

      // Start file watching if enabled
      this.startFileWatching();

      // Log initialization
      this.debugEventBus?.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.getModuleInfo().id,
        operationId: 'config_initialized',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          configPath: this.configPath,
          validation: validation
        }
      });

      // Record initialization metric
      this.recordModuleMetric('initialization', {
        configPath: this.configPath,
        providersCount: Object.keys(this._config.providers).length,
        validationErrors: validation.errors.length,
        validationWarnings: validation.warnings.length
      });

    } catch (error) {
      await this.handleError(error as Error, 'initialization');
      throw error;
    }
  }

  /**
   * Load configuration from file
   */
  private async loadConfiguration(): Promise<void> {
    try {
      if (!fs.existsSync(this.configPath)) {
        // Create default configuration
        await this.createDefaultConfiguration();
      }

      const configData = fs.readFileSync(this.configPath, 'utf8');
      const loadedConfig = JSON.parse(configData);

      // Merge with existing configuration
      this._config = this.mergeWithDefaults(loadedConfig);

      this.debugEventBus?.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.getModuleInfo().id,
        operationId: 'config_loaded',
        timestamp: Date.now(),
        type: 'end',
        position: 'middle',
        data: {
          configPath: this.configPath,
          providers: Object.keys(this._config.providers),
          server: this._config.server
        }
      });

      // Record config loading metric
      this.recordModuleMetric('config_load', {
        configPath: this.configPath,
        providersCount: Object.keys(this._config.providers).length,
        fileSize: fs.existsSync(this.configPath) ? fs.statSync(this.configPath).size : 0
      });

    } catch (error) {
      await this.handleError(error as Error, 'load_configuration');
      throw error;
    }
  }

  /**
   * Create default configuration file
   */
  private async createDefaultConfiguration(): Promise<void> {
    const defaultConfig: ServerConfig = {
      server: {
        port: 5506,
        host: 'localhost',
        cors: {
          origin: '*',
          credentials: true
        },
        timeout: 30000,
        bodyLimit: '10mb'
      },
      logging: {
        level: 'info',
        enableConsole: true,
        enableFile: true,
        filePath: '~/.routecodex/logs/routecodex.log',
        categories: ['server', 'api', 'request', 'config', 'error', 'message'],
        categoryPath: '~/.routecodex/logs'
      },
      providers: {},
      routing: {
        strategy: 'round-robin',
        timeout: 30000,
        retryAttempts: 3
      }
    };

    // Create directory if it doesn't exist
    const configDir = path.dirname(this.configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    fs.writeFileSync(this.configPath, JSON.stringify(defaultConfig, null, 2));
    this._config = defaultConfig;

    this.debugEventBus?.publish({
      sessionId: `session_${Date.now()}`,
      moduleId: this.getModuleInfo().id,
      operationId: 'default_config_created',
      timestamp: Date.now(),
      type: 'end',
      position: 'middle',
      data: {
        configPath: this.configPath
      }
    });
  }

  /**
   * Merge configuration with defaults
   */
  private mergeWithDefaults(config: Partial<ServerConfig>): ServerConfig {
    const defaults: ServerConfig = {
      server: {
        port: 5506,
        host: 'localhost',
        cors: {
          origin: '*',
          credentials: true
        },
        timeout: 30000,
        bodyLimit: '10mb'
      },
      logging: {
        level: 'info',
        enableConsole: true,
        enableFile: false,
        categories: ['server', 'api', 'request', 'config', 'error', 'message']
      },
      providers: {},
      routing: {
        strategy: 'round-robin',
        timeout: 30000,
        retryAttempts: 3
      }
    };

    return {
      server: { ...defaults.server, ...config.server },
      logging: { ...defaults.logging, ...config.logging },
      providers: config.providers || defaults.providers,
      routing: { ...defaults.routing, ...config.routing, strategy: config.routing?.strategy || (defaults.routing?.strategy || 'round-robin') }
    };
  }

  /**
   * Validate configuration
   */
  public validateConfiguration(): ConfigValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate server configuration
    if (!this._config.server.port || this._config.server.port < 1 || this._config.server.port > 65535) {
      errors.push('Server port must be between 1 and 65535');
    }

    if (!this._config.server.host || typeof this._config.server.host !== 'string') {
      errors.push('Server host must be a valid string');
    }

    // Validate logging configuration
    const validLogLevels = ['debug', 'info', 'warn', 'error'];
    if (!validLogLevels.includes(this._config.logging.level)) {
      errors.push(`Log level must be one of: ${validLogLevels.join(', ')}`);
    }

    // Validate providers
    for (const [providerId, providerConfig] of Object.entries(this._config.providers)) {
      if (!providerConfig || typeof providerConfig !== 'object') {
        errors.push(`Provider '${providerId}' must be a valid configuration object`);
        continue;
      }

      if (providerConfig.enabled === undefined) {
        warnings.push(`Provider '${providerId}' should specify 'enabled' field`);
      }

      if (providerConfig.models && typeof providerConfig.models === 'object') {
        for (const [modelId, modelConfig] of Object.entries(providerConfig.models)) {
          if (!modelConfig || typeof modelConfig !== 'object') {
            errors.push(`Model '${modelId}' in provider '${providerId}' must be a valid configuration object`);
            continue;
          }

          if (modelConfig && 'maxTokens' in modelConfig && modelConfig.maxTokens !== null && typeof modelConfig.maxTokens === 'number' && (modelConfig.maxTokens === undefined || modelConfig.maxTokens < 1)) {
            errors.push(`Model '${modelId}' must have a valid maxTokens value > 0`);
          }
        }
      }
    }

    const result: ConfigValidationResult = {
      isValid: errors.length === 0,
      errors,
      warnings,
      config: this._config
    };

    // Cache validation result
    this.validationCache.set(this.configPath, result);

    return result;
  }

  /**
   * Start file watching for configuration changes
   */
  private startFileWatching(): void {
    if (!fs.existsSync(this.configPath)) {
      return;
    }

    try {
      const watcher = fs.watch(this.configPath, async (eventType: string) => {
        if (eventType === 'change') {
          try {
            await this.handleConfigChange();
          } catch (error) {
            await this.handleError(error as Error, 'file_watching');
          }
        }
      });

      this.watchers.push(watcher);

      this.debugEventBus?.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.getModuleInfo().id,
        operationId: 'file_watching_started',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          configPath: this.configPath
        }
      });

    } catch (error) {
      this.debugEventBus?.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.getModuleInfo().id,
        operationId: 'file_watching_failed',
        timestamp: Date.now(),
        type: 'error',
        position: 'middle',
        data: {
          error: error instanceof Error ? error.message : String(error),
          configPath: this.configPath
        }
      });
    }
  }

  /**
   * Handle configuration file changes
   */
  private async handleConfigChange(): Promise<void> {
    try {
      const oldConfig = { ...this._config };
      await this.loadConfiguration();

      const validation = this.validateConfiguration();
      if (!validation.isValid) {
        // Revert to old configuration
        this._config = oldConfig;
        throw new Error(`Configuration validation failed: ${validation.errors.join(', ')}`);
      }

      // Notify listeners of changes
      this.notifyConfigChange('modified', '', oldConfig, this._config);

      this.debugEventBus?.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.getModuleInfo().id,
        operationId: 'config_reloaded',
        timestamp: Date.now(),
        type: 'end',
        position: 'middle',
        data: {
          validation: validation
        }
      });

    } catch (error) {
      await this.handleError(error as Error, 'config_change');
    }
  }

  /**
   * Get current configuration
   */
  public getConfiguration(): ServerConfig {
    return { ...this._config };
  }

  /**
   * Get provider configuration
   */
  public getProviderConfig(providerId: string): ProviderConfig | undefined {
    const providerConfig = this._config.providers[providerId];
    if (!providerConfig) {
      return undefined;
    }

    return {
      id: providerId,
      type: providerConfig.type || 'custom',
      enabled: providerConfig.enabled !== false,
      baseUrl: providerConfig.baseUrl,
      apiKey: providerConfig.apiKey,
      models: providerConfig.models || {},
      rateLimit: providerConfig.rateLimit,
      timeout: providerConfig.timeout,
      retryAttempts: providerConfig.retryAttempts,
      weight: providerConfig.weight,
      headers: providerConfig.headers
    };
  }

  /**
   * Get model configuration
   */
  public getModelConfig(providerId: string, modelId: string): ModelConfig | undefined {
    const providerConfig = this.getProviderConfig(providerId);
    if (!providerConfig) {
      return undefined;
    }

    const modelConfig = providerConfig.models[modelId];
    if (!modelConfig) {
      return undefined;
    }

    return {
      id: modelId,
      maxTokens: modelConfig.maxTokens || 4096,
      temperature: modelConfig.temperature,
      topP: modelConfig.topP,
      enabled: modelConfig.enabled !== false,
      costPer1kTokens: modelConfig.costPer1kTokens,
      supportsStreaming: modelConfig.supportsStreaming !== false,
      supportsTools: modelConfig.supportsTools !== false,
      supportsVision: modelConfig.supportsVision,
      contextWindow: modelConfig.contextWindow
    };
  }

  /**
   * Update configuration
   */
  public async updateConfiguration(updates: Partial<ServerConfig>): Promise<void> {
    try {
      const oldConfig = { ...this._config };

      // Apply updates
      this._config = this.mergeWithDefaults({ ...this._config, ...updates });

      // Validate new configuration
      const validation = this.validateConfiguration();
      if (!validation.isValid) {
        this._config = oldConfig;
        throw new Error(`Configuration validation failed: ${validation.errors.join(', ')}`);
      }

      // Save to file
      fs.writeFileSync(this.configPath, JSON.stringify(this._config, null, 2));

      // Notify listeners
      this.notifyConfigChange('modified', '', oldConfig, this._config);

      this.debugEventBus?.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.getModuleInfo().id,
        operationId: 'config_updated',
        timestamp: Date.now(),
        type: 'end',
        position: 'middle',
        data: {
          validation: validation
        }
      });

      // Record config update metric
      this.recordModuleMetric('config_update', {
        configPath: this.configPath,
        validationErrors: validation.errors.length,
        validationWarnings: validation.warnings.length,
        updateFields: Object.keys(updates).length
      });

    } catch (error) {
      await this.handleError(error as Error, 'update_configuration');
      throw error;
    }
  }

  /**
   * Add configuration change listener
   */
  public onConfigChange(callback: (event: ConfigChangeEvent) => void): void {
    this.changeCallbacks.add(callback);
  }

  /**
   * Remove configuration change listener
   */
  public offConfigChange(callback: (event: ConfigChangeEvent) => void): void {
    this.changeCallbacks.delete(callback);
  }

  /**
   * Notify listeners of configuration changes
   */
  private notifyConfigChange(type: ConfigChangeEvent['type'], path: string, oldValue: any, newValue: any): void {
    const event: ConfigChangeEvent = {
      type,
      path,
      oldValue,
      newValue,
      timestamp: Date.now()
    };

    this.changeCallbacks.forEach(callback => {
      try {
        callback(event);
      } catch (error) {
        console.error('Config change callback error:', error);
      }
    });
  }

  /**
   * Handle error
   */
  protected async handleError(error: Error, context: string): Promise<void> {
    try {
      const errorContext: ErrorContext = {
        error: error.message,
        source: `${this.getModuleInfo().id}.${context}`,
        severity: 'medium',
        timestamp: Date.now(),
        moduleId: this.getModuleInfo().id,
        context: {
          stack: error.stack,
          name: error.name,
          configPath: this.configPath
        }
      };

      await this.errorHandling.handleError(errorContext);
    } catch (handlerError) {
      console.error('Failed to handle error:', handlerError);
      console.error('Original error:', error);
    }
  }

  /**
   * Stop configuration manager
   */
  public async stop(): Promise<void> {
    // Stop file watchers
    this.watchers.forEach(watcher => {
      try {
        watcher.close();
      } catch (error) {
        console.error('Error closing file watcher:', error);
      }
    });
    this.watchers = [];

    // Clear callbacks
    this.changeCallbacks.clear();

    // Clear cache
    this.validationCache.clear();

    await this.errorHandling.destroy();
  }

  /**
   * Get debug status with enhanced information
   */
  getDebugStatus(): any {
    const baseStatus = {
      configManagerId: this.getInfo().id,
      name: this.getInfo().name,
      version: this.getInfo().version,
      isInitialized: this.getStatus() !== 'stopped',
      isRunning: this.isModuleRunning(),
      status: this.getStatus(),
      configPath: this.configPath,
      providersCount: Object.keys(this._config.providers).length,
      validationCacheSize: this.validationCache.size,
      fileWatchersActive: this.watchers.length > 0,
      isEnhanced: true
    };

    if (!this.isDebugEnhanced) {
      return baseStatus;
    }

    return {
      ...baseStatus,
      debugInfo: this.getDebugInfo(),
      configMetrics: this.getConfigMetrics(),
      validationHistory: [...this.validationCache.entries()].slice(-5), // Last 5 validations
      configStats: this.getConfigStats()
    };
  }

  /**
   * Get configuration metrics
   */
  private getConfigMetrics(): any {
    const metrics: any = {};

    for (const [operation, metric] of this.moduleMetrics.entries()) {
      metrics[operation] = {
        count: metric.values.length,
        lastUpdated: metric.lastUpdated,
        recentValues: metric.values.slice(-5) // Last 5 values
      };
    }

    return metrics;
  }

  /**
   * Get configuration statistics
   */
  private getConfigStats(): any {
    const providers = Object.values(this._config.providers);
    const enabledProviders = providers.filter(p => p.enabled !== false);
    const totalModels = providers.reduce((sum, p) => sum + Object.keys(p.models || {}).length, 0);

    return {
      totalProviders: providers.length,
      enabledProviders: enabledProviders.length,
      totalModels: totalModels,
      configFileSize: fs.existsSync(this.configPath) ? fs.statSync(this.configPath).size : 0,
      lastValidation: this.validationCache.get(this.configPath),
      watchersActive: this.watchers.length,
      changeCallbacks: this.changeCallbacks.size
    };
  }

  /**
   * Get detailed debug information
   */
  public getDebugInfo(): any {
    return {
      configManagerId: this.getInfo().id,
      name: this.getInfo().name,
      version: this.getInfo().version,
      enhanced: this.isDebugEnhanced,
      eventBusAvailable: !!this.debugEventBus,
      configPath: this.configPath,
      configFileSize: fs.existsSync(this.configPath) ? fs.statSync(this.configPath).size : 0,
      providersCount: Object.keys(this._config.providers).length,
      validationCacheSize: this.validationCache.size,
      fileWatchersActive: this.watchers.length > 0,
      changeCallbacks: this.changeCallbacks.size,
      uptime: this.isModuleRunning() ? Date.now() - (this.getStats().uptime || Date.now()) : 0
    };
  }

  /**
   * Get module info
   */
  public getModuleInfo(): ModuleInfo {
    return {
      id: 'config-manager',
      name: 'ConfigManager',
      version: '0.0.1',
      description: 'Configuration management for RouteCodex server'
    };
  }
}