/**
 * Pipeline Module Registry Implementation
 *
 * Provides a registry for module factories and manages module
 * instantiation with dependency injection.
 */

import type {
  PipelineModule,
  ModuleConfig,
  PipelineModuleRegistry,
  ModuleFactory,
  ModuleDependencies
} from '../interfaces/pipeline-interfaces.js';

/**
 * Registry entry for module factories
 */
interface RegistryEntry {
  factory: ModuleFactory;
  type: string;
  description?: string;
  dependencies?: string[];
  version?: string;
}

/**
 * Pipeline Module Registry Implementation
 */
export class PipelineModuleRegistryImpl implements PipelineModuleRegistry {
  private factories: Map<string, RegistryEntry> = new Map();
  private instances: Map<string, PipelineModule> = new Map();
  private creationCount = 0;

  /**
   * Register a module factory
   */
  registerModule(type: string, factory: ModuleFactory): void {
    if (this.factories.has(type)) {
      throw new Error(`Module type '${type}' is already registered`);
    }

    const entry: RegistryEntry = {
      factory,
      type,
      description: `Module factory for ${type}`,
      version: '1.0.0'
    };

    this.factories.set(type, entry);
  }

  /**
   * Create a module instance
   */
  async createModule(config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> {
    const entry = this.factories.get(config.type);

    if (!entry) {
      throw new Error(`No module factory registered for type: ${config.type}`);
    }

    try {
      // Validate dependencies
      this.validateDependencies(dependencies);

      // Create module instance
      const instance = await entry.factory(config, dependencies);

      // Validate created instance
      this.validateModuleInstance(instance, config.type);

      // Track instance
      const instanceId = this.generateInstanceId(config.type);
      this.instances.set(instanceId, instance);
      this.creationCount++;

      return instance;

    } catch (error) {
      throw new Error(`Failed to create module of type ${config.type}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get available module types
   */
  getAvailableTypes(): string[] {
    return Array.from(this.factories.keys());
  }

  /**
   * Get module factory information
   */
  getModuleInfo(type: string): RegistryEntry | null {
    return this.factories.get(type) || null;
  }

  /**
   * Check if module type is registered
   */
  hasModule(type: string): boolean {
    return this.factories.has(type);
  }

  /**
   * Unregister a module type
   */
  unregisterModule(type: string): boolean {
    return this.factories.delete(type);
  }

  /**
   * Get registry statistics
   */
  getStatistics(): {
    registeredTypes: number;
    totalCreations: number;
    activeInstances: number;
    typeDetails: Array<{
      type: string;
      version: string;
      description: string;
      creationCount: number;
    }>;
  } {
    const typeDetails = Array.from(this.factories.entries()).map(([type, entry]) => ({
      type,
      version: entry.version || 'unknown',
      description: entry.description || 'No description',
      creationCount: this.getInstanceCountByType(type)
    }));

    return {
      registeredTypes: this.factories.size,
      totalCreations: this.creationCount,
      activeInstances: this.instances.size,
      typeDetails
    };
  }

  /**
   * Get all active instances
   */
  getActiveInstances(): Array<{ id: string; type: string; instance: PipelineModule }> {
    return Array.from(this.instances.entries()).map(([id, instance]) => ({
      id,
      type: this.getInstanceType(instance),
      instance
    }));
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    // Cleanup all active instances
    const cleanupPromises = Array.from(this.instances.values()).map(instance =>
      this.cleanupInstance(instance)
    );

    await Promise.allSettled(cleanupPromises);

    // Clear registries
    this.instances.clear();
    this.factories.clear();
    this.creationCount = 0;
  }

  /**
   * Validate dependencies
   */
  private validateDependencies(dependencies: ModuleDependencies): void {
    if (!dependencies.errorHandlingCenter) {
      throw new Error('errorHandlingCenter is required');
    }

    if (!dependencies.debugCenter) {
      throw new Error('debugCenter is required');
    }

    if (!dependencies.logger) {
      throw new Error('logger is required');
    }
  }

  /**
   * Validate module instance
   */
  private validateModuleInstance(instance: any, expectedType: string): void {
    if (!instance || typeof instance !== 'object') {
      throw new Error('Module instance must be an object');
    }

    // Check required interface methods
    const requiredMethods = [
      'initialize',
      'processIncoming',
      'processOutgoing',
      'cleanup'
    ];

    for (const method of requiredMethods) {
      if (typeof instance[method] !== 'function') {
        throw new Error(`Module instance must implement ${method} method`);
      }
    }

    // Check required properties
    if (!instance.id || typeof instance.id !== 'string') {
      throw new Error('Module instance must have an id property');
    }

    if (!instance.type || typeof instance.type !== 'string') {
      throw new Error('Module instance must have a type property');
    }
  }

  /**
   * Generate unique instance ID
   */
  private generateInstanceId(type: string): string {
    return `${type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get instance count by type
   */
  private getInstanceCountByType(type: string): number {
    let count = 0;
    for (const instance of this.instances.values()) {
      if (this.getInstanceType(instance) === type) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get instance type
   */
  private getInstanceType(instance: PipelineModule): string {
    // Try to get type from instance, fallback to factory lookup
    if (instance.type && typeof instance.type === 'string') {
      return instance.type;
    }

    // Find which factory created this instance
    for (const [type, entry] of this.factories.entries()) {
      if (instance instanceof entry.factory) {
        return type;
      }
    }

    return 'unknown';
  }

  /**
   * Cleanup individual instance
   */
  private async cleanupInstance(instance: PipelineModule): Promise<void> {
    try {
      if (instance.cleanup && typeof instance.cleanup === 'function') {
        await instance.cleanup();
      }
    } catch (error) {
      console.warn(`Failed to cleanup module instance: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get registry status
   */
  getStatus(): {
    isInitialized: boolean;
    registeredTypes: number;
    totalCreations: number;
    activeInstances: number;
    moduleTypes: string[];
  } {
    return {
      isInitialized: this.factories.size > 0,
      registeredTypes: this.factories.size,
      totalCreations: this.creationCount,
      activeInstances: this.instances.size,
      moduleTypes: this.getAvailableTypes()
    };
  }
}