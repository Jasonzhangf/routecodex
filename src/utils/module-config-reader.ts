/**
 * Module Configuration Reader
 * Reads and manages module configurations from modules.json
 */

import fs from 'fs/promises';
import path from 'path';

/**
 * Module configuration interface
 */
export interface ModuleConfig {
  enabled: boolean;
  config: Record<string, any>;
}

/**
 * All modules configuration
 */
export interface ModulesConfig {
  modules: Record<string, ModuleConfig>;
}

/**
 * Module Configuration Reader class
 */
export class ModuleConfigReader {
  private configPath: string;
  private config: ModulesConfig;

  constructor(configPath: string = './config/modules.json') {
    this.configPath = configPath;
    this.config = this.getDefaultConfig();
  }

  /**
   * Load modules configuration
   */
  async load(): Promise<ModulesConfig> {
    try {
      const configContent = await fs.readFile(this.configPath, 'utf-8');
      this.config = JSON.parse(configContent);
      return this.config;
    } catch (error) {
      console.warn(`Failed to load modules config from ${this.configPath}:`, error);
      // Return default configuration
      this.config = this.getDefaultConfig();
      return this.config;
    }
  }

  /**
   * Get specific module configuration
   */
  getModuleConfig<T = Record<string, any>>(moduleName: string): ModuleConfig | null {
    if (!this.config || !this.config.modules[moduleName]) {
      return null;
    }
    return this.config.modules[moduleName] as ModuleConfig;
  }

  /**
   * Get module configuration with type safety
   */
  getModuleConfigValue<T>(moduleName: string, defaultValue?: T): T | null {
    const moduleConfig = this.getModuleConfig(moduleName);
    if (!moduleConfig || !moduleConfig.enabled) {
      return defaultValue || null;
    }
    return moduleConfig.config as T;
  }

  /**
   * Check if module is enabled
   */
  isModuleEnabled(moduleName: string): boolean {
    const moduleConfig = this.getModuleConfig(moduleName);
    return moduleConfig?.enabled || false;
  }

  /**
   * Get all enabled modules
   */
  getEnabledModules(): string[] {
    if (!this.config) {
      return [];
    }
    return Object.entries(this.config.modules)
      .filter(([, config]) => config.enabled)
      .map(([name]) => name);
  }

  /**
   * Get default configuration
   */
  private getDefaultConfig(): ModulesConfig {
    return {
      modules: {
        httpserver: {
          enabled: true,
          config: {
            moduleType: "http-server",
            port: 5506,
            host: "localhost",
            cors: {
              origin: "*",
              credentials: true
            },
            timeout: 30000,
            bodyLimit: "10mb",
            enableMetrics: true,
            enableHealthChecks: true
          }
        },
        configmanager: {
          enabled: true,
          config: {
            moduleType: "config-manager",
            configPath: "./routecodex.json",
            watchMode: true
          }
        },
        providermanager: {
          enabled: true,
          config: {
            moduleType: "provider-manager",
            healthCheckInterval: 30000,
            maxRetries: 3
          }
        },
        errorhandling: {
          enabled: true,
          config: {
            moduleType: "error-handling",
            maxErrors: 1000
          }
        }
      }
    };
  }
}