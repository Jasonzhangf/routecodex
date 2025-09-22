/**
 * Unimplemented Module Factory
 * Factory for creating and managing unimplemented modules
 */

import { RCCUnimplementedModule, type UnimplementedModuleConfig } from './unimplemented-module.js';
import { DebugEventBus } from 'rcc-debugcenter';
import { ErrorHandlingCenter, type ErrorContext } from 'rcc-errorhandling';

/**
 * Unimplemented module instance wrapper
 */
interface UnimplementedModuleInstance {
  module: RCCUnimplementedModule;
  config: UnimplementedModuleConfig;
  createdAt: string;
  lastAccessed: string;
}

/**
 * Unimplemented module factory statistics
 */
export interface UnimplementedModuleFactoryStats {
  totalModules: number;
  totalCalls: number;
  modulesByType: Record<string, number>;
  mostCalledModules: Array<{
    moduleId: string;
    callCount: number;
    lastCalled: string;
  }>;
}

/**
 * Unimplemented Module Factory
 * Central factory for managing all unimplemented modules
 */
export class UnimplementedModuleFactory {
  private modules: Map<string, UnimplementedModuleInstance> = new Map();
  private debugEventBus: DebugEventBus;
  private errorHandling: ErrorHandlingCenter;
  private static instance: UnimplementedModuleFactory;

  private constructor() {
    this.debugEventBus = DebugEventBus.getInstance();
    this.errorHandling = new ErrorHandlingCenter();
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): UnimplementedModuleFactory {
    if (!UnimplementedModuleFactory.instance) {
      UnimplementedModuleFactory.instance = new UnimplementedModuleFactory();
    }
    return UnimplementedModuleFactory.instance;
  }

  /**
   * Initialize the factory
   */
  public async initialize(): Promise<void> {
    try {
      await this.errorHandling.initialize();
      
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'unimplemented-module-factory',
        operationId: 'factory_initialized',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          totalModules: this.modules.size
        }
      });

    } catch (error) {
      await this.handleError(error as Error, 'initialization');
      throw error;
    }
  }

  /**
   * Create or get existing unimplemented module
   */
  public async createModule(config: UnimplementedModuleConfig): Promise<RCCUnimplementedModule> {
    try {
      // Check if module already exists
      let moduleInstance = this.modules.get(config.moduleId);
      
      if (moduleInstance) {
        // Update last accessed time
        moduleInstance.lastAccessed = new Date().toISOString();
        return moduleInstance.module;
      }

      // Create new module
      const module = new RCCUnimplementedModule(config);
      await module.initialize();

      // Store module instance
      const now = new Date().toISOString();
      moduleInstance = {
        module,
        config,
        createdAt: now,
        lastAccessed: now
      };

      this.modules.set(config.moduleId, moduleInstance);

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'unimplemented-module-factory',
        operationId: 'module_created',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          moduleId: config.moduleId,
          moduleName: config.moduleName,
          totalModules: this.modules.size
        }
      });

      return module;

    } catch (error) {
      await this.handleError(error as Error, `create_module_${config.moduleId}`);
      throw error;
    }
  }

  /**
   * Get existing module
   */
  public getModule(moduleId: string): RCCUnimplementedModule | undefined {
    const moduleInstance = this.modules.get(moduleId);
    if (moduleInstance) {
      moduleInstance.lastAccessed = new Date().toISOString();
      return moduleInstance.module;
    }
    return undefined;
  }

  /**
   * Remove module
   */
  public async removeModule(moduleId: string): Promise<void> {
    try {
      const moduleInstance = this.modules.get(moduleId);
      if (!moduleInstance) {
        throw new Error(`Module '${moduleId}' not found`);
      }

      // Destroy module
      await moduleInstance.module.destroy();

      // Remove from map
      this.modules.delete(moduleId);

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'unimplemented-module-factory',
        operationId: 'module_removed',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          moduleId,
          totalModules: this.modules.size
        }
      });

    } catch (error) {
      await this.handleError(error as Error, `remove_module_${moduleId}`);
      throw error;
    }
  }

  /**
   * Get all modules
   */
  public getAllModules(): Map<string, RCCUnimplementedModule> {
    const result = new Map<string, RCCUnimplementedModule>();
    for (const [moduleId, moduleInstance] of this.modules) {
      result.set(moduleId, moduleInstance.module);
    }
    return result;
  }

  /**
   * Get factory statistics
   */
  public getStats(): UnimplementedModuleFactoryStats {
    const stats: UnimplementedModuleFactoryStats = {
      totalModules: this.modules.size,
      totalCalls: 0,
      modulesByType: {},
      mostCalledModules: []
    };

    const moduleStats = [];

    for (const [moduleId, moduleInstance] of this.modules) {
      const moduleStatsData = moduleInstance.module.getStats();
      const moduleType = moduleInstance.config.moduleName.split('-')[0] || 'unknown';
      
      // Update total calls
      stats.totalCalls += moduleStatsData.totalCalls;
      
      // Update modules by type
      stats.modulesByType[moduleType] = (stats.modulesByType[moduleType] || 0) + 1;
      
      // Collect data for most called modules
      if (moduleStatsData.totalCalls > 0) {
        moduleStats.push({
          moduleId,
          callCount: moduleStatsData.totalCalls,
          lastCalled: moduleStatsData.lastCallTime || moduleInstance.lastAccessed
        });
      }
    }

    // Sort by call count and take top 10
    stats.mostCalledModules = moduleStats
      .sort((a, b) => b.callCount - a.callCount)
      .slice(0, 10);

    return stats;
  }

  /**
   * Get modules that have been called
   */
  public getCalledModules(): Array<{
    moduleId: string;
    moduleName: string;
    callCount: number;
    lastCalled: string;
  }> {
    const calledModules = [];

    for (const [moduleId, moduleInstance] of this.modules) {
      const stats = moduleInstance.module.getStats();
      if (stats.totalCalls > 0) {
        calledModules.push({
          moduleId,
          moduleName: moduleInstance.config.moduleName,
          callCount: stats.totalCalls,
          lastCalled: stats.lastCallTime || moduleInstance.lastAccessed
        });
      }
    }

    return calledModules.sort((a, b) => b.callCount - a.callCount);
  }

  /**
   * Get unused modules
   */
  public getUnusedModules(): Array<{
    moduleId: string;
    moduleName: string;
    createdAt: string;
  }> {
    const unusedModules = [];

    for (const [moduleId, moduleInstance] of this.modules) {
      const stats = moduleInstance.module.getStats();
      if (stats.totalCalls === 0) {
        unusedModules.push({
          moduleId,
          moduleName: moduleInstance.config.moduleName,
          createdAt: moduleInstance.createdAt
        });
      }
    }

    return unusedModules;
  }

  /**
   * Reset all module statistics
   */
  public resetAllStats(): void {
    for (const [, moduleInstance] of this.modules) {
      moduleInstance.module.resetStats();
    }

    this.debugEventBus.publish({
      sessionId: `session_${Date.now()}`,
      moduleId: 'unimplemented-module-factory',
      operationId: 'all_stats_reset',
      timestamp: Date.now(),
      type: 'start',
      position: 'middle',
      data: {
        totalModules: this.modules.size
      }
    });
  }

  /**
   * Clean up old modules (not accessed for specified time)
   */
  public async cleanupOldModules(maxAgeHours: number = 24): Promise<number> {
    const now = Date.now();
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    const modulesToRemove: string[] = [];

    for (const [moduleId, moduleInstance] of this.modules) {
      const lastAccessed = new Date(moduleInstance.lastAccessed).getTime();
      if (now - lastAccessed > maxAgeMs) {
        modulesToRemove.push(moduleId);
      }
    }

    // Remove old modules
    for (const moduleId of modulesToRemove) {
      try {
        await this.removeModule(moduleId);
      } catch (error) {
        console.error(`Failed to remove old module ${moduleId}:`, error);
      }
    }

    this.debugEventBus.publish({
      sessionId: `session_${Date.now()}`,
      moduleId: 'unimplemented-module-factory',
      operationId: 'cleanup_completed',
      timestamp: Date.now(),
      type: 'start',
      position: 'middle',
      data: {
        removedModules: modulesToRemove.length,
        maxAgeHours
      }
    });

    return modulesToRemove.length;
  }

  /**
   * Handle error
   */
  private async handleError(error: Error, context: string): Promise<void> {
    try {
      const errorContext: ErrorContext = {
        error: error.message,
        source: `unimplemented-module-factory.${context}`,
        severity: 'medium',
        timestamp: Date.now(),
        moduleId: 'unimplemented-module-factory',
        context: {
          stack: error.stack,
          name: error.name
        }
      };

      await this.errorHandling.handleError(errorContext);
    } catch (handlerError) {
      console.error('Failed to handle error:', handlerError);
      console.error('Original error:', error);
    }
  }

  /**
   * Stop factory and clean up all modules
   */
  public async stop(): Promise<void> {
    try {
      // Destroy all modules
      const moduleIds = Array.from(this.modules.keys());
      for (const moduleId of moduleIds) {
        try {
          await this.removeModule(moduleId);
        } catch (error) {
          console.error(`Error removing module ${moduleId} during factory shutdown:`, error);
        }
      }

      await this.errorHandling.destroy();

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'unimplemented-module-factory',
        operationId: 'factory_stopped',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          totalModules: this.modules.size
        }
      });

    } catch (error) {
      await this.handleError(error as Error, 'stop');
      throw error;
    }
  }
}