/**
 * V2 Pipeline Manager
 *
 * Central management for V2 virtual pipeline architecture.
 * Integrates all V2 components and provides unified API.
 */

import type { V2SystemConfig, PipelineRequest, PipelineResponse, PreRunReport, ValidationResult, SwitchOptions, SwitchReport, ModuleConfig } from '../types/v2-types.js';
import type { InstancePoolMetrics } from './static-instance-pool.js';
import type { RouterMetrics } from './dynamic-router.js';
import type { ConnectionMetrics } from './dynamic-connector.js';
import { StaticInstancePool } from './static-instance-pool.js';
import { DynamicRouter } from './dynamic-router.js';
import { DynamicConnector } from './dynamic-connector.js';
import { V2PipelineAssembler } from './v2-pipeline-assembler.js';
import { ModeSwitch } from './mode-switch.js';
import { V2ConfigLibrary } from '../config/v2-config-library.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';
import { V2ModuleRegistry } from './module-registry.js';
import { StubFactories } from './stub-modules.js';

/**
 * Pipeline Manager Status
 */
export interface PipelineManagerStatus {
  isInitialized: boolean;
  currentMode: 'v1' | 'v2' | 'hybrid';
  v2Config?: V2SystemConfig;
  instancePoolMetrics: InstancePoolMetrics;
  routerMetrics: RouterMetrics;
  connectorMetrics: Record<string, ConnectionMetrics>;
  lastPreRun?: PreRunReport;
  lastValidation?: PreRunReport;
}

/**
 * V2 Pipeline Manager
 *
 * Central coordinator for V2 pipeline architecture.
 * Manages initialization, configuration, and request routing.
 */
export class V2PipelineManager {
  private readonly configLibrary: V2ConfigLibrary;
  private readonly logger: PipelineDebugLogger;

  // Core components
  private instancePool?: StaticInstancePool;
  private router?: DynamicRouter;
  private connector?: DynamicConnector;
  private assembler?: V2PipelineAssembler;
  private modeSwitch?: ModeSwitch;

  // State
  private isInitialized = false;
  private v2Config?: V2SystemConfig;

  constructor(logger?: PipelineDebugLogger) {
    this.configLibrary = V2ConfigLibrary.getInstance();
    this.logger = logger || new PipelineDebugLogger();
  }

  /**
   * Initialize V2 pipeline manager
   */
  async initialize(v2Config: V2SystemConfig): Promise<void> {
    if (this.isInitialized) {
      throw new Error('V2 Pipeline Manager already initialized');
    }

    this.logger.logModule('v2-pipeline-manager', 'initialization-start');

    try {
      // Store configuration
      this.v2Config = v2Config;

      // 1. Initialize instance pool
      this.logger.logModule('v2-pipeline-manager', 'init-instance-pool');
      this.instancePool = new StaticInstancePool(
        v2Config.staticInstances.poolConfig,
        this.logger
      );

      // 2. Initialize router
      this.logger.logModule('v2-pipeline-manager', 'init-router');
      this.router = new DynamicRouter(
        this.instancePool,
        v2Config.virtualPipelines.routeTable,
        this.logger
      );

      // 3. Initialize connector
      this.logger.logModule('v2-pipeline-manager', 'init-connector');
      this.connector = new DynamicConnector(this.logger);

      // 4. Initialize assembler
      this.logger.logModule('v2-pipeline-manager', 'init-assembler');
      this.assembler = new V2PipelineAssembler(
        this.instancePool,
        this.router,
        this.logger
      );

      // 5. Initialize mode switch
      this.logger.logModule('v2-pipeline-manager', 'init-mode-switch');
      this.modeSwitch = new ModeSwitch(
        this.assembler,
        v2Config.system.mode,
        this.logger
      );

      // 6. Register stub factories in dry-run and preload instances for a single, deterministic path
      if (v2Config.system.enableDryRun) {
        const registry = V2ModuleRegistry.getInstance();
        try {
          if (!registry.isTypeRegistered('provider-default')) { registry.registerModuleFactory('provider-default', StubFactories.providerDefault()); }
        } catch { /* already registered */ }
        try {
          if (!registry.isTypeRegistered('compatibility-default')) { registry.registerModuleFactory('compatibility-default', StubFactories.compatibilityDefault()); }
        } catch { /* already registered */ }
        try {
          if (!registry.isTypeRegistered('llmswitch-default')) { registry.registerModuleFactory('llmswitch-default', StubFactories.llmswitchDefault()); }
        } catch { /* already registered */ }
      }

      // 7. Preload instances (always), to avoid runtime instance-missing errors
      this.logger.logModule('v2-pipeline-manager', 'preload-instances');
      const warmupReport = await this.instancePool.preloadInstances(v2Config);

      if (!warmupReport.success) {
        throw new Error(`Instance preloading failed: ${warmupReport.failedInstances.map(f => f.error).join(', ')}`);
      }

      this.logger.logModule('v2-pipeline-manager', 'preload-success', {
        instances: warmupReport.preloadedInstances,
        warnings: warmupReport.warnings.length
      });

      this.isInitialized = true;

      this.logger.logModule('v2-pipeline-manager', 'initialization-complete', {
        mode: v2Config.system.mode,
        dryRun: v2Config.system.enableDryRun,
        routes: v2Config.virtualPipelines.routeTable.routes.length
      });

    } catch (error) {
      this.logger.logModule('v2-pipeline-manager', 'initialization-error', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Process request through V2 pipeline
   */
  async processRequest(request: PipelineRequest): Promise<PipelineResponse> {
    if (!this.isInitialized) {
      throw new Error('V2 Pipeline Manager not initialized');
    }

    if (!this.connector || !this.instancePool) {
      throw new Error('V2 components not properly initialized');
    }

    if (!this.v2Config) {
      throw new Error('V2 configuration not available');
    }

    this.logger.logModule('v2-pipeline-manager', 'request-start', {
      requestId: request.id,
      mode: this.modeSwitch?.getCurrentMode()
    });

    try {
      // Process request through connector
      const response = await this.connector.handleRequest(
        request,
        this.v2Config,
        this.instancePool
      );

      this.logger.logModule('v2-pipeline-manager', 'request-success', {
        requestId: request.id,
        responseId: response.id,
        status: response.status
      });

      return response;

    } catch (error) {
      this.logger.logModule('v2-pipeline-manager', 'request-error', {
        requestId: request.id,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Validate V2 configuration
   */
  async validateConfiguration(v2Config?: V2SystemConfig): Promise<{
    isValid: boolean;
    validation: PreRunReport | null;
    errors: string[];
  }> {
    const configToValidate = v2Config || this.v2Config;

    if (!configToValidate) {
      return {
        isValid: false,
        validation: null,
        errors: ['No V2 configuration available']
      };
    }

    if (!this.assembler) {
      return {
        isValid: false,
        validation: null,
        errors: ['V2 assembler not initialized']
      };
    }

    try {
      const validation = await this.assembler.executePreRun(configToValidate);

      return {
        isValid: validation.success,
        validation,
        errors: validation.failedRoutes.map(f => f.error)
      };

    } catch (error) {
      return {
        isValid: false,
        validation: null,
        errors: [error instanceof Error ? error.message : String(error)]
      };
    }
  }

  /**
   * Switch mode
   */
  async switchMode(
    targetMode: 'v1' | 'v2' | 'hybrid',
    options?: SwitchOptions
  ): Promise<SwitchReport> {
    if (!this.modeSwitch) {
      throw new Error('Mode switch not initialized');
    }

    if (!this.v2Config) {
      throw new Error('V2 configuration not available');
    }

    this.logger.logModule('v2-pipeline-manager', 'mode-switch-start', {
      from: this.modeSwitch.getCurrentMode(),
      to: targetMode
    });

    try {
      let result: SwitchReport;

      switch (targetMode) {
        case 'v2':
          result = await this.modeSwitch.switchToV2(this.v2Config, options);
          break;
        case 'v1':
          result = await this.modeSwitch.switchToV1();
          break;
        case 'hybrid':
          result = await this.modeSwitch.switchToHybrid(this.v2Config, options);
          break;
        default:
          throw new Error(`Invalid target mode: ${targetMode}`);
      }

      this.logger.logModule('v2-pipeline-manager', 'mode-switch-complete', {
        from: result.from,
        to: result.to,
        success: result.success,
        duration: result.duration
      });

      return result;

    } catch (error) {
      this.logger.logModule('v2-pipeline-manager', 'mode-switch-error', {
        targetMode,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get pipeline status
   */
  getStatus(): PipelineManagerStatus {
    const status: PipelineManagerStatus = {
      isInitialized: this.isInitialized,
      currentMode: this.modeSwitch?.getCurrentMode() || 'v1',
      v2Config: this.v2Config,
      instancePoolMetrics: this.instancePool?.getMetrics() || { totalInstances: 0, activeInstances: 0, idleInstances: 0, memoryUsage: 0, lastHealthCheck: Date.now(), configTypes: {} },
      routerMetrics: this.router?.getMetrics() || { totalRoutes: 0, successfulMatches: 0, failedMatches: 0, lastValidationAt: undefined, lastMatchAt: undefined },
      connectorMetrics: this.connector?.getMetrics() || {},
      lastPreRun: this.assembler?.getAssemblyStatus().lastPreRun,
      lastValidation: this.modeSwitch?.getSwitchState().lastValidation
    };

    return status;
  }

  /**
   * Get configuration library
   */
  getConfigLibrary(): V2ConfigLibrary {
    return this.configLibrary;
  }

  /**
   * Simulate data flow
   */
  async simulateDataFlow(v2Config?: V2SystemConfig): Promise<{
    success: boolean;
    results: Array<{
      routeId: string;
      success: boolean;
      error?: string;
      duration: number;
    }>;
  }> {
    if (!this.assembler) {
      throw new Error('V2 assembler not initialized');
    }

    const configToUse = v2Config || this.v2Config;
    if (!configToUse) {
      throw new Error('No V2 configuration available for simulation');
    }

    return await this.assembler.simulateDataFlow(configToUse);
  }

  /**
   * Reload configuration
   */
  async reloadConfiguration(newV2Config: V2SystemConfig): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('Cannot reload configuration: manager not initialized');
    }

    this.logger.logModule('v2-pipeline-manager', 'reload-start');

    try {
      // Shutdown existing components
      await this.shutdown();

      // Wait a brief moment for cleanup
      await new Promise(resolve => setTimeout(resolve, 100));

      // Reinitialize with new configuration
      await this.initialize(newV2Config);

      this.logger.logModule('v2-pipeline-manager', 'reload-complete');

    } catch (error) {
      this.logger.logModule('v2-pipeline-manager', 'reload-error', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get switch statistics
   */
  getSwitchStatistics(): {
  totalSwitches: number;
  successfulSwitches: number;
  failedSwitches: number;
  averageSwitchTime: number;
  modeDistribution: Record<string, number>;
} | null {
    if (!this.modeSwitch) {
      return null;
    }

    return this.modeSwitch.getSwitchStatistics();
  }

  /**
   * Clear switch history
   */
  clearSwitchHistory(): void {
    if (this.modeSwitch) {
      this.modeSwitch.clearSwitchHistory();
    }
  }

  /**
   * Force cleanup of idle connections
   */
  async forceCleanup(): Promise<number> {
    if (!this.connector) {
      return 0;
    }

    return await this.connector.forceCleanupAll();
  }

  /**
   * Shutdown pipeline manager
   */
  async shutdown(): Promise<void> {
    if (!this.isInitialized) {
      return;
    }

    this.logger.logModule('v2-pipeline-manager', 'shutdown-start');

    try {
      // Shutdown in reverse order
      if (this.connector) {
        await this.connector.shutdown();
      }

      if (this.instancePool) {
        await this.instancePool.shutdown();
      }

      // Clear references
      this.instancePool = undefined;
      this.router = undefined;
      this.connector = undefined;
      this.assembler = undefined;
      this.modeSwitch = undefined;

      this.isInitialized = false;

      this.logger.logModule('v2-pipeline-manager', 'shutdown-complete');

    } catch (error) {
      this.logger.logModule('v2-pipeline-manager', 'shutdown-error', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Create V2 configuration from V1
   */
  createV2ConfigFromV1(v1Config: Record<string, unknown>): V2SystemConfig {
    return this.configLibrary.transformV1ToV2(v1Config);
  }

  /**
   * Register custom configuration
   */
  registerConfiguration(configId: string, config: ModuleConfig): void {
    this.configLibrary.registerConfiguration(configId, config);
  }

  /**
   * Get configuration
   */
  getConfiguration(configId: string): ModuleConfig | null {
    return this.configLibrary.getConfiguration(configId);
  }

  /**
   * List all available configurations
   */
  listConfigurations(): Record<string, ModuleConfig> {
    return this.configLibrary.listConfigurations();
  }
}
