/**
 * RouteCodex Configuration Engine
 * Core configuration parsing and validation system
 */

// Core types and interfaces
export * from './types/config-types.js';

// Core configuration parser
import { ConfigParser } from './core/config-parser.js';
export { ConfigParser };

// JSON Pointer utilities
export * from './utils/json-pointer.js';

// Shared configuration path utilities
export * from './utils/shared-config-paths.js';

// Secret sanitization utilities
export * from './utils/secret-sanitization.js';

// Configuration utilities
export class ConfigEngineUtils {
  /**
   * Deep merge configuration objects
   */
  static deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
    const result = { ...target };

    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = ConfigEngineUtils.deepMerge((result[key] as any) || {}, source[key] as any);
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
      return obj.map(item => ConfigEngineUtils.clone(item)) as any;
    }

    const cloned = {} as T;
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        cloned[key] = ConfigEngineUtils.clone(obj[key]);
      }
    }

    return cloned;
  }

  /**
   * Sanitize configuration for logging (remove sensitive data)
   */
  static sanitizeConfig<T extends Record<string, any>>(config: T): T {
    const sanitized = ConfigEngineUtils.clone(config);
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
   * Get configuration diff
   */
  static getConfigDiff(oldConfig: any, newConfig: any): any {
    const diff: any = {};

    const compare = (oldVal: any, newVal: any, path: string) => {
      if (oldVal === newVal) {
        return;
      }

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

  /**
   * Resolve configuration file path
   */
  static resolveConfigPath(configPath: string): string {
    if (configPath.startsWith('~/')) {
      return configPath.replace('~', process.env.HOME || '');
    }
    return configPath;
  }

  /**
   * Validate configuration structure (basic validation)
   */
  static validateBasicStructure(config: any): string[] {
    const errors: string[] = [];

    if (!config || typeof config !== 'object') {
      errors.push('Configuration must be an object');
      return errors;
    }

    if (!config.version) {
      errors.push('Missing required field: version');
    }

    if (config.virtualrouter) {
      if (!config.virtualrouter.inputProtocol) {
        errors.push('Missing required field: virtualrouter.inputProtocol');
      }
      if (!config.virtualrouter.outputProtocol) {
        errors.push('Missing required field: virtualrouter.outputProtocol');
      }
      if (!config.virtualrouter.providers) {
        errors.push('Missing required field: virtualrouter.providers');
      }
      if (!config.virtualrouter.routing) {
        errors.push('Missing required field: virtualrouter.routing');
      }
    }

    return errors;
  }

  /**
   * Format configuration for display
   */
  static formatConfig(config: any, indent: number = 0): string {
    const spaces = ' '.repeat(indent);

    if (typeof config !== 'object' || config === null) {
      return JSON.stringify(config);
    }

    if (Array.isArray(config)) {
      if (config.length === 0) return '[]';
      const items = config.map(item => this.formatConfig(item, indent + 2));
      return `[\n${spaces}  ${items.join(',\n' + spaces + '  ')}\n${spaces}]`;
    }

    const keys = Object.keys(config);
    if (keys.length === 0) return '{}';

    const items = keys.map(key => {
      const value = config[key];
      const formattedValue = this.formatConfig(value, indent + 2);
      return `${key}: ${formattedValue}`;
    });

    return `{\n${spaces}  ${items.join(',\n' + spaces + '  ')}\n${spaces}}`;
  }
}

// Factory function for creating config parser
export function createConfigParser(configPath?: string, options?: { sanitizeOutput?: boolean; useUnifiedPathResolver?: boolean }): ConfigParser {
  return new ConfigParser(configPath, options);
}

// Default configuration path
export const DEFAULT_CONFIG_PATH = '~/.routecodex/config';

// Export common validation schemas for external use
export {
  ProviderConfigSchema,
  RoutingConfigSchema,
  VirtualRouterConfigSchema,
  RouteCodexConfigSchema,
} from './types/config-types.js';

// Version information
export const CONFIG_ENGINE_VERSION = '1.0.0';