/**
 * RouteCodex Configuration System
 * Comprehensive configuration management for the RouteCodex proxy server
 */

// Core types and interfaces
export * from './config-types';

// Configuration manager
export { ConfigManager } from './config-manager';
import { ConfigManager } from './config-manager';

// Configuration loader
export { ConfigLoader } from './config-loader';

// Configuration validator
export { ConfigValidator } from './config-validator';

// Configuration providers
export { JsonConfigProvider } from './providers/json-provider';
import { JsonConfigProvider } from './providers/json-provider';

// Default configuration
export { default as defaultConfig } from './default-config.json';

// Configuration utilities
export class ConfigUtils {
  /**
   * Deep merge two objects
   */
  static deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
    const result = { ...target };

    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = ConfigUtils.deepMerge((result[key] as any) || {}, source[key] as any);
      } else {
        result[key] = source[key] as any;
      }
    }

    return result;
  }

  /**
   * Clone configuration object
   */
  static clone<T>(obj: T): T {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (obj instanceof Date) {
      return new Date(obj.getTime()) as any;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => ConfigUtils.clone(item)) as any;
    }

    const cloned = {} as T;
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        cloned[key] = ConfigUtils.clone(obj[key]);
      }
    }

    return cloned;
  }

  /**
   * Sanitize configuration for logging (remove sensitive data)
   */
  static sanitizeConfig<T extends Record<string, any>>(config: T): T {
    const sanitized = ConfigUtils.clone(config);
    const sensitiveKeys = ['apiKey', 'password', 'secret', 'token'];

    const sanitizeObject = (obj: any) => {
      if (obj && typeof obj === 'object') {
        for (const key in obj) {
          if (sensitiveKeys.some(sensitive => key.toLowerCase().includes(sensitive))) {
            obj[key] = '***REDACTED***';
          } else if (typeof obj[key] === 'object') {
            sanitizeObject(obj[key]);
          }
        }
      }
    };

    sanitizeObject(sanitized);
    return sanitized;
  }

  /**
   * Expand environment variables in string values
   */
  static expandEnvVars(obj: any): any {
    if (typeof obj === 'string') {
      return obj.replace(/\$\{([^}]+)\}/g, (match, varName) => {
        return process.env[varName] || match;
      });
    }

    if (Array.isArray(obj)) {
      return obj.map(item => ConfigUtils.expandEnvVars(item));
    }

    if (obj && typeof obj === 'object') {
      const result = {} as any;
      for (const key in obj) {
        result[key] = ConfigUtils.expandEnvVars(obj[key]);
      }
      return result;
    }

    return obj;
  }

  /**
   * Validate configuration structure
   */
  static validateStructure(config: any, required: string[]): string[] {
    const errors: string[] = [];

    const checkRequired = (obj: any, path: string, required: string[]) => {
      for (const field of required) {
        if (!(field in obj)) {
          errors.push(`Missing required field: ${path ? `${path  }.${  field}` : field}`);
        }
      }
    };

    checkRequired(config, '', required);
    return errors;
  }

  /**
   * Get configuration diff
   */
  static getConfigDiff(oldConfig: any, newConfig: any): any {
    const diff: any = {};

    const compare = (oldVal: any, newVal: any, path: string) => {
      if (oldVal === newVal) {return;}

      if (typeof oldVal !== typeof newVal) {
        diff[path] = { old: oldVal, new: newVal };
        return;
      }

      if (typeof newVal === 'object' && newVal !== null && !Array.isArray(newVal)) {
        for (const key in newVal) {
          compare(oldVal?.[key], newVal[key], path ? `${path}.${key}` : key);
        }
        return;
      }

      diff[path] = { old: oldVal, new: newVal };
    };

    compare(oldConfig, newConfig, '');
    return diff;
  }
}

// Configuration presets
export const ConfigPresets = {
  development: {
    environment: 'development' as const,
    debug: true,
    logLevel: 'debug' as const,
    monitoring: {
      enabled: true,
      logging: {
        level: 'debug' as const,
        format: 'text' as const
      }
    }
  },

  production: {
    environment: 'production' as const,
    debug: false,
    logLevel: 'warn' as const,
    monitoring: {
      enabled: true,
      logging: {
        level: 'warn' as const,
        format: 'json' as const
      }
    }
  },

  test: {
    environment: 'test' as const,
    debug: true,
    logLevel: 'error' as const,
    monitoring: {
      enabled: false
    }
  }
};

// Configuration factory
export class ConfigFactory {
  /**
   * Create configuration manager with default providers
   */
  static createManager(configPath?: string): ConfigManager {
    const manager = new ConfigManager(configPath);

    // Register default providers
    manager.registerProvider(new JsonConfigProvider());

    return manager;
  }

  /**
   * Create configuration from environment variables
   */
  static createFromEnv(): any {
    const config: any = {
      version: process.env.ROUTECODEX_VERSION || '1.0.0',
      environment: process.env.NODE_ENV || process.env.ROUTECODEX_ENV || 'development',
      debug: process.env.ROUTECODEX_DEBUG === 'true',
      logLevel: process.env.ROUTECODEX_LOG_LEVEL || 'info'
    };

    // Server configuration
    if (process.env.ROUTECODEX_HOST || process.env.ROUTECODEX_PORT) {
      config.server = {
        host: process.env.ROUTECODEX_HOST || '0.0.0.0',
        port: parseInt(process.env.ROUTECODEX_PORT || '3000'),
        cors: {
          enabled: true,
          origin: '*',
          credentials: true,
          methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
          allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
        }
      };
    }

    return config;
  }

  /**
   * Create configuration preset
   */
  static createPreset(preset: keyof typeof ConfigPresets): any {
    return ConfigPresets[preset];
  }
}