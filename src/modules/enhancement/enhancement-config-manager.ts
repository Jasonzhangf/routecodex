/**
 * Configuration-Driven Module Enhancement System
 *
 * Manages module enhancement configurations and provides JSON-based configuration
 * for enabling debugging on specific modules.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { DebugCenter } from '../modules/pipeline/types/external-types.js';
import { ModuleEnhancementFactory, EnhancementConfig, EnhancementRegistry } from './module-enhancement-factory.js';

/**
 * Global enhancement configuration
 */
export interface GlobalEnhancementConfig {
  /** Global enable/disable flag */
  enabled: boolean;
  /** Default configuration for all modules */
  defaults: EnhancementConfig;
  /** Module-specific configurations */
  modules: Record<string, ModuleEnhancementConfig>;
  /** Auto-detection settings */
  autoDetection: {
    /** Enable auto-detection of modules */
    enabled: boolean;
    /** Patterns to scan for modules */
    patterns: string[];
    /** Directories to exclude from scanning */
    excludeDirs: string[];
  };
  /** Performance monitoring settings */
  performance: {
    /** Enable performance tracking */
    enabled: boolean;
    /** Performance thresholds */
    thresholds: {
      /** Warning threshold in ms */
      warning: number;
      /** Critical threshold in ms */
      critical: number;
    };
  };
}

/**
 * Module-specific enhancement configuration
 */
export interface ModuleEnhancementConfig extends EnhancementConfig {
  /** Module identifier */
  moduleId: string;
  /** Module type (provider, pipeline, compatibility, etc.) */
  moduleType: string;
  /** File path for auto-detection */
  filePath?: string;
  /** Enable/disable for this specific module */
  enabled?: boolean;
  /** Priority for enhancement order */
  priority?: number;
  /** Dependencies for this module */
  dependencies?: string[];
}

/**
 * Configuration file structure
 */
export interface EnhancementConfigFile {
  /** Configuration version */
  version: string;
  /** Last updated timestamp */
  lastUpdated?: number;
  /** Global configuration */
  global: GlobalEnhancementConfig;
  /** Environment-specific overrides */
  environments?: {
    development: Partial<GlobalEnhancementConfig>;
    production: Partial<GlobalEnhancementConfig>;
    test: Partial<GlobalEnhancementConfig>;
  };
}

/**
 * Enhancement Configuration Manager
 */
export class EnhancementConfigManager {
  private factory: ModuleEnhancementFactory;
  private config: EnhancementConfigFile | null = null;
  private configPath: string;
  private loaded = false;

  constructor(
    private debugCenter: DebugCenter,
    configPath?: string
  ) {
    this.factory = new ModuleEnhancementFactory(debugCenter);
    this.configPath = configPath || path.join(process.cwd(), 'enhancement-config.json');
  }

  /**
   * Load configuration from file
   */
  async loadConfig(configPath?: string): Promise<void> {
    const targetPath = configPath || this.configPath;

    try {
      const configData = await fs.readFile(targetPath, 'utf-8');
      this.config = JSON.parse(configData) as EnhancementConfigFile;
      this.configPath = targetPath;
      this.loaded = true;

      console.log(`Enhancement configuration loaded from ${targetPath}`);
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        // Configuration file doesn't exist, create default
        await this.createDefaultConfig(targetPath);
        this.config = await this.getDefaultConfig();
        this.loaded = true;
        console.log(`Default enhancement configuration created at ${targetPath}`);
      } else {
        throw new Error(`Failed to load enhancement configuration: ${error}`);
      }
    }
  }

  /**
   * Save configuration to file
   */
  async saveConfig(config?: EnhancementConfigFile): Promise<void> {
    const targetConfig = config || this.config;
    if (!targetConfig) {
      throw new Error('No configuration to save');
    }

    targetConfig.lastUpdated = Date.now();

    try {
      await fs.writeFile(this.configPath, JSON.stringify(targetConfig, null, 2));
      console.log(`Enhancement configuration saved to ${this.configPath}`);
    } catch (error) {
      throw new Error(`Failed to save enhancement configuration: ${error}`);
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): EnhancementConfigFile | null {
    return this.config;
  }

  /**
   * Check if configuration is loaded
   */
  isConfigLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Get global configuration for current environment
   */
  getGlobalConfig(): GlobalEnhancementConfig {
    if (!this.config) {
      throw new Error('Configuration not loaded');
    }

    const env = process.env.NODE_ENV || 'development';
    const globalConfig = { ...this.config.global };

    // Apply environment-specific overrides
    if (this.config.environments && this.config.environments[env as keyof typeof this.config.environments]) {
      const overrides = this.config.environments[env as keyof typeof this.config.environments];
      Object.assign(globalConfig, overrides);
    }

    return globalConfig;
  }

  /**
   * Get module-specific configuration
   */
  getModuleConfig(moduleId: string): ModuleEnhancementConfig | null {
    const globalConfig = this.getGlobalConfig();
    const moduleConfig = globalConfig.modules[moduleId];

    if (!moduleConfig) {
      return null;
    }

    // Merge with global defaults
    return {
      ...globalConfig.defaults,
      ...moduleConfig,
      moduleId,
      moduleType: moduleConfig.moduleType || 'generic'
    };
  }

  /**
   * Check if module enhancement is enabled
   */
  isModuleEnhancementEnabled(moduleId: string): boolean {
    const globalConfig = this.getGlobalConfig();
    const moduleConfig = this.getModuleConfig(moduleId);

    // Check global enable flag
    if (!globalConfig.enabled) {
      return false;
    }

    // Check module-specific configuration
    if (moduleConfig) {
      return moduleConfig.enabled ?? globalConfig.defaults.enabled;
    }

    // Use global default
    return globalConfig.defaults.enabled;
  }

  /**
   * Enhance a module based on configuration
   */
  async enhanceModule<T extends object>(
    module: T,
    moduleId: string,
    moduleType: string,
    config?: EnhancementConfig
  ): Promise<EnhancedModule<T>> {
    // Load configuration if not already loaded
    if (!this.loaded) {
      await this.loadConfig();
    }

    // Get configuration for this module
    const moduleConfig = config || this.getModuleConfig(moduleId) || this.getGlobalConfig().defaults;

    // Check if enhancement is enabled
    if (!this.isModuleEnhancementEnabled(moduleId)) {
      return this.factory.createEnhancedModule(module, moduleId, moduleType, {
        ...moduleConfig,
        enabled: false
      });
    }

    // Create enhanced module
    return this.factory.createEnhancedModule(module, moduleId, moduleType, moduleConfig);
  }

  /**
   * Auto-detect modules and create configuration
   */
  async autoDetectModules(): Promise<void> {
    if (!this.loaded) {
      await this.loadConfig();
    }

    const globalConfig = this.getGlobalConfig();
    if (!globalConfig.autoDetection.enabled) {
      return;
    }

    const detectedModules: Record<string, ModuleEnhancementConfig> = {};

    for (const pattern of globalConfig.autoDetection.patterns) {
      const modules = await this.scanModules(pattern);
      for (const module of modules) {
        if (!globalConfig.modules[module.moduleId]) {
          detectedModules[module.moduleId] = module;
        }
      }
    }

    // Add detected modules to configuration
    Object.assign(globalConfig.modules, detectedModules);
    await this.saveConfig(this.config!);

    console.log(`Auto-detected ${Object.keys(detectedModules).length} modules for enhancement`);
  }

  /**
   * Enable enhancement for a module
   */
  async enableModuleEnhancement(moduleId: string, config?: Partial<EnhancementConfig>): Promise<void> {
    if (!this.loaded) {
      await this.loadConfig();
    }

    const globalConfig = this.getGlobalConfig();

    if (!globalConfig.modules[moduleId]) {
      throw new Error(`Module ${moduleId} not found in configuration`);
    }

    globalConfig.modules[moduleId] = {
      ...globalConfig.modules[moduleId],
      ...config,
      enabled: true
    };

    await this.saveConfig(this.config!);
    console.log(`Enhancement enabled for module ${moduleId}`);
  }

  /**
   * Disable enhancement for a module
   */
  async disableModuleEnhancement(moduleId: string): Promise<void> {
    if (!this.loaded) {
      await this.loadConfig();
    }

    const globalConfig = this.getGlobalConfig();

    if (!globalConfig.modules[moduleId]) {
      throw new Error(`Module ${moduleId} not found in configuration`);
    }

    globalConfig.modules[moduleId].enabled = false;
    await this.saveConfig(this.config!);
    console.log(`Enhancement disabled for module ${moduleId}`);
  }

  /**
   * Get all enhanced modules
   */
  getEnhancedModules(): EnhancedModule<any>[] {
    return EnhancementRegistry.getInstance().getAllEnhancedModules();
  }

  /**
   * Get enhanced module by ID
   */
  getEnhancedModule<T extends object>(moduleId: string): EnhancedModule<T> | undefined {
    return EnhancementRegistry.getInstance().getEnhancedModule<T>(moduleId);
  }

  /**
   * Create default configuration
   */
  private async createDefaultConfig(configPath: string): Promise<void> {
    const defaultConfig = await this.getDefaultConfig();
    await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2));
  }

  /**
   * Get default configuration
   */
  private async getDefaultConfig(): Promise<EnhancementConfigFile> {
    return {
      version: '1.0.0',
      lastUpdated: Date.now(),
      global: {
        enabled: true,
        defaults: {
          enabled: true,
          level: 'detailed',
          consoleLogging: true,
          debugCenter: true,
          maxLogEntries: 1000,
          performanceTracking: true,
          requestLogging: true,
          errorTracking: true,
          transformationLogging: true
        },
        modules: {
          'lmstudio-provider': {
            moduleId: 'lmstudio-provider',
            moduleType: 'provider',
            enabled: true,
            level: 'detailed',
            consoleLogging: true,
            debugCenter: true
          },
          'qwen-provider': {
            moduleId: 'qwen-provider',
            moduleType: 'provider',
            enabled: true,
            level: 'detailed',
            consoleLogging: true,
            debugCenter: true
          },
          'pipeline-manager': {
            moduleId: 'pipeline-manager',
            moduleType: 'pipeline',
            enabled: true,
            level: 'detailed',
            consoleLogging: true,
            debugCenter: true
          }
        },
        autoDetection: {
          enabled: true,
          patterns: [
            'src/modules/pipeline/modules/**/*.ts',
            'src/modules/pipeline/core/**/*.ts',
            'src/server/**/*.ts'
          ],
          excludeDirs: [
            'node_modules',
            'dist',
            'tests'
          ]
        },
        performance: {
          enabled: true,
          thresholds: {
            warning: 1000,
            critical: 5000
          }
        }
      },
      environments: {
        development: {
          enabled: true,
          defaults: {
            enabled: true,
            level: 'verbose',
            consoleLogging: true,
            debugCenter: true
          }
        },
        production: {
          enabled: true,
          defaults: {
            enabled: false,
            level: 'basic',
            consoleLogging: false,
            debugCenter: true
          }
        },
        test: {
          enabled: true,
          defaults: {
            enabled: true,
            level: 'verbose',
            consoleLogging: true,
            debugCenter: true
          }
        }
      }
    };
  }

  /**
   * Scan for modules in specified pattern
   */
  private async scanModules(pattern: string): Promise<ModuleEnhancementConfig[]> {
    const glob = await import('glob');
    const files = await glob.glob(pattern, {
      ignore: this.getGlobalConfig().autoDetection.excludeDirs
    });

    const modules: ModuleEnhancementConfig[] = [];

    for (const file of files) {
      const moduleId = this.extractModuleIdFromFile(file);
      const moduleType = this.determineModuleType(file);

      modules.push({
        moduleId,
        moduleType,
        enabled: false, // Disabled by default
        level: 'detailed',
        consoleLogging: true,
        debugCenter: true,
        filePath: file
      });
    }

    return modules;
  }

  /**
   * Extract module ID from file path
   */
  private extractModuleIdFromFile(filePath: string): string {
    const relativePath = path.relative(process.cwd(), filePath);
    const normalized = relativePath.replace(/\.ts$/, '').replace(/\.js$/, '');
    const parts = normalized.split(path.sep);

    // Remove 'src' prefix if present
    if (parts[0] === 'src') {
      parts.shift();
    }

    // Create module ID from remaining path
    return parts.join('-');
  }

  /**
   * Determine module type from file path
   */
  private determineModuleType(filePath: string): string {
    const lowerPath = filePath.toLowerCase();

    if (lowerPath.includes('provider')) {
      return 'provider';
    } else if (lowerPath.includes('pipeline')) {
      return 'pipeline';
    } else if (lowerPath.includes('compatibility')) {
      return 'compatibility';
    } else if (lowerPath.includes('workflow')) {
      return 'workflow';
    } else if (lowerPath.includes('llmswitch') || lowerPath.includes('switch')) {
      return 'llmswitch';
    } else if (lowerPath.includes('server')) {
      return 'http-server';
    } else {
      return 'generic';
    }
  }
}