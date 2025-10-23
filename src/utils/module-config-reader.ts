/**
 * Module Configuration Reader
 * Reads and manages module configurations from modules.json
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Module configuration interface
 */
export interface ModuleConfig {
  enabled: boolean;
  config: Record<string, unknown>;
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
      const resolved = await this.resolvePath(this.configPath);
      const configContent = await fs.readFile(resolved, 'utf-8');
      this.config = JSON.parse(configContent);
      return this.config;
    } catch (error) {
      const msg = `Failed to load modules config from ${this.configPath}: ${error instanceof Error ? error.message : String(error)}`;

      // 检查是否禁用了配置fallback
      const disableFallback = String(process.env.ROUTECODEX_DISABLE_CONFIG_FALLBACK || '').trim() === '1';
      const strict = String(process.env.ROUTECODEX_STRICT_MODULES_CONFIG || '').trim() === '1' ||
        String(process.env.NODE_ENV || '').toLowerCase() === 'production';

      if (strict || disableFallback) {
        // 严格模式或禁用fallback时，直接抛出错误
        throw new Error(`${msg}. Configuration fallback is disabled.`);
      }

      console.warn(`${msg}. Using development fallback defaults (non-strict mode). Consider setting ROUTECODEX_DISABLE_CONFIG_FALLBACK=1 to fail fast.`);
      // Return default configuration in non-strict/dev mode
      this.config = this.getDefaultConfig();
      return this.config;
    }
  }

  private async resolvePath(p: string): Promise<string> {
    try {
      const tryCandidates: string[] = [];
      const raw = String(p || '').trim();
      // 1) Home expansion
      if (raw.startsWith('~')) {
        const home = process.env.HOME || process.env.USERPROFILE || '';
        tryCandidates.push(path.join(home, raw.slice(1)));
      }
      // 2) Absolute path
      if (path.isAbsolute(raw)) {
        tryCandidates.push(raw);
      }
      // 3) CWD relative
      if (!path.isAbsolute(raw)) {
        tryCandidates.push(path.resolve(process.cwd(), raw));
      }
      // 4) Package-root relative (works for global install)
      const moduleDir = path.dirname(fileURLToPath(import.meta.url));
      const pkgRoot = path.resolve(moduleDir, '../../');
      tryCandidates.push(path.join(pkgRoot, raw.replace(/^\.\//, '')));
      tryCandidates.push(path.join(pkgRoot, 'config', 'modules.json')); // default packaged file

      for (const c of tryCandidates) {
        try {
          const stat = await fs.stat(c);
          if (stat.isFile()) return c;
        } catch { /* next */ }
      }
      // Fallback to original (will error upstream)
      return raw || './config/modules.json';
    } catch {
      return p;
    }
  }

  /**
   * Get specific module configuration
   */
  getModuleConfig(moduleName: string): ModuleConfig | null {
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
            moduleType: 'http-server',
            port: 5506,
            host: 'localhost',
            cors: {
              origin: '*',
              credentials: true,
            },
            timeout: 30000,
            bodyLimit: '10mb',
            enableMetrics: true,
            enableHealthChecks: true,
          },
        },
        configmanager: {
          enabled: true,
          config: {
            moduleType: 'config-manager',
            // Align with ConfigManager default user config path
            configPath: '~/.routecodex/config.json',
            watchMode: true,
          },
        },
        providermanager: {
          enabled: true,
          config: {
            moduleType: 'provider-manager',
            healthCheckInterval: 30000,
            maxRetries: 3,
          },
        },
        errorhandling: {
          enabled: true,
          config: {
            moduleType: 'error-handling',
            maxErrors: 1000,
          },
        },
      },
    };
  }
}
