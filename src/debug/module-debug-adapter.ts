/**
 * Module Debug Adapter Implementation
 *
 * This file provides the implementation for module debug adapters that can hook into
 * existing RouteCodex modules and capture method execution, state changes, and events.
 */

import { BaseDebugAdapter } from './base-debug-adapter.js';
import { DebugEventBus } from '../utils/external-mocks.js';
import type {
  ModuleDebugAdapter,
  DebugContext,
  DebugData,
  ModuleDebugData,
  MethodHookOptions,
  MethodHookData,
  DebugAdapterConfig,
  DebugUtils
} from '../types/debug-types.js';
import { DebugSystemEvent } from '../types/debug-types.js';

/**
 * Module Debug Adapter implementation
 */
export class ModuleDebugAdapterImpl extends BaseDebugAdapter implements ModuleDebugAdapter {
  private methodHooks: Map<string, MethodHookOptions> = new Map();
  private hookData: Map<string, MethodHookData[]> = new Map();
  readonly moduleInfo: {
    id: string;
    name: string;
    version: string;
    type: string;
  };
  private originalMethods: Map<string, Function> = new Map();
  private wrappedMethods: Map<string, Function> = new Map();

  /**
   * Constructor
   */
  constructor(
    config: DebugAdapterConfig,
    utils: DebugUtils,
    moduleInfo: {
      id: string;
      name: string;
      version: string;
      type: string;
    }
  ) {
    super(config, utils);
    this.moduleInfo = moduleInfo;
  }

  /**
   * Initialize adapter-specific logic
   */
  protected async doInitialize(options?: Record<string, any>): Promise<void> {
    // Initialize module-specific debugging
    await this.initializeModuleDebugging(options);

    // Publish initialization event
      this.publishEvent(DebugSystemEvent.MODULE_DEBUG_ADAPTER_INITIALIZED, {
        adapterId: this.id,
        moduleInfo: this.moduleInfo,
        options,
        timestamp: Date.now()
      });
  }

  /**
   * Start debugging for specific context
   */
  protected async doStartDebugging(context: DebugContext): Promise<void> {
    // Apply method hooks for this context
    await this.applyMethodHooks(context);

    // Capture initial module state
    await this.captureModuleState(context);

    // Publish session started event
      this.publishEvent(DebugSystemEvent.MODULE_DEBUGGING_STARTED, {
        adapterId: this.id,
        context,
        moduleInfo: this.moduleInfo,
        timestamp: Date.now()
      });
  }

  /**
   * Stop debugging for specific context
   */
  protected async doStopDebugging(context: DebugContext): Promise<void> {
    // Remove method hooks for this context
    await this.removeMethodHooks(context);

    // Cleanup context-specific data
    this.cleanupContextData(context);

    // Publish session ended event
      this.publishEvent(DebugSystemEvent.MODULE_DEBUGGING_STOPPED, {
        adapterId: this.id,
        context,
        moduleInfo: this.moduleInfo,
        timestamp: Date.now()
      });
  }

  /**
   * Get debug data for specific context
   */
  protected async doGetDebugData(context: DebugContext): Promise<DebugData> {
    // Get module-specific debug data
    const moduleDebugData = await this.getModuleDebugData();

    // Filter data for specific context if needed
    const filteredData = this.filterDataForContext(moduleDebugData, context);

    return {
      id: this.debugUtils.generateId(`module_debug_${context.id}`),
      context,
      type: 'custom',
      content: filteredData,
      timestamp: Date.now(),
      metadata: {
        moduleId: this.moduleInfo.id,
        adapterType: 'module'
      }
    };
  }

  /**
   * Configure adapter-specific settings
   */
  protected async doConfigure(config: Record<string, any>): Promise<void> {
    // Apply module-specific configuration
    if (config.hooks) {
      for (const [methodName, hookOptions] of Object.entries(config.hooks)) {
        await this.hookMethod(methodName, hookOptions as MethodHookOptions);
      }
    }

    // Update module configuration
    if (config.moduleConfig) {
      await this.updateModuleConfig(config.moduleConfig);
    }
  }

  /**
   * Cleanup adapter-specific resources
   */
  protected async doDestroy(): Promise<void> {
    // Remove all method hooks
    await this.removeAllMethodHooks();

    // Clear all hook data
    this.hookData.clear();

    // Restore original methods
    await this.restoreOriginalMethods();

    // Publish destroy event
    this.publishEvent('module_debug_adapter_destroyed', {
      adapterId: this.id,
      moduleInfo: this.moduleInfo,
      timestamp: Date.now()
    });
  }

  /**
   * Hook into module method execution
   */
  async hookMethod(methodName: string, options: MethodHookOptions): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('Adapter is not initialized');
    }

    try {
      // Store hook options
      this.methodHooks.set(methodName, {
        enableTiming: true,
        enableParams: true,
        enableResult: true,
        enableErrors: true,
        captureDepth: 3,
        ...options
      });

      // Apply method hook
      await this.applyMethodHook(methodName);

      // Publish hook registered event
      this.publishEvent('method_hook_registered', {
        adapterId: this.id,
        methodName,
        options,
        timestamp: Date.now()
      });

    } catch (error) {
      await this.handleAdapterError('hook_method', error as Error, { methodName, options });
      throw error;
    }
  }

  /**
   * Unhook from module method execution
   */
  async unhookMethod(methodName: string): Promise<void> {
    if (!this.methodHooks.has(methodName)) {
      return;
    }

    try {
      // Remove method hook
      await this.removeMethodHook(methodName);

      // Clean up hook data
      this.hookData.delete(methodName);

      // Publish hook removed event
      this.publishEvent('method_hook_removed', {
        adapterId: this.id,
        methodName,
        timestamp: Date.now()
      });

    } catch (error) {
      await this.handleAdapterError('unhook_method', error as Error, { methodName });
      throw error;
    }
  }

  /**
   * Get module-specific debug data
   */
  async getModuleDebugData(): Promise<ModuleDebugData> {
    const context: DebugContext = {
      id: this.debugUtils.generateId(`module_${this.moduleInfo.id}`),
      type: 'module',
      moduleId: this.moduleInfo.id,
      timestamp: Date.now()
    };

    // Collect all hook data
    const allHookData: MethodHookData[] = [];
    for (const data of this.hookData.values()) {
      allHookData.push(...data);
    }

    // Get current module state
    const state = await this.getCurrentModuleState();

    // Get recent events from DebugEventBus
    const events = await this.getRecentModuleEvents();

    // Get recent errors from ErrorHandlerRegistry
    const errors = await this.getRecentModuleErrors();

    return {
      id: this.debugUtils.generateId(`module_debug_${this.moduleInfo.id}`),
      context,
      type: 'custom',
      timestamp: Date.now(),
      moduleInfo: this.moduleInfo,
      methodHooks: allHookData,
      state,
      events,
      errors,
      content: {
        moduleInfo: this.moduleInfo,
        methodHooks: allHookData,
        state,
        events,
        errors
      }
    };
  }

  /**
   * Initialize module-specific debugging
   */
  private async initializeModuleDebugging(options?: Record<string, any>): Promise<void> {
    // This can be overridden by subclasses to implement module-specific initialization
    if (options?.autoHookMethods) {
      const methods = await this.discoverModuleMethods();
      for (const method of methods) {
        await this.hookMethod(method, {
          enableTiming: true,
          enableParams: false,
          enableResult: false,
          enableErrors: true
        });
      }
    }
  }

  /**
   * Apply method hooks for context
   */
  private async applyMethodHooks(context: DebugContext): Promise<void> {
    // Apply all registered method hooks
    for (const methodName of this.methodHooks.keys()) {
      try {
        await this.applyMethodHook(methodName);
      } catch (error) {
        console.warn(`Failed to apply method hook for ${methodName}:`, error);
      }
    }
  }

  /**
   * Remove method hooks for context
   */
  private async removeMethodHooks(context: DebugContext): Promise<void> {
    // This can be used for context-specific hook removal
    // For now, we keep hooks active for the module lifetime
  }

  /**
   * Capture initial module state
   */
  private async captureModuleState(context: DebugContext): Promise<void> {
    try {
      const state = await this.getCurrentModuleState();

      this.publishEvent('module_state_captured', {
        moduleId: this.moduleInfo.id,
        context,
        state
      });
    } catch (error) {
      console.warn('Failed to capture module state:', error);
    }
  }

  /**
   * Apply method hook to specific method
   */
  private async applyMethodHook(methodName: string): Promise<void> {
    // This should be implemented by subclasses to actually hook into the module
    // For now, we'll just track that the hook is registered
    if (!this.hookData.has(methodName)) {
      this.hookData.set(methodName, []);
    }
  }

  /**
   * Remove method hook from specific method
   */
  private async removeMethodHook(methodName: string): Promise<void> {
    this.methodHooks.delete(methodName);
  }

  /**
   * Get current module state
   */
  private async getCurrentModuleState(): Promise<Record<string, any>> {
    // This should be implemented by subclasses to capture module-specific state
    return {
      timestamp: Date.now(),
      initialized: this.isInitialized,
      activeSessions: this.sessions.size,
      health: this.getHealth(),
      stats: this.getStats()
    };
  }

  /**
   * Get recent module events
   */
  private async getRecentModuleEvents(): Promise<any[]> {
    // This would typically query the DebugEventBus for recent events
    // For now, return empty array
    return [];
  }

  /**
   * Get recent module errors
   */
  private async getRecentModuleErrors(): Promise<any[]> {
    // This would typically query the ErrorHandlerRegistry for recent errors
    // For now, return empty array
    return [];
  }

  /**
   * Update module configuration
   */
  private async updateModuleConfig(config: Record<string, any>): Promise<void> {
    // This should be implemented by subclasses to update module configuration
    console.warn('Module configuration update not implemented for', this.moduleInfo.id);
  }

  /**
   * Discover module methods
   */
  private async discoverModuleMethods(): Promise<string[]> {
    // This should be implemented by subclasses to discover available methods
    return [];
  }

  /**
   * Restore original methods
   */
  private async restoreOriginalMethods(): Promise<void> {
    // Restore all original methods that were wrapped
    for (const [methodName, originalMethod] of this.originalMethods) {
      try {
        // This would typically restore the original method on the target object
        // Implementation depends on the specific module structure
      } catch (error) {
        console.warn(`Failed to restore original method ${methodName}:`, error);
      }
    }

    this.originalMethods.clear();
    this.wrappedMethods.clear();
  }

  /**
   * Remove all method hooks
   */
  private async removeAllMethodHooks(): Promise<void> {
    const hookRemovals = Array.from(this.methodHooks.keys()).map(methodName =>
      this.unhookMethod(methodName).catch(error => {
        console.warn(`Failed to unhook method ${methodName}:`, error);
      })
    );

    await Promise.all(hookRemovals);
  }

  /**
   * Cleanup context-specific data
   */
  private cleanupContextData(context: DebugContext): void {
    // Remove hook data for this context
    for (const [methodName, data] of this.hookData.entries()) {
      const filteredData = data.filter(hook =>
        !hook.metadata?.contextId || hook.metadata.contextId !== context.id
      );
      this.hookData.set(methodName, filteredData);
    }
  }

  /**
   * Filter data for specific context
   */
  private filterDataForContext(data: ModuleDebugData, context: DebugContext): any {
    // Filter hook data for the specific context
    const filteredHookData = data.methodHooks.filter(hook =>
      !hook.metadata?.contextId || hook.metadata.contextId === context.id
    );

    return {
      moduleInfo: data.moduleInfo,
      methodHooks: filteredHookData,
      state: data.state,
      events: data.events,
      errors: data.errors
    };
  }

  /**
   * Record method hook data
   */
  protected recordMethodHookData(methodName: string, hookData: MethodHookData): void {
    if (!this.hookData.has(methodName)) {
      this.hookData.set(methodName, []);
    }

    const data = this.hookData.get(methodName)!;
    data.push(hookData);

    // Keep only recent hook data
    const maxEntries = this.getAdapterConfig().maxHookEntries || 1000;
    if (data.length > maxEntries) {
      this.hookData.set(methodName, data.slice(-maxEntries));
    }

    // Update statistics
    this.stats.totalEvents++;

    // Publish hook execution event
    this.publishEvent('method_hook_executed', {
      moduleId: this.moduleInfo.id,
      methodName,
      hookData: {
        executionTime: hookData.executionTime,
        hasError: !!hookData.error,
        timestamp: hookData.timestamp
      }
    });
  }

  /**
   * Create method wrapper for hooking
   */
  protected createMethodWrapper(
    methodName: string,
    originalMethod: Function,
    options: MethodHookOptions
  ): Function {
    return async (...args: any[]): Promise<any> => {
      const startTime = Date.now();
      const hookData: MethodHookData = {
        methodName,
        executionTime: 0,
        timestamp: startTime
      };

      try {
        // Capture parameters if enabled
        if (options.enableParams) {
          const captureDepth = options.captureDepth || 3;
          hookData.params = this.sanitizeParameters(args, captureDepth);
        }

        // Execute original method
        const result = await originalMethod.apply(this, args);

        // Capture result if enabled
        if (options.enableResult) {
          const captureDepth = options.captureDepth || 3;
          hookData.result = this.sanitizeResult(result, captureDepth);
        }

        // Calculate execution time
        hookData.executionTime = Date.now() - startTime;

        // Record hook data
        this.recordMethodHookData(methodName, hookData);

        return result;

      } catch (error) {
        // Capture error if enabled
        if (options.enableErrors) {
          hookData.error = error as Error;
        }

        // Calculate execution time
        hookData.executionTime = Date.now() - startTime;

        // Record hook data
        this.recordMethodHookData(methodName, hookData);

        throw error;
      }
    };
  }

  /**
   * Sanitize parameters for logging
   */
  private sanitizeParameters(params: any[], depth: number): any[] {
    const actualDepth = depth || 3;
    return this.debugUtils.sanitizeData(params, {
      maxDepth: actualDepth,
      maxArrayLength: 10,
      maxStringLength: 100
    });
  }

  /**
   * Sanitize result for logging
   */
  private sanitizeResult(result: any, depth: number): any {
    const actualDepth = depth || 3;
    return this.debugUtils.sanitizeData(result, {
      maxDepth: actualDepth,
      maxArrayLength: 10,
      maxStringLength: 100
    });
  }
}