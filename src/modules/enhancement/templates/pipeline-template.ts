/**
 * Enhanced Pipeline Manager Template
 *
 * This template shows how to create a pipeline manager with debugging capabilities
 * already integrated using the enhancement system.
 */

import type { RCCBaseModule, ErrorHandlingCenter, DebugCenter } from '../../pipeline/types/external-types.js';
import type {
  PipelineRequest,
  PipelineResponse,
  PipelineConfig,
  PipelineManagerConfig,
  ModuleFactory,
  // ModuleDependencies,
  BasePipeline
} from '../../pipeline/interfaces/pipeline-interfaces.js';
import { EnhancementConfigManager } from '../enhancement-config-manager.js';
import type { EnhancedModule } from '../module-enhancement-factory.js';

/**
 * Enhanced Pipeline Manager
 *
 * This template demonstrates the recommended pattern for creating pipeline managers
 * with built-in debugging capabilities using the enhancement system.
 */
export class EnhancedPipelineManager implements RCCBaseModule {
  readonly id: string;
  readonly type: string;
  readonly version: string;
  readonly moduleName = 'EnhancedPipelineManager';
  readonly moduleVersion = '1.0.0';

  private pipelines: Map<string, BasePipeline> = new Map();
  private config: PipelineManagerConfig;
  private enhancedModule: EnhancedModule<this> | null = null;
  private configManager: EnhancementConfigManager;
  private isInitialized = false;

  constructor(
    config: PipelineManagerConfig,
    private errorHandlingCenter: ErrorHandlingCenter,
    private debugCenter: DebugCenter
  ) {
    this.id = 'enhanced-pipeline-manager';
    this.type = 'manager';
    this.version = '1.0.0';
    this.config = config;

    // Initialize enhancement configuration manager
    this.configManager = new EnhancementConfigManager(
      debugCenter,
      (config as any).enhancementConfigPath
    );
  }

  /**
   * Initialize the pipeline manager
   */
  async initialize(): Promise<void> {
    try {
      // Create enhanced version of this module
      this.enhancedModule = await this.configManager.enhanceModule(
        this,
        this.id,
        'pipeline',
        (this.config as any).enhancement
      );

      this.logInfo('initialization-start', {
        pipelineCount: this.config.pipelines.length
      });

      // Validate configuration
      this.validateConfig();

      // Create pipelines
      await this.createPipelines();

      this.isInitialized = true;
      this.logInfo('initialization-success', {
        createdPipelines: this.pipelines.size
      });

    } catch (error) {
      this.logError('initialization-error', { error });
      throw error;
    }
  }

  /**
   * Process request through appropriate pipeline
   */
  async processRequest(request: PipelineRequest): Promise<PipelineResponse> {
    if (!this.isInitialized) {
      throw new Error('Enhanced Pipeline Manager is not initialized');
    }

    try {
      this.logInfo('request-start', {
        requestId: request.route.requestId,
        providerId: request.route.providerId,
        modelId: request.route.modelId
      });

      // Select pipeline
      const pipeline = this.selectPipeline(request.route);

      // Process request through pipeline
      const response = await pipeline.processRequest(request);

      this.logInfo('request-success', {
        requestId: request.route.requestId,
        pipelineId: pipeline.pipelineId,
        processingTime: response.metadata.processingTime
      });

      return response;

    } catch (error) {
      this.logError('request-error', { error, request });
      throw error;
    }
  }

  /**
   * Select pipeline for request
   */
  selectPipeline(routeRequest: {
    providerId: string;
    modelId: string;
    requestId: string;
  }): BasePipeline {
    if (!this.isInitialized) {
      throw new Error('PipelineManager is not initialized');
    }

    const pipelineId = this.generatePipelineId(routeRequest.providerId, routeRequest.modelId);
    const pipeline = this.pipelines.get(pipelineId);

    if (!pipeline) {
      throw new Error(`No pipeline found for ${routeRequest.providerId}.${routeRequest.modelId}`);
    }

    this.logInfo('pipeline-selected', {
      pipelineId,
      providerId: routeRequest.providerId,
      modelId: routeRequest.modelId,
      requestId: routeRequest.requestId
    });

    return pipeline;
  }

  /**
   * Add new pipeline dynamically
   */
  async addPipeline(config: PipelineConfig): Promise<void> {
    try {
      const pipelineId = config.id;

      if (this.pipelines.has(pipelineId)) {
        throw new Error(`Pipeline ${pipelineId} already exists`);
      }

      this.logInfo('pipeline-add-start', { pipelineId });

      // Create and initialize pipeline
      const pipeline = await this.createPipeline(config);

      // Add to pipelines map
      this.pipelines.set(pipelineId, pipeline);

      // Update configuration
      this.config = {
        ...this.config,
        pipelines: [...this.config.pipelines, config]
      };

      this.logInfo('pipeline-add-success', {
        pipelineId,
        totalPipelines: this.pipelines.size
      });

    } catch (error) {
      this.logError('pipeline-add-error', { error, pipelineId: config.id });
      throw error;
    }
  }

  /**
   * Remove pipeline
   */
  async removePipeline(pipelineId: string): Promise<void> {
    try {
      const pipeline = this.pipelines.get(pipelineId);
      if (!pipeline) {
        throw new Error(`Pipeline ${pipelineId} not found`);
      }

      this.logInfo('pipeline-remove-start', { pipelineId });

      // Cleanup pipeline
      await pipeline.cleanup();

      // Remove from pipelines map
      this.pipelines.delete(pipelineId);

      // Update configuration
      this.config = {
        ...this.config,
        pipelines: this.config.pipelines.filter(p => p.id !== pipelineId)
      };

      this.logInfo('pipeline-remove-success', {
        pipelineId,
        remainingPipelines: this.pipelines.size
      });

    } catch (error) {
      this.logError('pipeline-remove-error', { error, pipelineId });
      throw error;
    }
  }

  /**
   * Update pipeline configuration
   */
  async updatePipeline(pipelineId: string, newConfig: Partial<PipelineConfig>): Promise<void> {
    try {
      const existingPipeline = this.pipelines.get(pipelineId);
      if (!existingPipeline) {
        throw new Error(`Pipeline ${pipelineId} not found`);
      }

      this.logInfo('pipeline-update-start', {
        pipelineId,
        updatedFields: Object.keys(newConfig)
      });

      // Remove existing pipeline
      await this.removePipeline(pipelineId);

      // Find and update configuration
      const configIndex = this.config.pipelines.findIndex(p => p.id === pipelineId);
      if (configIndex >= 0) {
        this.config.pipelines[configIndex] = {
          ...this.config.pipelines[configIndex],
          ...newConfig
        };
      }

      // Add updated pipeline
      await this.addPipeline(this.config.pipelines[configIndex]);

      this.logInfo('pipeline-update-success', { pipelineId });

    } catch (error) {
      this.logError('pipeline-update-error', { error, pipelineId });
      throw error;
    }
  }

  /**
   * Get pipeline status
   */
  getPipelineStatus(pipelineId?: string): any {
    if (pipelineId) {
      const pipeline = this.pipelines.get(pipelineId);
      return pipeline ? pipeline.getStatus() : null;
    }

    // Return status of all pipelines
    const statuses: any = {};
    for (const [id, pipeline] of Array.from(this.pipelines.entries())) {
      statuses[id] = pipeline.getStatus();
    }
    return statuses;
  }

  /**
   * Get manager status
   */
  getStatus(): {
    isInitialized: boolean;
    pipelineCount: number;
    pipelines: any;
    enhanced: boolean;
    enhancementTime?: number;
    statistics: any;
  } {
    const baseStatus = {
      isInitialized: this.isInitialized,
      pipelineCount: this.pipelines.size,
      pipelines: this.getPipelineStatus(),
      enhanced: !!this.enhancedModule,
      enhancementTime: this.enhancedModule?.metadata.enhancementTime
    };

    if (this.enhancedModule) {
      return {
        ...baseStatus,
        statistics: this.enhancedModule.logger.getStatistics()
      };
    }

    return {
      ...baseStatus,
      statistics: {
        totalLogs: 0,
        logsByLevel: {},
        logsByCategory: {},
        logsByPipeline: {},
        transformationCount: 0,
        providerRequestCount: 0
      }
    };
  }

  /**
   * Clean up all resources
   */
  async cleanup(): Promise<void> {
    try {
      this.logInfo('cleanup-start');

      // Cleanup all pipelines
      const cleanupPromises = Array.from(this.pipelines.values()).map(pipeline =>
        pipeline.cleanup().catch(error => {
          this.logError('pipeline-cleanup-error', {
            pipelineId: pipeline.pipelineId,
            error: error instanceof Error ? error.message : String(error)
          });
        })
      );

      await Promise.all(cleanupPromises);

      // Clear pipelines
      this.pipelines.clear();

      // Cleanup enhanced module
      if (this.enhancedModule) {
        this.enhancedModule.logger.clearLogs();
      }

      this.isInitialized = false;

      this.logInfo('cleanup-success');

    } catch (error) {
      this.logError('cleanup-error', { error });
      throw error;
    }
  }

  /**
   * Get debug logs for this module
   */
  getDebugLogs() {
    if (!this.enhancedModule) {
      return {
        general: [],
        transformations: [],
        provider: [],
        statistics: {
          totalLogs: 0,
          logsByLevel: {},
          logsByCategory: {},
          logsByPipeline: {},
          transformationCount: 0,
          providerRequestCount: 0
        }
      };
    }

    return {
      general: this.enhancedModule.logger.getRecentLogs(),
      transformations: this.enhancedModule.logger.getTransformationLogs(),
      provider: this.enhancedModule.logger.getProviderLogs(),
      statistics: this.enhancedModule.logger.getStatistics()
    };
  }

  /**
   * Export logs to file
   */
  exportLogs(format: 'json' | 'csv' = 'json') {
    if (!this.enhancedModule) {
      return { error: 'Module not enhanced' };
    }

    return this.enhancedModule.logger.exportLogs(format);
  }

  /**
   * Validate manager configuration
   */
  private validateConfig(): void {
    if (!this.config.pipelines || !Array.isArray(this.config.pipelines)) {
      throw new Error('Pipelines configuration must be an array');
    }

    if (this.config.pipelines.length === 0) {
      throw new Error('At least one pipeline must be configured');
    }

    // Validate each pipeline configuration
    const pipelineIds = new Set<string>();
    this.config.pipelines.forEach((pipeline, index) => {
      if (!pipeline.id) {
        throw new Error(`Pipeline at index ${index} must have an ID`);
      }

      if (pipelineIds.has(pipeline.id)) {
        throw new Error(`Duplicate pipeline ID: ${pipeline.id}`);
      }

      pipelineIds.add(pipeline.id);

      if (!pipeline.provider) {
        throw new Error(`Pipeline ${pipeline.id} must have provider configuration`);
      }

      if (!pipeline.modules) {
        throw new Error(`Pipeline ${pipeline.id} must have modules configuration`);
      }
    });

    this.logInfo('config-validation-success', {
      pipelineCount: this.config.pipelines.length,
      pipelineIds: Array.from(pipelineIds)
    });
  }

  /**
   * Create all configured pipelines
   */
  private async createPipelines(): Promise<void> {
    const creationPromises = this.config.pipelines.map(async (config) => {
      try {
        const pipeline = await this.createPipeline(config);
        this.pipelines.set(config.id, pipeline);

        this.logInfo('pipeline-created', {
          pipelineId: config.id,
          providerType: config.provider.type,
          modules: Object.keys(config.modules)
        });

        return { ok: true, id: config.id } as const;
      } catch (error) {
        this.logError('pipeline-creation-error', {
          pipelineId: config.id,
          error: error instanceof Error ? error.message : String(error)
        });
        return { ok: false, id: config.id, error: error instanceof Error ? error.message : String(error) } as const;
      }
    });

    const results = await Promise.allSettled(creationPromises);
    const created = results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
    const failed = results.length - created;

    this.logInfo('all-pipelines-created', {
      count: this.pipelines.size,
      created,
      failed
    });
  }

  /**
   * Create a single pipeline
   */
  private async createPipeline(config: PipelineConfig): Promise<BasePipeline> {
    // Import BasePipeline dynamically to avoid circular dependencies
    const { BasePipeline } = await import('../../pipeline/core/base-pipeline');

    // Create module factory function
    const moduleFactory: ModuleFactory = async (moduleConfig, _dependencies) => {
      // This would be replaced with actual module creation logic
      // For now, return a simple module
      return {
        id: `module-${Date.now()}`,
        type: 'generic',
        config: moduleConfig,
        initialize: async () => {},
        processIncoming: async (request: any) => request,
        processOutgoing: async (response: any) => response,
        cleanup: async () => {},
        getStatus: () => ({ initialized: true })
      };
    };

    const pipeline = new BasePipeline(
      config,
      this.errorHandlingCenter,
      this.debugCenter,
      moduleFactory
    );

    await pipeline.initialize();
    return pipeline;
  }

  /**
   * Generate pipeline ID from provider and model
   */
  private generatePipelineId(providerId: string, modelId: string): string {
    if (providerId === 'default') {
      return modelId;
    }
    return `${providerId}.${modelId}`;
  }

  /**
   * Log info message
   */
  private logInfo(action: string, data?: any): void {
    if (this.enhancedModule) {
      this.enhancedModule.logger.logPipeline(this.id, action, data);
    }
  }

  /**
   * Log error message
   */
  private logError(action: string, data?: any): void {
    if (this.enhancedModule) {
      this.enhancedModule.logger.logError(data.error, {
        moduleId: this.id,
        action,
        ...data
      });
    }
  }
}