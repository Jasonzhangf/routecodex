/**
 * Pipeline Manager Implementation
 *
 * Manages the lifecycle of pipelines and provides request routing
 * to the appropriate pipeline based on provider.model configuration.
 */

import type { RCCBaseModule, ErrorHandlingCenter, DebugCenter } from '../types/external-types.js';
import type {
  PipelineRequest,
  PipelineResponse,
  PipelineConfig,
  PipelineManagerConfig,
  PipelineModuleRegistry,
  ModuleFactory,
  ModuleConfig,
  ModuleDependencies,
  PipelineModule,
  RouteRequest
} from '../interfaces/pipeline-interfaces.js';
import { BasePipeline } from './base-pipeline.js';
import { PipelineModuleRegistryImpl } from '../core/pipeline-registry.js';
import { PipelineDebugLogger } from '../utils/debug-logger.js';

/**
 * Pipeline Manager
 */
export class PipelineManager implements RCCBaseModule {
  readonly id: string;
  readonly type: string;
  readonly version: string;
  readonly moduleName = 'PipelineManager';
  readonly moduleVersion = '1.0.0';

  private pipelines: Map<string, BasePipeline> = new Map();
  private config: PipelineManagerConfig;
  private registry: PipelineModuleRegistry;
  private logger: PipelineDebugLogger;
  private isInitialized = false;

  constructor(
    config: PipelineManagerConfig,
    private errorHandlingCenter: ErrorHandlingCenter,
    private debugCenter: DebugCenter
  ) {
    this.id = 'pipeline-manager';
    this.type = 'manager';
    this.version = '1.0.0';
    this.config = config;
    this.logger = new PipelineDebugLogger(debugCenter);
    this.registry = new PipelineModuleRegistryImpl();
    this.initializeModuleRegistry();
  }

  /**
   * Initialize the pipeline manager and all pipelines
   */
  async initialize(): Promise<void> {
    try {
      this.logger.logPipeline('manager', 'initializing', {
        pipelineCount: this.config.pipelines.length
      });

      // Validate configuration
      this.validateConfig();

      // Pre-create all pipelines
      await this.createPipelines();

      this.isInitialized = true;
      this.logger.logPipeline('manager', 'initialized', {
        createdPipelines: this.pipelines.size
      });

    } catch (error) {
      this.logger.logPipeline('manager', 'initialization-error', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Select pipeline for request based on provider.model routing
   */
  selectPipeline(routeRequest: RouteRequest): BasePipeline {
    if (!this.isInitialized) {
      throw new Error('PipelineManager is not initialized');
    }

    const pipelineId = this.generatePipelineId(routeRequest.providerId, routeRequest.modelId);
    const pipeline = this.pipelines.get(pipelineId);

    if (!pipeline) {
      throw new Error(`No pipeline found for ${routeRequest.providerId}.${routeRequest.modelId}`);
    }

    this.logger.logPipeline('manager', 'pipeline-selected', {
      pipelineId,
      providerId: routeRequest.providerId,
      modelId: routeRequest.modelId,
      requestId: routeRequest.requestId
    });

    return pipeline;
  }

  /**
   * Process request through selected pipeline
   */
  async processRequest(request: PipelineRequest): Promise<PipelineResponse> {
    if (!this.isInitialized) {
      throw new Error('PipelineManager is not initialized');
    }

    try {
      // Select pipeline based on route information
      const pipeline = this.selectPipeline({
        providerId: request.route.providerId,
        modelId: request.route.modelId,
        requestId: request.route.requestId
      });

      // Process request through pipeline
      const response = await pipeline.processRequest(request);

      this.logger.logPipeline('manager', 'request-processed', {
        pipelineId: pipeline.pipelineId,
        processingTime: response.metadata.processingTime,
        requestId: request.route.requestId
      });

      return response;

    } catch (error) {
      this.logger.logPipeline('manager', 'request-processing-error', {
        error: error instanceof Error ? error.message : String(error),
        requestId: request.route.requestId
      });
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
    for (const [id, pipeline] of this.pipelines.entries()) {
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
    registry: any;
    statistics: any;
  } {
    return {
      isInitialized: this.isInitialized,
      pipelineCount: this.pipelines.size,
      pipelines: this.getPipelineStatus(),
      registry: this.registry.getStatus(),
      statistics: this.logger.getStatistics()
    };
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

      // Create module factory function
      const moduleFactory: ModuleFactory = async (moduleConfig: ModuleConfig, dependencies: ModuleDependencies) => {
        return this.registry.createModule(moduleConfig, dependencies);
      };

      // Create and initialize pipeline
      const pipeline = new BasePipeline(
        config,
        this.errorHandlingCenter,
        this.debugCenter,
        moduleFactory
      );

      await pipeline.initialize();

      // Add to pipelines map
      this.pipelines.set(pipelineId, pipeline);

      // Add to configuration - create new config object to avoid readonly assignment
      this.config = {
        ...this.config,
        pipelines: [...this.config.pipelines, config]
      };

      this.logger.logPipeline('manager', 'pipeline-added', {
        pipelineId,
        totalPipelines: this.pipelines.size
      });

    } catch (error) {
      this.logger.logPipeline('manager', 'pipeline-add-error', {
        error: error instanceof Error ? error.message : String(error),
        pipelineId: config.id
      });
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

      // Cleanup pipeline
      await pipeline.cleanup();

      // Remove from pipelines map
      this.pipelines.delete(pipelineId);

      // Remove from configuration - create new config object to avoid readonly assignment
      this.config = {
        ...this.config,
        pipelines: this.config.pipelines.filter(p => p.id !== pipelineId)
      };

      this.logger.logPipeline('manager', 'pipeline-removed', {
        pipelineId,
        remainingPipelines: this.pipelines.size
      });

    } catch (error) {
      this.logger.logPipeline('manager', 'pipeline-remove-error', {
        error: error instanceof Error ? error.message : String(error),
        pipelineId
      });
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

      this.logger.logPipeline('manager', 'pipeline-updated', {
        pipelineId,
        updatedFields: Object.keys(newConfig)
      });

    } catch (error) {
      this.logger.logPipeline('manager', 'pipeline-update-error', {
        error: error instanceof Error ? error.message : String(error),
        pipelineId
      });
      throw error;
    }
  }

  /**
   * Clean up all resources
   */
  async cleanup(): Promise<void> {
    try {
      this.logger.logPipeline('manager', 'cleanup-start');

      // Cleanup all pipelines
      const cleanupPromises = Array.from(this.pipelines.values()).map(pipeline =>
        pipeline.cleanup().catch(error => {
          this.logger.logPipeline('manager', 'pipeline-cleanup-error', {
            pipelineId: pipeline.pipelineId,
            error: error instanceof Error ? error.message : String(error)
          });
        })
      );

      await Promise.all(cleanupPromises);

      // Clear pipelines
      this.pipelines.clear();

      // Cleanup registry
      await this.registry.cleanup();

      // Cleanup logger
      this.logger.clearLogs();

      this.isInitialized = false;

      this.logger.logPipeline('manager', 'cleanup-complete');

    } catch (error) {
      this.logger.logPipeline('manager', 'cleanup-error', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
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

    this.logger.logPipeline('manager', 'config-validation-success', {
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
        // Create module factory function
        const moduleFactory: ModuleFactory = async (moduleConfig: ModuleConfig, dependencies: ModuleDependencies) => {
          return this.registry.createModule(moduleConfig, dependencies);
        };

        const pipeline = new BasePipeline(
          config,
          this.errorHandlingCenter,
          this.debugCenter,
          moduleFactory
        );

        await pipeline.initialize();
        this.pipelines.set(config.id, pipeline);

        this.logger.logPipeline('manager', 'pipeline-created', {
          pipelineId: config.id,
          providerType: config.provider.type,
          modules: Object.keys(config.modules)
        });

        return { ok: true, id: config.id } as const;
      } catch (error) {
        this.logger.logPipeline('manager', 'pipeline-creation-error', {
          pipelineId: config.id,
          error: error instanceof Error ? error.message : String(error)
        });
        return { ok: false, id: config.id, error: error instanceof Error ? error.message : String(error) } as const;
      }
    });

    const results = await Promise.allSettled(creationPromises);
    const created = results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
    const failed = results.length - created;

    this.logger.logPipeline('manager', 'all-pipelines-created', {
      count: this.pipelines.size,
      created,
      failed
    });
  }

  /**
   * Initialize module registry with default factories
   */
  private initializeModuleRegistry(): void {
    // Register default module factories
    this.registry.registerModule('openai-passthrough', this.createOpenAIPassthroughModule);
    this.registry.registerModule('anthropic-openai-converter', this.createAnthropicOpenAIConverterModule);
    this.registry.registerModule('streaming-control', this.createStreamingControlModule);
    this.registry.registerModule('field-mapping', this.createFieldMappingModule);
    this.registry.registerModule('qwen-compatibility', this.createQwenCompatibilityModule);
    this.registry.registerModule('qwen-http', this.createQwenHTTPModule);
    this.registry.registerModule('generic-http', this.createGenericHTTPModule);
    this.registry.registerModule('lmstudio-http', this.createLMStudioHTTPModule);

    // Register LM Studio module factories
    this.registry.registerModule('lmstudio-compatibility', this.createLMStudioCompatibilityModule);
    this.registry.registerModule('lmstudio-sdk', this.createLMStudioSDKModule);

    this.logger.logPipeline('manager', 'module-registry-initialized', {
      moduleTypes: this.registry.getAvailableTypes()
    });
  }

  /**
   * Module factory functions
   */
  private createOpenAIPassthroughModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { OpenAIPassthroughLLMSwitch } = await import('../modules/llmswitch/openai-passthrough.js');
    return new OpenAIPassthroughLLMSwitch(config, dependencies);
  };

  private createAnthropicOpenAIConverterModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { AnthropicOpenAIConverter } = await import('../modules/llmswitch/anthropic-openai-converter.js');
    return new AnthropicOpenAIConverter(config, dependencies);
  };

  private createStreamingControlModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { StreamingControlWorkflow } = await import('../modules/workflow/streaming-control.js');
    return new StreamingControlWorkflow(config, dependencies);
  };

  private createFieldMappingModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { FieldMappingCompatibility } = await import('../modules/compatibility/field-mapping.js');
    return new FieldMappingCompatibility(config, dependencies);
  };

  private createQwenCompatibilityModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { QwenCompatibility } = await import('../modules/compatibility/qwen-compatibility.js');
    return new QwenCompatibility(config, dependencies);
  };

  private createQwenHTTPModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { QwenHTTPProvider } = await import('../modules/provider/qwen-http-provider.js');
    return new QwenHTTPProvider(config, dependencies);
  };

  private createGenericHTTPModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { GenericHTTPProvider } = await import('../modules/provider/generic-http-provider.js');
    return new GenericHTTPProvider(config, dependencies);
  };

  private createLMStudioHTTPModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { LMStudioProviderSimple } = await import('../modules/provider/lmstudio-provider-simple.js');
    return new LMStudioProviderSimple(config, dependencies);
  };
  private createLMStudioCompatibilityModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { LMStudioCompatibility } = await import('../modules/compatibility/lmstudio-compatibility.js');
    return new LMStudioCompatibility(config, dependencies);
  };

  private createLMStudioSDKModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { LMStudioSDKProvider } = await import('../modules/provider/lmstudio-sdk-provider.js');
    return new LMStudioSDKProvider(config, dependencies);
  };

  /**
   * Generate pipeline ID from provider and model
   * Note: providerId here is the routing target (e.g., 'default'), not the actual provider type
   */
  private generatePipelineId(providerId: string, modelId: string): string {
    // For 'default' routing target, use the providerId and modelId directly
    // This allows proper routing to different providers based on configuration
    if (providerId === 'default') {
      return `${modelId}`;
    }
    return `${providerId}.${modelId}`;
  }
}
