/**
 * RouteCodex Configuration Loader
 * Handles loading configuration from various sources with validation and environment variable expansion
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { homedir } from 'os';
import { EventEmitter } from 'events';
import type {
  RouteCodexConfig,
  ConfigProvider,
  EnvironmentConfig,
  ConfigMigration,
} from './config-types';
import { ErrorHandlingUtils } from '../utils/error-handling-utils';
import { FileWatcher } from '../utils/file-watcher';

/**
 * Configuration loader with support for multiple sources and hot-reload
 */
export class ConfigLoader extends EventEmitter {
  private configPath: string;
  private config: RouteCodexConfig | null = null;
  private providers: Map<string, ConfigProvider> = new Map();
  private migrations: ConfigMigration[] = [];
  private envConfig: EnvironmentConfig;
  private watchers: Set<() => void> = new Set();
  private errorUtils: ReturnType<typeof ErrorHandlingUtils.createModuleErrorHandler>;

  constructor(configPath?: string) {
    super();
    this.configPath = configPath || this.getDefaultConfigPath();
    this.errorUtils = ErrorHandlingUtils.createModuleErrorHandler('config-loader');
    this.envConfig = this.createEnvironmentConfig();
    this.registerErrorHandlers();
  }

  /**
   * Get default configuration file path
   */
  private getDefaultConfigPath(): string {
    const possiblePaths = [
      process.env.ROUTECODEX_CONFIG,
      './routecodex.json',
      './config/routecodex.json',
      path.join(process.cwd(), 'routecodex.json'),
      path.join(homedir(), '.routecodex', 'config.json'),
      path.join(homedir(), '.routecodex', 'routecodex.json'),
    ];

    for (const configPath of possiblePaths) {
      if (configPath && fsSync.existsSync(configPath)) {
        return configPath;
      }
    }

    return './routecodex.json';
  }

  /**
   * Create environment configuration
   */
  private createEnvironmentConfig(): EnvironmentConfig {
    return {
      overrides: {
        development: {
          debug: true,
          logLevel: 'debug',
          monitoring: {
            enabled: true,
            metrics: {
              enabled: true,
              endpoint: '/metrics',
              interval: 10000,
            },
            logging: {
              level: 'debug',
              format: 'text',
              outputs: [{ type: 'console', config: {} }],
            },
            tracing: {
              enabled: false,
              sampler: 1.0,
              exporter: 'console',
            },
            health: {
              enabled: true,
              endpoint: '/health',
              detailed: true,
            },
          },
        },
        production: {
          debug: false,
          logLevel: 'warn',
          monitoring: {
            enabled: true,
            metrics: {
              enabled: true,
              endpoint: '/metrics',
              interval: 10000,
            },
            logging: {
              level: 'warn',
              format: 'json',
              outputs: [
                { type: 'console', config: {} },
                { type: 'file', config: { path: 'logs/routecodex.log' } },
              ],
            },
            tracing: {
              enabled: false,
              sampler: 1.0,
              exporter: 'console',
            },
            health: {
              enabled: true,
              endpoint: '/health',
              detailed: true,
            },
          },
        },
        test: {
          debug: true,
          logLevel: 'error',
          monitoring: {
            enabled: false,
            metrics: {
              enabled: false,
              endpoint: '/metrics',
              interval: 10000,
            },
            logging: {
              level: 'error',
              format: 'json',
              outputs: [{ type: 'console', config: {} }],
            },
            tracing: {
              enabled: false,
              sampler: 1.0,
              exporter: 'console',
            },
            health: {
              enabled: false,
              endpoint: '/health',
              detailed: true,
            },
          },
        },
      },
      variables: {
        ROUTECODEX_PORT: {
          type: 'number',
          required: false,
          default: 3000,
          description: 'Server port number',
        },
        ROUTECODEX_HOST: {
          type: 'string',
          required: false,
          default: '0.0.0.0',
          description: 'Server host address',
        },
        ROUTECODEX_DEBUG: {
          type: 'boolean',
          required: false,
          default: false,
          description: 'Enable debug mode',
        },
        ROUTECODEX_LOG_LEVEL: {
          type: 'string',
          required: false,
          default: 'info',
          description: 'Logging level',
        },
        ROUTECODEX_ENV: {
          type: 'string',
          required: false,
          default: 'development',
          description: 'Environment (development/production/test)',
        },
        OPENAI_API_KEY: {
          type: 'string',
          required: false,
          description: 'OpenAI API key for providers',
        },
        ANTHROPIC_API_KEY: {
          type: 'string',
          required: false,
          description: 'Anthropic API key for providers',
        },
      },
    };
  }

  /**
   * Register error handlers
   */
  private registerErrorHandlers(): void {
    this.errorUtils.registerMessage(
      'config_file_not_found',
      'Configuration file not found: {path}',
      'medium',
      'config',
      'The specified configuration file does not exist',
      'Check the file path or create a default configuration file'
    );

    this.errorUtils.registerMessage(
      'config_parse_error',
      'Failed to parse configuration file: {path}',
      'critical',
      'config',
      'Configuration file contains invalid JSON or YAML',
      'Validate the configuration file syntax'
    );

    this.errorUtils.registerMessage(
      'config_validation_error',
      'Configuration validation failed: {errors}',
      'critical',
      'config',
      'Configuration does not match the required schema',
      'Fix validation errors in the configuration file'
    );

    this.errorUtils.registerMessage(
      'config_load_error',
      'Failed to load configuration: {error}',
      'critical',
      'config',
      'Unable to load configuration from any source',
      'Check file permissions and path'
    );

    this.errorUtils.registerMessage(
      'config_watch_error',
      'Failed to watch configuration file for changes: {error}',
      'low',
      'config',
      'File system watcher encountered an error',
      'Restart the application to enable hot-reload'
    );
  }

  /**
   * Register a configuration provider
   */
  registerProvider(provider: ConfigProvider): void {
    this.providers.set(provider.name, provider);
    this.providers = new Map(
      [...this.providers.entries()].sort((a, b) => b[1].priority - a[1].priority)
    );
  }

  /**
   * Register a configuration migration
   */
  registerMigration(migration: ConfigMigration): void {
    this.migrations.push(migration);
    this.migrations.sort((a, b) => a.version.localeCompare(b.version));
  }

  /**
   * Load configuration from file or default
   */
  async load(): Promise<RouteCodexConfig> {
    try {
      let config = await this.loadFromFile(this.configPath);

      // Apply migrations if needed
      config = await this.applyMigrations(config);

      // Apply environment overrides
      config = this.applyEnvironmentOverrides(config);

      // Expand environment variables
      config = this.expandEnvironmentVariables(config);

      this.config = config;
      this.emit('loaded', config);

      return config;
    } catch (error) {
      await this.errorUtils.handle(error as Error, 'load');

      // Return default configuration on error
      return this.getDefaultConfig();
    }
  }

  /**
   * Load configuration from file
   */
  private async loadFromFile(filePath: string): Promise<RouteCodexConfig> {
    try {
      // Find appropriate provider for the file
      const provider = Array.from(this.providers.values()).find(p => p.canHandle(filePath));

      if (!provider) {
        throw new Error(`No provider found for file: ${filePath}`);
      }

      const config = await provider.load(filePath);
      this.emit('loaded', config);

      return config;
    } catch (err) {
      const error = err as Error & { code?: string };
      if (error.code === 'ENOENT') {
        // File doesn't exist, create default configuration
        const defaultConfig = this.getDefaultConfig();
        await this.saveConfig(filePath, defaultConfig);
        return defaultConfig;
      }
      throw error;
    }
  }

  /**
   * Apply migrations to configuration
   */
  private async applyMigrations(config: any): Promise<RouteCodexConfig> {
    let currentConfig = config;
    const configVersion = config.version || '0.0.0';

    for (const migration of this.migrations) {
      if (migration.version > configVersion) {
        console.log(`Applying migration ${migration.version}: ${migration.description}`);
        currentConfig = await migration.migrate(currentConfig);
      }
    }

    return currentConfig;
  }

  /**
   * Apply environment-specific overrides
   */
  private applyEnvironmentOverrides(config: RouteCodexConfig): RouteCodexConfig {
    const env = process.env.NODE_ENV || process.env.ROUTECODEX_ENV || 'development';
    const override = this.envConfig.overrides[env as keyof typeof this.envConfig.overrides];

    if (!override) {
      return config;
    }

    return this.mergeConfigs(config, override);
  }

  /**
   * Expand environment variables in configuration
   */
  private expandEnvironmentVariables(config: RouteCodexConfig): RouteCodexConfig {
    const configString = JSON.stringify(config);
    const expandedString = configString.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const envVar = this.envConfig.variables[varName];
      if (envVar) {
        const value = process.env[varName] || envVar.default;
        if (envVar.type === 'number' && value) {
          return String(Number(value));
        }
        if (envVar.type === 'boolean' && value) {
          return String(value === 'true' || value === '1');
        }
        return String(value || '');
      }
      return process.env[varName] || match;
    });

    try {
      return JSON.parse(expandedString);
    } catch (error) {
      console.warn('Failed to expand environment variables, using original config');
      return config;
    }
  }

  /**
   * Get default configuration
   */
  private getDefaultConfig(): RouteCodexConfig {
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
          allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
        },
        rateLimit: {
          enabled: true,
          windowMs: 60000,
          max: 100,
          skipSuccessfulRequests: false,
          skipFailedRequests: false,
        },
        compression: {
          enabled: true,
          threshold: 1024,
        },
        timeout: {
          request: 30000,
          response: 30000,
          keepAlive: 5000,
        },
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
            healthyThreshold: 2,
          },
        },
      },
      dynamicRouting: {
        enabled: false,
        categories: {
          default: {
            targets: [],
          },
          longcontext: {
            enabled: false,
            targets: [],
          },
          thinking: {
            enabled: false,
            targets: [],
          },
          background: {
            enabled: false,
            targets: [],
          },
          websearch: {
            enabled: false,
            targets: [],
          },
          vision: {
            enabled: false,
            targets: [],
          },
          coding: {
            enabled: false,
            targets: [],
          },
        },
      },
      security: {
        authentication: {
          enabled: false,
          type: 'api-key',
        },
        authorization: {
          enabled: false,
          type: 'rbac',
          rules: [],
        },
        encryption: {
          enabled: false,
          algorithm: 'aes-256-gcm',
          keyRotationDays: 90,
        },
        rateLimit: {
          enabled: true,
          requests: 100,
          windowMs: 60000,
          skipSuccessfulRequests: false,
          skipFailedRequests: false,
        },
        cors: {
          enabled: true,
          origin: '*',
          credentials: true,
          methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
          allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
          exposedHeaders: [],
          maxAge: 86400,
        },
      },
      monitoring: {
        enabled: true,
        metrics: {
          enabled: true,
          endpoint: '/metrics',
          interval: 10000,
        },
        logging: {
          level: 'info',
          format: 'json',
          outputs: [{ type: 'console', config: {} }],
        },
        tracing: {
          enabled: false,
          sampler: 1.0,
          exporter: 'console',
        },
        health: {
          enabled: true,
          endpoint: '/health',
          detailed: true,
        },
      },
      cache: {
        enabled: false,
        type: 'memory',
        ttl: 300000,
        maxSize: 1000,
        compression: false,
      },
      modules: {},
    };
  }

  /**
   * Merge two configurations
   */
  private mergeConfigs(
    base: RouteCodexConfig,
    override: Partial<RouteCodexConfig>
  ): RouteCodexConfig {
    return {
      ...base,
      ...override,
      server: {
        ...base.server,
        ...override.server,
      },
      providers: {
        ...base.providers,
        ...override.providers,
      },
      routing: {
        ...base.routing,
        ...override.routing,
      },
      dynamicRouting: {
        ...base.dynamicRouting,
        ...override.dynamicRouting,
      },
      security: {
        ...base.security,
        ...override.security,
      },
      monitoring: {
        ...base.monitoring,
        ...override.monitoring,
      },
      cache: {
        ...base.cache,
        ...override.cache,
      },
      modules: {
        ...base.modules,
        ...override.modules,
      },
    };
  }

  /**
   * Save configuration to file
   */
  async save(config: RouteCodexConfig, path?: string): Promise<void> {
    const filePath = path || this.configPath;
    await this.saveConfig(filePath, config);
    this.config = config;
    this.emit('saved', config);
  }

  /**
   * Save configuration using appropriate provider
   */
  private async saveConfig(filePath: string, config: RouteCodexConfig): Promise<void> {
    const provider = Array.from(this.providers.values()).find(p => p.canHandle(filePath));

    if (!provider) {
      throw new Error(`No provider found for file: ${filePath}`);
    }

    await provider.save(filePath, config);
  }

  /**
   * Watch configuration file for changes
   */
  async watch(): Promise<() => void> {
    if (this.watchers.size > 0) {
      // Already watching
      return () => this.stopWatching();
    }

    try {
      // Create file watcher for the configuration file
      const watcher = new FileWatcher(
        this.configPath,
        {
          interval: 1000,
          debounceMs: 250,
          persistent: true,
        },
        this.errorUtils
      );

      // Set up event handlers
      watcher.on('change', async event => {
        await this.handleConfigChange(event);
      });

      watcher.on('error', error => {
        console.error('Configuration file watcher error:', error);
      });

      // Start watching
      await watcher.start();

      // Store the watcher for cleanup
      const unwatch = () => {
        watcher.stop();
        watcher.removeAllListeners();
        this.watchers.delete(unwatch);
      };

      this.watchers.add(unwatch);

      return unwatch;
    } catch (error) {
      await this.errorUtils.handle(error as Error, 'watch', {
        additionalContext: {
          configPath: this.configPath,
          context: 'Configuration file watching setup',
        },
      });

      // Return a no-op function if watching fails
      return () => {};
    }
  }

  /**
   * Handle configuration file changes
   */
  private async handleConfigChange(
    event: import('../utils/file-watcher').FileChangeEvent
  ): Promise<void> {
    try {
      console.log(
        `Configuration file changed: ${event.eventType} at ${new Date(event.timestamp).toISOString()}`
      );

      // Reload configuration
      const newConfig = await this.load();

      // Update internal config
      this.config = newConfig;

      // Emit change event
      this.emit('changed', newConfig);

      console.log('Configuration reloaded successfully');
    } catch (error) {
      await this.errorUtils.handle(error as Error, 'handleConfigChange', {
        additionalContext: {
          event,
          configPath: this.configPath,
          context: 'Configuration file change handling',
        },
      });

      // Emit error event
      this.emit('error', error);
    }
  }

  /**
   * Stop watching all configuration files
   */
  private stopWatching(): void {
    for (const unwatch of this.watchers) {
      try {
        unwatch();
      } catch (error) {
        console.warn('Error stopping configuration watcher:', error);
      }
    }
    this.watchers.clear();
  }

  /**
   * Get current configuration
   */
  getConfig(): RouteCodexConfig | null {
    return this.config;
  }

  /**
   * Get configuration path
   */
  getConfigPath(): string {
    return this.configPath;
  }

  /**
   * Set configuration path
   */
  setConfigPath(path: string): void {
    this.configPath = path;
  }

  /**
   * Close all watchers and cleanup
   */
  async close(): Promise<void> {
    this.stopWatching();
  }
}
