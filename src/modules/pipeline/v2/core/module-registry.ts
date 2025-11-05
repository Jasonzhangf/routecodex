/**
 * V2 Module Registry
 *
 * Core module factory and registration system for V2 architecture.
 * Manages module factories and provides controlled instance creation.
 */

import type { ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { UnknownObject } from '../../../../types/common-types.js';
import { createHash } from 'node:crypto';
import type { RequestContext } from '../types/v2-types.js';

/**
 * Module factory interface
 */
export interface ModuleFactory {
  create(dependencies: ModuleDependencies): Promise<V2ModuleInstance>;
  getModuleType(): string;
  getDependencies(): string[];
}

/**
 * V2 Module instance interface
 */
export interface V2ModuleInstance {
  readonly id: string;
  readonly type: string;
  readonly config: UnknownObject;
  readonly dependencies: ModuleDependencies;
  readonly createdAt: number;

  initialize(): Promise<void>;
  processIncoming(request: unknown, context: RequestContext): Promise<unknown>;
  processOutgoing(response: unknown, context: RequestContext): Promise<unknown>;
  cleanup(): Promise<void>;
  isHealthy(): boolean;
  getMetrics(): UnknownObject;
}

/**
 * V2 Module Registry
 *
 * Central registry for all V2 modules with factory pattern.
 * Enforces strict module creation and lifecycle management.
 */
export class V2ModuleRegistry {
  private static readonly instance = new V2ModuleRegistry();
  private readonly factories = new Map<string, ModuleFactory>();
  private readonly instances = new Map<string, Map<string, V2ModuleInstance>>();
  private readonly metrics = new Map<string, ModuleMetrics>();

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): V2ModuleRegistry {
    return V2ModuleRegistry.instance;
  }

  /**
   * Register a module factory
   */
  registerModuleFactory(moduleType: string, factory: ModuleFactory): void {
    if (this.factories.has(moduleType)) {
      throw new Error(`Module type ${moduleType} is already registered`);
    }

    this.factories.set(moduleType, factory);
    this.instances.set(moduleType, new Map());
    this.metrics.set(moduleType, {
      created: 0,
      active: 0,
      errors: 0,
      lastActivity: Date.now()
    });
  }

  /**
   * Create a new module instance
   */
  async createInstance(
    moduleType: string,
    config: UnknownObject,
    dependencies: ModuleDependencies
  ): Promise<V2ModuleInstance> {
    const factory = this.factories.get(moduleType);
    if (!factory) {
      throw new Error(`Unknown module type: ${moduleType}`);
    }

    try {
      const instance = await factory.create(dependencies);

      // Initialize the instance
      await instance.initialize();

      // Store instance
      const typeInstances = this.instances.get(moduleType)!;
      const instanceId = this.generateInstanceId(moduleType);
      typeInstances.set(instanceId, instance);

      // Update metrics
      const metrics = this.metrics.get(moduleType)!;
      metrics.created++;
      metrics.active++;
      metrics.lastActivity = Date.now();

      return instance;
    } catch (error: unknown) {
      const metrics = this.metrics.get(moduleType)!;
      metrics.errors++;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create instance of type ${moduleType}: ${message}`);
    }
  }

  /**
   * Get or create instance (with config-based caching)
   */
  async getOrCreateInstance(
    moduleType: string,
    config: UnknownObject,
    dependencies: ModuleDependencies
  ): Promise<V2ModuleInstance> {
    const configHash = this.hashConfig(config);
    const typeInstances = this.instances.get(moduleType);

    if (typeInstances?.has(configHash)) {
      const instance = typeInstances.get(configHash)!;
      if (instance.isHealthy()) {
        return instance;
      }
      // Remove unhealthy instance
      typeInstances.delete(configHash);
      const metrics = this.metrics.get(moduleType)!;
      metrics.active--;
    }

    // Create new instance
    return this.createInstance(moduleType, config, dependencies);
  }

  /**
   * Get existing instance by ID
   */
  getInstance(moduleType: string, instanceId: string): V2ModuleInstance | undefined {
    const typeInstances = this.instances.get(moduleType);
    return typeInstances?.get(instanceId);
  }

  /**
   * Get all instances of a specific type
   */
  getInstancesByType(moduleType: string): V2ModuleInstance[] {
    const typeInstances = this.instances.get(moduleType);
    return typeInstances ? Array.from(typeInstances.values()) : [];
  }

  /**
   * Get all registered module types
   */
  getRegisteredTypes(): string[] {
    return Array.from(this.factories.keys());
  }

  /**
   * Check if module type is registered
   */
  isTypeRegistered(moduleType: string): boolean {
    return this.factories.has(moduleType);
  }

  /**
   * Cleanup idle instances
   */
  async cleanupIdleInstances(maxIdleTime: number = 300000): Promise<void> {
    const now = Date.now();

    for (const [moduleType, typeInstances] of this.instances) {
      const toRemove: string[] = [];

      for (const [instanceId, instance] of typeInstances) {
        const metrics = instance.getMetrics() as { lastActivity?: number };
        const lastActivity = typeof metrics.lastActivity === 'number' ? metrics.lastActivity : instance.createdAt;

        if (now - lastActivity > maxIdleTime) {
          toRemove.push(instanceId);
        }
      }

      // Remove idle instances
      for (const instanceId of toRemove) {
        const instance = typeInstances.get(instanceId)!;
        await instance.cleanup();
        typeInstances.delete(instanceId);

        const typeMetrics = this.metrics.get(moduleType)!;
        typeMetrics.active--;
      }
    }
  }

  /**
   * Get registry metrics
   */
  getMetrics(): Record<string, ModuleMetrics> {
    const result: Record<string, ModuleMetrics> = {};

    for (const [moduleType, metrics] of this.metrics) {
      result[moduleType] = { ...metrics };
    }

    return result;
  }

  /**
   * Validate registry state
   */
  validate(): ValidationResult {
    const errors: string[] = [];

    // Check for orphaned instances
    for (const [moduleType, typeInstances] of this.instances) {
      for (const [instanceId, instance] of typeInstances) {
        if (!instance.isHealthy()) {
          errors.push(`Unhealthy instance found: ${moduleType}:${instanceId}`);
        }
      }
    }

    // Check metrics consistency
    for (const [moduleType, metrics] of this.metrics) {
      const typeInstances = this.instances.get(moduleType);
      const actualActive = typeInstances ? typeInstances.size : 0;

      if (metrics.active !== actualActive) {
        errors.push(`Metrics inconsistency for ${moduleType}: active=${metrics.active}, actual=${actualActive}`);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      registeredTypes: this.factories.size,
      totalInstances: Array.from(this.instances.values()).reduce((sum, instances) => sum + instances.size, 0)
    };
  }

  /**
   * Generate unique instance ID
   */
  private generateInstanceId(moduleType: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substr(2, 9);
    return `${moduleType}-${timestamp}-${random}`;
  }

  /**
   * Hash configuration for caching
   */
  private hashConfig(config: UnknownObject): string {
    // Use stable stringify to ensure consistent hashing
    const stableString = this.stableStringify(config);
    return createHash('sha256').update(stableString).digest('hex');
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
}

/**
 * Module metrics interface
 */
export interface ModuleMetrics {
  created: number;
  active: number;
  errors: number;
  lastActivity: number;
}

/**
 * Validation result interface
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  registeredTypes?: number;
  totalInstances?: number;
}
