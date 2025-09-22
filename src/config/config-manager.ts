/**
 * RouteCodex Configuration Manager
 * Main configuration management interface that ties together all configuration components
 */

import { EventEmitter } from 'events';
import type { RouteCodexConfig, ConfigManager as IConfigManager, ConfigEvents, ConfigProvider } from './config-types';
import { ConfigLoader } from './config-loader';
import { ConfigValidator } from './config-validator';
import { ErrorHandlingUtils } from '../utils/error-handling-utils';

/**
 * Main configuration manager implementing the ConfigManager interface
 */
export class ConfigManager extends EventEmitter implements IConfigManager {
  private loader: ConfigLoader;
  private validator: ConfigValidator;
  private _config: RouteCodexConfig | null = null;
  private isInitialized: boolean = false;
  private watchers: Set<() => void> = new Set();
  private errorUtils: ReturnType<typeof ErrorHandlingUtils.createModuleErrorHandler>;

  constructor(configPath?: string) {
    super();
    this.loader = new ConfigLoader(configPath);
    this.validator = new ConfigValidator();
    this.errorUtils = ErrorHandlingUtils.createModuleErrorHandler('config-manager');
    this.registerErrorHandlers();
    this.setupEventHandlers();
  }

  /**
   * Register error handlers
   */
  private registerErrorHandlers(): void {
    this.errorUtils.registerMessage(
      'config_init_failed',
      'Failed to initialize configuration manager: {error}',
      'critical',
      'config',
      'Configuration manager initialization failed',
      'Check configuration file and permissions'
    );

    this.errorUtils.registerMessage(
      'config_update_failed',
      'Failed to update configuration: {error}',
      'high',
      'config',
      'Configuration update failed',
      'Check update parameters and validation rules'
    );

    this.errorUtils.registerMessage(
      'config_save_failed',
      'Failed to save configuration: {error}',
      'medium',
      'config',
      'Configuration save failed',
      'Check file permissions and disk space'
    );

    this.errorUtils.registerMessage(
      'config_not_initialized',
      'Configuration manager not initialized',
      'medium',
      'config',
      'Configuration manager has not been initialized',
      'Call initialize() before using configuration methods'
    );
  }

  /**
   * Setup event handlers for the configuration loader
   */
  private setupEventHandlers(): void {
    this.loader.on('loaded', (config: RouteCodexConfig) => {
      this._config = config;
      this.emit('loaded', config);
    });

    this.loader.on('changed', (config: RouteCodexConfig) => {
      this.handleConfigChange(config);
    });

    this.loader.on('saved', (config: RouteCodexConfig) => {
      this._config = config;
      this.emit('saved', config);
    });
  }

  /**
   * Handle configuration changes from file watching
   */
  private async handleConfigChange(newConfig: RouteCodexConfig): Promise<void> {
    try {
      const validation = await this.validator.validate(newConfig);

      if (validation.valid) {
        const oldConfig = this._config;
        this._config = newConfig;

        // Calculate changes for event
        const changes = this.calculateChanges(oldConfig, newConfig);

        this.emit('updated', newConfig, changes);
        this.emit('validated', newConfig, true, []);
      } else {
        this.emit('validated', newConfig, false, validation.errors);

        await this.errorUtils.handle(
          new Error(`Configuration validation failed: ${validation.errors.join(', ')}`),
          'handleConfigChange',
          {
            additionalContext: {
              context: 'Configuration file change validation',
              errors: validation.errors
            }
          }
        );
      }
    } catch (error) {
      await this.errorUtils.handle(error as Error, 'handleConfigChange', {
        additionalContext: {
          context: 'Configuration change handling'
        }
      });
    }
  }

  /**
   * Calculate changes between old and new configuration
   */
  private calculateChanges(oldConfig: RouteCodexConfig | null, newConfig: RouteCodexConfig): Partial<RouteCodexConfig> {
    if (!oldConfig) {
      return { ...newConfig }; // Return a copy of everything as new
    }

    const changes: Partial<RouteCodexConfig> = {};
    const oldString = JSON.stringify(oldConfig);
    const newString = JSON.stringify(newConfig);

    if (oldString === newString) {
      return changes; // No changes
    }

    // Simple change detection - in a real implementation, you'd want deep diff
    for (const key of Object.keys(newConfig)) {
      const oldSection = oldConfig[key as keyof RouteCodexConfig];
      const newSection = newConfig[key as keyof RouteCodexConfig];

      if (JSON.stringify(oldSection) !== JSON.stringify(newSection)) {
        (changes as any)[key as keyof RouteCodexConfig] = newSection;
      }
    }

    return changes;
  }

  /**
   * Initialize the configuration manager
   */
  async initialize(): Promise<void> {
    try {
      // Load initial configuration
      this._config = await this.loader.load();

      // Validate initial configuration
      const validation = await this.validator.validate(this._config);

      if (!validation.valid) {
        await this.errorUtils.handle(
          new Error(`Initial configuration validation failed: ${validation.errors.join(', ')}`),
          'initialize',
          {
            additionalContext: {
              context: 'Configuration manager initialization',
              errors: validation.errors
            }
          }
        );

        throw new Error(`Configuration validation failed: ${validation.errors.join(', ')}`);
      }

      this.isInitialized = true;
      this.emit('initialized', this._config);
      this.emit('validated', this._config, true, []);

      // Start file watching for hot-reload
      const unwatch = await this.loader.watch();
      if (unwatch) {
        this.watchers.add(unwatch);
      }
    } catch (error) {
      await this.errorUtils.handle(error as Error, 'initialize', {
        additionalContext: {
          context: 'Configuration manager initialization'
        }
      });

      throw error;
    }
  }

  /**
   * Get current configuration
   */
  get config(): RouteCodexConfig {
    if (!this.isInitialized || !this._config) {
      throw new Error('Configuration manager not initialized');
    }
    return this._config;
  }

  /**
   * Load configuration from file
   */
  async load(path?: string): Promise<RouteCodexConfig> {
    try {
      const config = await this.loader.load();
      this._config = config;
      return config;
    } catch (error) {
      await this.errorUtils.handle(error as Error, 'load', {
        additionalContext: {
          context: 'Configuration loading',
          path
        }
      });

      throw error;
    }
  }

  /**
   * Save configuration to file
   */
  async save(path?: string): Promise<void> {
    if (!this.isInitialized || !this._config) {
      throw new Error('Configuration manager not initialized');
    }

    try {
      await this.loader.save(this._config, path);
    } catch (error) {
      await this.errorUtils.handle(error as Error, 'save', {
        additionalContext: {
          context: 'Configuration saving',
          path
        }
      });

      throw error;
    }
  }

  /**
   * Validate configuration
   */
  async validate(config?: RouteCodexConfig): Promise<boolean> {
    const configToValidate = config || this._config;

    if (!configToValidate) {
      throw new Error('No configuration to validate');
    }

    try {
      const result = await this.validator.validate(configToValidate);
      this.emit('validated', configToValidate, result.valid, result.errors);
      return result.valid;
    } catch (error) {
      await this.errorUtils.handle(error as Error, 'validate', {
        additionalContext: {
          context: 'Configuration validation'
        }
      });

      return false;
    }
  }

  /**
   * Update configuration with partial changes
   */
  async update(updates: Partial<RouteCodexConfig>): Promise<void> {
    if (!this.isInitialized || !this._config) {
      throw new Error('Configuration manager not initialized');
    }

    try {
      // Create new configuration by merging updates
      const newConfig = this.mergeConfig(this._config, updates);

      // Validate new configuration
      const validation = await this.validator.validate(newConfig);

      if (!validation.valid) {
        await this.errorUtils.handle(
          new Error(`Configuration update validation failed: ${validation.errors.join(', ')}`),
          'update',
          {
            additionalContext: {
              context: 'Configuration update',
              updates,
              errors: validation.errors
            }
          }
        );

        throw new Error(`Configuration validation failed: ${validation.errors.join(', ')}`);
      }

      // Update internal configuration
      const oldConfig = this._config;
      this._config = newConfig;

      // Calculate changes for event
      const changes = this.calculateChanges(oldConfig, newConfig);

      // Emit events
      this.emit('updated', newConfig, changes);
      this.emit('validated', newConfig, true, []);

      // Optionally save to file
      try {
        await this.save();
      } catch (saveError) {
        console.warn('Failed to save configuration after update:', saveError);
      }
    } catch (error) {
      await this.errorUtils.handle(error as Error, 'update', {
        additionalContext: {
          context: 'Configuration update',
          updates
        }
      });

      throw error;
    }
  }

  /**
   * Watch configuration file for changes
   */
  watch(callback: (config: RouteCodexConfig) => void): () => void {
    if (!this.isInitialized) {
      throw new Error('Configuration manager not initialized');
    }

    // Add callback to listeners
    this.on('updated', callback);

    // Return function to remove the listener
    return () => {
      this.off('updated', callback);
    };
  }

  /**
   * Get configuration section
   */
  get<K extends keyof RouteCodexConfig>(key: K): RouteCodexConfig[K] {
    if (!this.isInitialized || !this._config) {
      throw new Error('Configuration manager not initialized');
    }

    return this._config[key];
  }

  /**
   * Set configuration section
   */
  set<K extends keyof RouteCodexConfig>(key: K, value: RouteCodexConfig[K]): void {
    if (!this.isInitialized || !this._config) {
      throw new Error('Configuration manager not initialized');
    }

    this._config[key] = value;
    this.emit('sectionUpdated', key, value);
  }

  /**
   * Reset configuration to default
   */
  reset(): void {
    if (!this.isInitialized) {
      throw new Error('Configuration manager not initialized');
    }

    // Create default configuration
    const defaultConfig = this.createDefaultConfig();
    this._config = defaultConfig;

    this.emit('reset', defaultConfig);
    this.emit('updated', defaultConfig, defaultConfig);
  }

  /**
   * Create default configuration
   */
  private createDefaultConfig(): RouteCodexConfig {
    return {
      version: '1.0.0',
      environment: 'development',
      debug: false,
      logLevel: 'info',
      server: {
        host: '0.0.0.0',
        port: 3000,
        cors: {
          enabled: true,
          origin: '*',
          credentials: true,
          methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
          allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
        },
        rateLimit: {
          enabled: true,
          windowMs: 60000,
          max: 100,
          skipSuccessfulRequests: false,
          skipFailedRequests: false
        },
        compression: {
          enabled: true,
          threshold: 1024
        },
        timeout: {
          request: 30000,
          response: 30000,
          keepAlive: 5000
        }
      },
      providers: {},
      routing: {
        strategy: 'round-robin',
        defaultProvider: undefined,
        fallbackProvider: undefined,
        rules: [],
        loadBalancing: {
          enabled: true,
          algorithm: 'round-robin',
          weights: {},
          healthCheck: {
            enabled: true,
            interval: 30000,
            timeout: 5000,
            unhealthyThreshold: 3,
            healthyThreshold: 2
          }
        }
      },
      dynamicRouting: {
        enabled: false,
        categories: {
          default: {
            targets: []
          },
          longcontext: {
            enabled: false,
            targets: []
          },
          thinking: {
            enabled: false,
            targets: []
          },
          background: {
            enabled: false,
            targets: []
          },
          websearch: {
            enabled: false,
            targets: []
          },
          vision: {
            enabled: false,
            targets: []
          },
          coding: {
            enabled: false,
            targets: []
          }
        }
      },
      security: {
        authentication: {
          enabled: false,
          type: 'api-key'
        },
        authorization: {
          enabled: false,
          type: 'rbac',
          rules: []
        },
        encryption: {
          enabled: false,
          algorithm: 'aes-256-gcm',
          keyRotationDays: 90
        },
        rateLimit: {
          enabled: true,
          requests: 100,
          windowMs: 60000,
          skipSuccessfulRequests: false,
          skipFailedRequests: false
        },
        cors: {
          enabled: true,
          origin: '*',
          credentials: true,
          methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
          allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
          exposedHeaders: [],
          maxAge: 86400
        }
      },
      monitoring: {
        enabled: true,
        metrics: {
          enabled: true,
          endpoint: '/metrics',
          interval: 10000
        },
        logging: {
          level: 'info',
          format: 'json',
          outputs: [
            { type: 'console', config: {} }
          ]
        },
        tracing: {
          enabled: false,
          sampler: 1.0,
          exporter: 'console'
        },
        health: {
          enabled: true,
          endpoint: '/health',
          detailed: true
        }
      },
      cache: {
        enabled: false,
        type: 'memory',
        ttl: 300000,
        maxSize: 1000,
        compression: false
      },
      modules: {}
    };
  }

  /**
   * Merge configurations
   */
  private mergeConfig(base: RouteCodexConfig, override: Partial<RouteCodexConfig>): RouteCodexConfig {
    return {
      ...base,
      ...override,
      server: {
        ...base.server,
        ...override.server
      },
      providers: {
        ...base.providers,
        ...override.providers
      },
      routing: {
        ...base.routing,
        ...override.routing
      },
      dynamicRouting: {
        ...base.dynamicRouting,
        ...override.dynamicRouting
      },
      security: {
        ...base.security,
        ...override.security
      },
      monitoring: {
        ...base.monitoring,
        ...override.monitoring
      },
      cache: {
        ...base.cache,
        ...override.cache
      },
      modules: {
        ...base.modules,
        ...override.modules
      }
    };
  }

  /**
   * Get configuration status
   */
  getStatus(): {
    isInitialized: boolean;
    configPath: string;
    hasConfig: boolean;
    configVersion?: string;
    environment?: string;
  } {
    return {
      isInitialized: this.isInitialized,
      configPath: this.loader.getConfigPath(),
      hasConfig: this._config !== null,
      configVersion: this._config?.version,
      environment: this._config?.environment
    };
  }

  /**
   * Validate specific configuration section
   */
  async validateSection<K extends keyof RouteCodexConfig>(
    section: K
  ): Promise<{ valid: boolean; errors: string[] }> {
    if (!this.isInitialized || !this._config) {
      throw new Error('Configuration manager not initialized');
    }

    return this.validator.validateSection(this._config, section);
  }

  /**
   * Get configuration schema for documentation
   */
  getSchema() {
    return this.validator.getSchema();
  }

  /**
   * Add custom validator
   */
  addCustomValidator(
    name: string,
    validate: (config: RouteCodexConfig) => boolean | Promise<boolean>,
    message: string
  ): void {
    this.validator.addCustomValidator(name, validate, message);
  }

  /**
   * Remove custom validator
   */
  removeCustomValidator(name: string): void {
    this.validator.removeCustomValidator(name);
  }

  /**
   * Register configuration provider
   */
  registerProvider(provider: ConfigProvider): void {
    this.loader.registerProvider(provider);
  }

  /**
   * Close configuration manager and cleanup resources
   */
  async close(): Promise<void> {
    try {
      // Remove all file watchers
      for (const unwatch of this.watchers) {
        unwatch();
      }
      this.watchers.clear();

      // Close loader
      await this.loader.close();

      // Remove all event listeners
      this.removeAllListeners();

      this.isInitialized = false;
      this._config = null;
    } catch (error) {
      await this.errorUtils.handle(error as Error, 'close', {
        additionalContext: {
          context: 'Configuration manager cleanup'
        }
      });

      throw error;
    }
  }
}

// Type assertion to ensure ConfigManager implements IConfigManager
const _assertImplements: IConfigManager = new ConfigManager();