/**
 * Static Instance Pool
 *
 * Manages pre-loaded module instances for multiple configurations.
 * Supports configuration-driven preloading and instance sharing.
 */

import type { UnknownObject } from '../../../../types/common-types.js';
import type { ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { ErrorHandlingCenter, DebugCenter, DebugEvent } from '../../types/external-types.js';
import type { V2ModuleInstance } from './module-registry.js';
import type { V2SystemConfig, ModuleConfig, ModuleSpecification } from '../types/v2-types.js';
import { V2ModuleRegistry } from './module-registry.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';
import { V2ConfigLibrary } from '../config/v2-config-library.js';

/**
 * Instance pool configuration
 */
export interface InstancePoolConfig {
  maxInstancesPerType: number;
  warmupInstances: number;
  idleTimeout: number;
  healthCheckInterval: number;
}

/**
 * Instance pool metrics
 */
export interface InstancePoolMetrics {
  totalInstances: number;
  activeInstances: number;
  idleInstances: number;
  memoryUsage: number;
  lastHealthCheck: number;
  configTypes: Record<string, number>;
}

/**
 * Preload plan for different priorities
 */
interface PreloadPlan {
  critical: Array<{ type: string; configs: ModuleConfig[] }>;
  important: Array<{ type: string; configs: ModuleConfig[] }>;
  optional: Array<{ type: string; configs: ModuleConfig[] }>;
}

/**
 * Warmup report
 */
export interface WarmupReport {
  startTime: number;
  endTime?: number;
  duration?: number;
  preloadedInstances: number;
  failedInstances: Array<{
    module: string;
    error: string;
    recoverable: boolean;
  }>;
  warnings: string[];
  success: boolean;
}

/**
 * Static Instance Pool
 *
 * Pre-loads and manages module instances for multiple configurations.
 * Ensures performance through instance sharing and intelligent caching.
 */
export class StaticInstancePool {
  private readonly registry: V2ModuleRegistry;
  private readonly logger: PipelineDebugLogger;
  private readonly config: InstancePoolConfig;

  // Instance storage: type -> configHash -> instance
  private readonly instances = new Map<string, Map<string, V2ModuleInstance>>();
  private readonly instanceConfigs = new Map<string, ModuleConfig>();
  private readonly lastAccess = new Map<string, number>();

  // Metrics and monitoring
  private metrics: InstancePoolMetrics;
  private healthCheckTimer?: NodeJS.Timeout;

  constructor(config: Partial<InstancePoolConfig> = {}, logger?: PipelineDebugLogger) {
    this.registry = V2ModuleRegistry.getInstance();
    this.logger = logger || new PipelineDebugLogger();
    this.config = {
      maxInstancesPerType: 10,
      warmupInstances: 3,
      idleTimeout: 300000, // 5 minutes
      healthCheckInterval: 60000, // 1 minute
      ...config
    };

    this.metrics = {
      totalInstances: 0,
      activeInstances: 0,
      idleInstances: 0,
      memoryUsage: 0,
      lastHealthCheck: Date.now(),
      configTypes: {}
    };

    this.startHealthCheckTimer();
  }

  /**
   * Preload all required instances based on V2 configuration
   */
  async preloadInstances(v2Config: V2SystemConfig): Promise<WarmupReport> {
    const report: WarmupReport = {
      startTime: Date.now(),
      preloadedInstances: 0,
      failedInstances: [],
      warnings: [],
      success: false
    };

    // Debug: log the actual structure of preloadModules
    const preloadModules = v2Config.staticInstances.preloadModules;
    this.logger.logModule('static-instance-pool', 'preload-debug', {
      preloadModulesType: typeof preloadModules,
      preloadModulesValue: preloadModules,
      isArray: Array.isArray(preloadModules),
      keys: !Array.isArray(preloadModules) ? Object.keys(preloadModules) : 'array'
    });

    this.logger.logModule('static-instance-pool', 'preload-start', {
      configTypes: Array.isArray(preloadModules)
        ? preloadModules
        : Object.keys(preloadModules)
    });

    try {
      // 1. Analyze preload requirements
      const moduleConfigs = this.extractModuleConfigs(v2Config);
      const preloadPlan = this.createPreloadPlan(moduleConfigs);

      // 2. Preload by priority
      await this.preloadByPriority(preloadPlan, report);

      // 3. Validate all instances
      await this.validatePreloadedInstances(report);

      report.success = true;
      this.logger.logModule('static-instance-pool', 'preload-success', {
        duration: Date.now() - report.startTime,
        instances: report.preloadedInstances,
        failures: report.failedInstances.length
      });

    } catch (error) {
      report.success = false;
      report.failedInstances.push({
        module: 'system',
        error: error instanceof Error ? error.message : String(error),
        recoverable: false
      });

      this.logger.logModule('static-instance-pool', 'preload-error', {
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - report.startTime
      });
    }

    report.endTime = Date.now();
    report.duration = report.endTime - report.startTime;

    this.updateMetrics();
    return report;
  }

  /**
   * Get instance for specific configuration
   */
  async getInstance(moduleType: string, config: ModuleConfig): Promise<V2ModuleInstance> {
    const configHash = this.hashConfig(config);
    const typeInstances = this.instances.get(moduleType);

    if (!typeInstances?.has(configHash)) {
      throw new Error(`Instance not found for ${moduleType}:${configHash}. Make sure required instances are preloaded.`);
    }

    const instance = typeInstances.get(configHash)!;

    // Update last access time
    this.lastAccess.set(`${moduleType}:${configHash}`, Date.now());

    // Verify instance health
    if (!instance.isHealthy()) {
      throw new Error(`Instance ${moduleType}:${configHash} is not healthy`);
    }

    this.metrics.activeInstances++;
    return instance;
  }

  /**
   * Check if instance exists for configuration
   */
  hasInstance(moduleType: string, config: ModuleConfig): boolean {
    const configHash = this.hashConfig(config);
    const typeInstances = this.instances.get(moduleType);
    return typeInstances?.has(configHash) || false;
  }

  /**
   * Get all instances of specific type
   */
  getInstancesByType(moduleType: string): V2ModuleInstance[] {
    const typeInstances = this.instances.get(moduleType);
    return typeInstances ? Array.from(typeInstances.values()) : [];
  }

  /**
   * Get instance pool metrics
   */
  getMetrics(): InstancePoolMetrics {
    this.updateMetrics();
    return { ...this.metrics };
  }

  /**
   * Cleanup idle instances
   */
  async cleanupIdleInstances(): Promise<number> {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [moduleType, typeInstances] of this.instances) {
      const toRemove: string[] = [];

      for (const [configHash] of typeInstances) {
        const lastAccess = this.lastAccess.get(`${moduleType}:${configHash}`) || 0;
        const idleTime = now - lastAccess;

        if (idleTime > this.config.idleTimeout) {
          toRemove.push(configHash);
        }
      }

      // Remove idle instances
      for (const configHash of toRemove) {
        const instance = typeInstances.get(configHash)!;
        await instance.cleanup();
        typeInstances.delete(configHash);
        this.instanceConfigs.delete(`${moduleType}:${configHash}`);
        this.lastAccess.delete(`${moduleType}:${configHash}`);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.logModule('static-instance-pool', 'cleanup', {
        cleanedInstances: cleanedCount,
        remainingInstances: this.metrics.totalInstances
      });
    }

    this.updateMetrics();
    return cleanedCount;
  }

  /**
   * Shutdown the instance pool
   */
  async shutdown(): Promise<void> {
    this.logger.logModule('static-instance-pool', 'shutdown-start');

    // Stop health check timer
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    // Cleanup all instances
    let cleanupCount = 0;
    for (const [, typeInstances] of this.instances) {
      for (const [, instance] of typeInstances) {
        await instance.cleanup();
        cleanupCount++;
      }
      typeInstances.clear();
    }

    this.instances.clear();
    this.instanceConfigs.clear();
    this.lastAccess.clear();

    this.logger.logModule('static-instance-pool', 'shutdown-complete', {
      cleanedInstances: cleanupCount
    });
  }

  /**
   * Extract module configurations from V2 config
   */
  private extractModuleConfigs(v2Config: V2SystemConfig): Map<string, ModuleConfig[]> {
    const moduleConfigs = new Map<string, ModuleConfig[]>();

    // Extract from route table
    const { routeTable } = v2Config.virtualPipelines;
    if (routeTable.routes.length > 0) {
      for (const route of routeTable.routes) {
        for (const moduleSpec of route.modules) {
          const moduleType = moduleSpec.type;
          const config = this.resolveModuleConfig(moduleSpec, v2Config);

          if (!moduleConfigs.has(moduleType)) {
            moduleConfigs.set(moduleType, []);
          }

          // Check for duplicates
          const existing = moduleConfigs.get(moduleType)!;
          const configHash = this.hashConfig(config);
          const hasSameConfig = existing.some(c => this.hashConfig(c) === configHash);

          if (!hasSameConfig) {
            existing.push(config);
          }
        }
      }
    } else {
      // Fallback: use preloadModules to create default configurations
      const preloadModules = v2Config.staticInstances.preloadModules;
      const moduleTypes = Array.isArray(preloadModules) ? preloadModules : [];

      for (const moduleType of moduleTypes) {
        const config = this.getPredefinedConfig(moduleType, v2Config);
        if (!moduleConfigs.has(moduleType)) {
          moduleConfigs.set(moduleType, []);
        }
        moduleConfigs.get(moduleType)!.push(config);
      }
    }

    return moduleConfigs;
  }

  /**
   * Create preload plan with priorities
   */
  private createPreloadPlan(moduleConfigs: Map<string, ModuleConfig[]>): PreloadPlan {
    const plan: PreloadPlan = {
      critical: [],
      important: [],
      optional: []
    };

    for (const [moduleType, configs] of moduleConfigs) {
      const priority = this.getModulePriority(moduleType);
      plan[priority].push({ type: moduleType, configs });
    }

    return plan;
  }

  /**
   * Get module priority for preloading
   */
  private getModulePriority(moduleType: string): 'critical' | 'important' | 'optional' {
    if (moduleType.includes('provider')) {return 'critical';}
    if (moduleType.includes('compatibility')) {return 'critical';}
    if (moduleType.includes('llmswitch')) {return 'important';}
    return 'optional';
  }

  /**
   * Preload modules by priority
   */
  private async preloadByPriority(plan: PreloadPlan, report: WarmupReport): Promise<void> {
    const phases: Array<'critical' | 'important' | 'optional'> = ['critical', 'important', 'optional'];

    for (const phase of phases) {
      for (const { type, configs } of plan[phase]) {
        try {
          await this.preloadModuleType(type, configs, report);
          report.preloadedInstances += configs.length;
        } catch (error) {
          report.failedInstances.push({
            module: type,
            error: error instanceof Error ? error.message : String(error),
            recoverable: phase !== 'critical'
          });

          if (phase === 'critical') {
            throw error; // Critical failures should stop preloading
          }
        }
      }
    }
  }

  /**
   * Preload all configurations for a module type
   */
  private async preloadModuleType(
    moduleType: string,
    configs: ModuleConfig[],
    _report: WarmupReport
  ): Promise<void> {
    if (!this.instances.has(moduleType)) {
      this.instances.set(moduleType, new Map());
    }

    const typeInstances = this.instances.get(moduleType)!;

    for (const config of configs) {
      try {
        const configHash = this.hashConfig(config);

        // Check if already loaded
        if (typeInstances.has(configHash)) {
          continue;
        }

        // Create instance
        const dependencies = this.createDependencies(moduleType);
        const instance = await this.registry.createInstance(moduleType, config.config as UnknownObject, dependencies);

        // Store instance and config
        typeInstances.set(configHash, instance);
        this.instanceConfigs.set(`${moduleType}:${configHash}`, config);
        this.lastAccess.set(`${moduleType}:${configHash}`, Date.now());

      } catch (error) {
        const errorObj = error instanceof Error ? error : new Error(String(error));
        throw new Error(`Failed to preload ${moduleType}: ${errorObj.message}`);
      }
    }
  }

  /**
   * Validate preloaded instances
   */
  private async validatePreloadedInstances(report: WarmupReport): Promise<void> {
    let healthyCount = 0;
    let unhealthyCount = 0;

    for (const [moduleType, typeInstances] of this.instances) {
      for (const [configHash, instance] of typeInstances) {
        if (instance.isHealthy()) {
          healthyCount++;
        } else {
          unhealthyCount++;
          report.failedInstances.push({
            module: `${moduleType}:${configHash}`,
            error: 'Instance health check failed',
            recoverable: true
          });
        }
      }
    }

    if (unhealthyCount > 0) {
      report.warnings.push(`${unhealthyCount} instances failed health check`);
    }

    this.logger.logModule('static-instance-pool', 'validation', {
      healthyInstances: healthyCount,
      unhealthyInstances: unhealthyCount
    });
  }

  /**
   * Resolve module configuration
   */
  private resolveModuleConfig(moduleSpec: ModuleSpecification, v2Config: V2SystemConfig): ModuleConfig {
    if (typeof moduleSpec.config === 'string') {
      // Reference to predefined config
      return this.getPredefinedConfig(moduleSpec.config, v2Config);
    }
    return moduleSpec.config as ModuleConfig;
  }

  /**
   * Get predefined configuration
   */
  private getPredefinedConfig(configId: string, v2Config: V2SystemConfig): ModuleConfig {
    // First check if it's in V2ConfigLibrary
    const configLibrary = V2ConfigLibrary.getInstance();
    let config = configLibrary.getConfiguration(configId);

    if (config) {
      return config;
    }

    // Check module registry in V2 config
    const registry = v2Config.virtualPipelines.moduleRegistry;

    // Check providers
    if (registry.providers[configId]) {
      return registry.providers[configId];
    }

    // Check compatibility modules
    if (registry.compatibility[configId]) {
      return registry.compatibility[configId];
    }

    // Check LLM switch modules
    if (registry.llmSwitch[configId]) {
      return registry.llmSwitch[configId];
    }

    // Return a basic default structure as fallback
    return {
      type: configId,
      config: {
        // 基础配置，避免config为空对象
        enabled: true,
        timeout: 30000
      }
    };
  }

  /**
   * Create module dependencies
   */
  private createDependencies(moduleType: string): ModuleDependencies {
    const errorHandlingCenter: ErrorHandlingCenter = {
      async handleError(error: unknown, context?: UnknownObject): Promise<void> {
        try {
          const msg = error instanceof Error ? error.message : String(error);
          (context && typeof context === 'object')
            ? (void 0)
            : (void 0);
          // 仅记录，遵循 Fail Fast：不做兜底
          try { /* eslint-disable no-console */ console.error('[V2] error', msg); /* eslint-enable */ } catch { /* noop */ }
        } catch { /* noop */ }
      },
      createContext(module: string, action: string, data?: UnknownObject): UnknownObject {
        return { module, action, data, timestamp: Date.now() } as UnknownObject;
      },
      getStatistics(): UnknownObject { return {}; }
    };

    const debugCenter: DebugCenter = {
      logDebug: (_module: string, _message: string, _data?: UnknownObject): void => { /* noop */ },
      logError: (_module: string, _error: unknown, _context?: UnknownObject): void => { /* noop */ },
      logModule: (_module: string, _action: string, _data?: UnknownObject): void => { /* noop */ },
      processDebugEvent: (_event: DebugEvent): void => { /* noop */ },
      getLogs: (_module?: string): UnknownObject[] => []
    };

    return {
      errorHandlingCenter,
      debugCenter,
      logger: this.logger,
      // 可选：分发中心按需扩展，当前不注入
    };
  }

  /**
   * Hash configuration for caching
   */
  private hashConfig(config: ModuleConfig): string {
    const stableString = this.stableStringify(config);
    // Simple hash implementation for browser compatibility
    let hash = 0;
    for (let i = 0; i < stableString.length; i++) {
      const char = stableString.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Stable stringify with recursive handling
   */
  private stableStringify(obj: unknown): string {
    const seen = new WeakSet();

    const stringify = (value: unknown): string => {
      if (value === null || value === undefined) {return 'null';}
      if (typeof value === 'string') {return JSON.stringify(value);}
      if (typeof value === 'number' || typeof value === 'boolean') {return String(value);}
      if (typeof value === 'object') {
        if (seen.has(value as object)) {return '"[Circular]"';}
        seen.add(value as object);

        if (Array.isArray(value)) {
          const arrayStr = `[${  (value as unknown[]).map(stringify).join(',')  }]`;
          seen.delete(value as object);
          return arrayStr;
        }

        const keys = Object.keys(value as Record<string, unknown>).sort();
        const objStr = `{${  keys.map(key =>
          `${JSON.stringify(key)  }:${  stringify((value as Record<string, unknown>)[key])}`
        ).join(',')  }}`;
        seen.delete(value as object);
        return objStr;
      }
      return 'null';
    };

    return stringify(obj);
  }

  /**
   * Update pool metrics
   */
  private updateMetrics(): void {
    let totalInstances = 0;
    let idleInstances = 0;
    const configTypes: Record<string, number> = {};

    const now = Date.now();

    for (const [moduleType, typeInstances] of this.instances) {
      configTypes[moduleType] = typeInstances.size;
      totalInstances += typeInstances.size;

      for (const [configHash] of typeInstances) {
        const lastAccess = this.lastAccess.get(`${moduleType}:${configHash}`) || 0;
        if (now - lastAccess > this.config.idleTimeout) {
          idleInstances++;
        }
      }
    }

    this.metrics = {
      totalInstances,
      activeInstances: totalInstances - idleInstances,
      idleInstances,
      memoryUsage: this.estimateMemoryUsage(),
      lastHealthCheck: now,
      configTypes
    };
  }

  /**
   * Estimate memory usage
   */
  private estimateMemoryUsage(): number {
    // Rough estimation - could be improved with actual memory profiling
    let totalSize = 0;

    for (const typeInstances of this.instances.values()) {
      totalSize += typeInstances.size * 1024; // Rough 1KB per instance
    }

    return totalSize;
  }

  /**
   * Start health check timer
   */
  private startHealthCheckTimer(): void {
    this.healthCheckTimer = setInterval(async () => {
      await this.performHealthCheck();
    }, this.config.healthCheckInterval);
  }

  /**
   * Perform health check on all instances
   */
  private async performHealthCheck(): Promise<void> {
    const now = Date.now();
    let healthyCount = 0;
    let unhealthyCount = 0;

    for (const [moduleType, typeInstances] of this.instances) {
      for (const [configHash, instance] of typeInstances) {
        if (instance.isHealthy()) {
          healthyCount++;
        } else {
          unhealthyCount++;
          this.logger.logModule('static-instance-pool', 'health-check-unhealthy', {
            instance: `${moduleType}:${configHash}`
          });
        }
      }
    }

    this.metrics.lastHealthCheck = now;

    if (unhealthyCount > 0) {
      this.logger.logModule('static-instance-pool', 'health-check-summary', {
        healthy: healthyCount,
        unhealthy: unhealthyCount,
        total: healthyCount + unhealthyCount
      });
    }
  }
}
