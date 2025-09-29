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
import type { DebugCenter } from '../types/external-types.js';
import { DebugEventBus } from 'rcc-debugcenter';
import { ModuleEnhancementFactory } from '../../enhancement/module-enhancement-factory.js';

/**
 * Registry entry for module factories
 */
interface RegistryEntry {
  factory: ModuleFactory;
  type: string;
  description?: string;
  dependencies?: string[];
  version?: string;
  registeredAt: number;
  usageCount: number;
  debugEnabled: boolean;
}

/**
 * Pipeline Module Registry Implementation
 */
export class PipelineModuleRegistryImpl implements PipelineModuleRegistry {
  private factories: Map<string, RegistryEntry> = new Map();
  private instances: Map<string, PipelineModule> = new Map();
  private creationCount = 0;

  // Debug enhancement properties
  private isEnhanced = false;
  private debugEventBus: DebugEventBus | null = null;
  private enhancementFactory: ModuleEnhancementFactory | null = null;
  private registryMetrics: Map<string, any> = new Map();
  private creationHistory: any[] = [];
  private maxHistorySize = 100;

  /**
   * Register a module factory with enhanced debugging
   */
  registerModule(type: string, factory: ModuleFactory): void {
    if (this.factories.has(type)) {
      throw new Error(`Module type '${type}' is already registered`);
    }

    const entry: RegistryEntry = {
      factory,
      type,
      description: `Module factory for ${type}`,
      version: '1.0.0',
      registeredAt: Date.now(),
      usageCount: 0,
      debugEnabled: this.isEnhanced
    };

    this.factories.set(type, entry);

    // Enhanced debugging
    if (this.isEnhanced) {
      this.publishRegistryEvent('module-registered', {
        type,
        description: entry.description,
        version: entry.version,
        totalRegistered: this.factories.size
      });
      this.recordRegistryMetric('registration', 1);
    }
  }

  /**
   * Create a module instance with enhanced debugging
   */
  async createModule(config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> {
    const startTime = Date.now();
    const entry = this.factories.get(config.type);

    if (!entry) {
      // Suggest migration for deprecated/old type names
      const suggestions: Record<string, string> = {
        'openai-normalizer': 'llmswitch-openai-openai',
        'llm-switch-openai-openai': 'llmswitch-openai-openai',
        'llm-switch-anthropic-openai': 'llmswitch-anthropic-openai',
      };
      const hint = suggestions[config.type];
      if (this.isEnhanced) {
        this.publishRegistryEvent('creation-failed', {
          type: config.type,
          error: 'No module factory registered',
          availableTypes: this.getAvailableTypes()
        });
      }
      if (hint) {
        throw new Error(`No module factory registered for type: ${config.type}. Did you mean '${hint}'?`);
      }
      throw new Error(`No module factory registered for type: ${config.type}`);
    }

    try {
      // Enhanced creation logging
      if (this.isEnhanced) {
        this.publishRegistryEvent('creation-start', {
          type: config.type,
          config,
          dependencies: Object.keys(dependencies)
        });
      }

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
      entry.usageCount++;

      // Enhanced creation completion logging
      const creationTime = Date.now() - startTime;
      if (this.isEnhanced) {
        this.publishRegistryEvent('creation-complete', {
          type: config.type,
          instanceId,
          creationTime,
          entry,
          totalCreations: this.creationCount,
          activeInstances: this.instances.size
        });
        this.addToCreationHistory({
          type: config.type,
          instanceId,
          creationTime,
          success: true,
          timestamp: Date.now()
        });
        this.recordRegistryMetric('creation_time', creationTime);
      }

      return instance;

    } catch (error) {
      const creationTime = Date.now() - startTime;
      if (this.isEnhanced) {
        this.publishRegistryEvent('creation-error', {
          type: config.type,
          error: error instanceof Error ? error.message : String(error),
          creationTime,
          stack: error instanceof Error ? error.stack : undefined
        });
        this.addToCreationHistory({
          type: config.type,
          creationTime,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          timestamp: Date.now()
        });
      }
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
   * Unregister a module type with enhanced debugging
   */
  unregisterModule(type: string): boolean {
    const hadModule = this.factories.has(type);
    const entry = this.factories.get(type);

    const result = this.factories.delete(type);

    if (this.isEnhanced && hadModule) {
      this.publishRegistryEvent('module-unregistered', {
        type,
        entry,
        remainingTypes: this.factories.size
      });
    }

    return result;
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
   * Get enhanced registry status with debug information
   */
  getStatus(): {
    isInitialized: boolean;
    registeredTypes: number;
    totalCreations: number;
    activeInstances: number;
    moduleTypes: string[];
    debugInfo?: any;
    performanceStats?: any;
    creationHistory?: any[];
  } {
    const baseStatus = {
      isInitialized: this.factories.size > 0,
      registeredTypes: this.factories.size,
      totalCreations: this.creationCount,
      activeInstances: this.instances.size,
      moduleTypes: this.getAvailableTypes()
    };

    // Add enhanced debug information if enabled
    if (this.isEnhanced) {
      return {
        ...baseStatus,
        debugInfo: this.getDebugInfo(),
        performanceStats: this.getPerformanceStats(),
        creationHistory: [...this.creationHistory]
      };
    }

    return baseStatus;
  }

  /**
   * Initialize debug enhancements
   */
  initializeDebugEnhancements(): void {
    try {
      this.debugEventBus = DebugEventBus.getInstance();

      // Create a default debug center for enhancement factory
      const debugCenter = {
        enabled: true,
        logLevel: 'info',
        consoleOutput: true
      };

      // Initialize enhancement factory with proper debug center
      // @ts-ignore - DebugCenter interface mismatch, using mock object
      this.enhancementFactory = new ModuleEnhancementFactory(debugCenter as any);

      // Register this registry for enhancement
      this.enhancementFactory.registerConfig('module-registry', {
        enabled: true,
        level: 'detailed',
        consoleLogging: true,
        debugCenter: true,
        performanceTracking: true,
        requestLogging: true,
        errorTracking: true,
        transformationLogging: true
      });

      // Subscribe to registry-specific events
      this.subscribeToRegistryEvents();

      this.isEnhanced = true;

      console.log('Module registry debug enhancements initialized with full functionality');
    } catch (error) {
      console.warn('Failed to initialize registry debug enhancements:', error);
    }
  }

  /**
   * Subscribe to registry-specific debug events
   */
  private subscribeToRegistryEvents(): void {
    if (!this.debugEventBus) {return;}

    this.debugEventBus.subscribe('registry-subscription', (event: any) => {
      this.handleRegistryDebugEvent(event);
    });
  }

  /**
   * Handle registry debug events
   */
  private handleRegistryDebugEvent(event: any): void {
    // Process registry-specific debug events
    if (event.type === 'performance') {
      this.recordRegistryMetric(event.data.operationId, event.data.processingTime);
    }

    // Forward to web interface
    this.publishToWebSocket(event);
  }

  /**
   * Record registry-level performance metrics
   */
  private recordRegistryMetric(operationId: string, value: number): void {
    if (!this.registryMetrics.has(operationId)) {
      this.registryMetrics.set(operationId, {
        values: [],
        lastUpdated: Date.now()
      });
    }

    const metric = this.registryMetrics.get(operationId)!;
    metric.values.push(value);
    metric.lastUpdated = Date.now();

    // Keep only last 50 measurements
    if (metric.values.length > 50) {
      metric.values.shift();
    }
  }

  /**
   * Get registry performance statistics
   */
  private getPerformanceStats(): any {
    const stats: any = {};

    for (const [operationId, metric] of this.registryMetrics.entries()) {
      const values = metric.values;
      if (values.length > 0) {
        stats[operationId] = {
          count: values.length,
          avg: Math.round(values.reduce((a: any, b: any) => a + b, 0) / values.length),
          min: Math.min(...values),
          max: Math.max(...values),
          lastUpdated: metric.lastUpdated
        };
      }
    }

    return stats;
  }

  /**
   * Get detailed registry debug information
   */
  private getDebugInfo(): any {
    return {
      registryId: 'module-registry',
      enhanced: this.isEnhanced,
      eventBusAvailable: !!this.debugEventBus,
      registeredTypes: this.factories.size,
      totalCreations: this.creationCount,
      activeInstances: this.instances.size,
      performanceStats: this.getPerformanceStats(),
      creationHistorySize: this.creationHistory.length,
      availableTypes: this.getAvailableTypes()
    };
  }

  /**
   * Publish registry-specific events
   */
  private publishRegistryEvent(type: string, data: any): void {
    if (!this.isEnhanced) {return;}

    this.publishToWebSocket({
      type: 'registry',
      timestamp: Date.now(),
      data: {
        operation: type,
        registryId: 'module-registry',
        ...data
      }
    });
  }

  /**
   * Add creation to history for debugging
   */
  private addToCreationHistory(creation: any): void {
    this.creationHistory.push(creation);

    // Keep only recent history
    if (this.creationHistory.length > this.maxHistorySize) {
      this.creationHistory.shift();
    }
  }

  /**
   * Publish event to WebSocket
   */
  private publishToWebSocket(event: any): void {
    if (!this.debugEventBus) {return;}

    try {
      this.debugEventBus.publish({
        sessionId: event.sessionId || 'system',
        moduleId: 'module-registry',
        operationId: event.operationId || event.type,
        timestamp: event.timestamp || Date.now(),
        type: event.type || 'debug',
        position: 'middle',
        data: {
          ...event.data,
          registryId: 'module-registry',
          source: 'module-registry'
        }
      });
    } catch (error) {
      // Silent fail if WebSocket is not available
    }
  }
}
