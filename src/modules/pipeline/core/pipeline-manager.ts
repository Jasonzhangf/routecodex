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
import { DebugEventBus } from 'rcc-debugcenter';
import { ModuleEnhancementFactory } from '../../enhancement/module-enhancement-factory.js';
import { Key429Tracker, type Key429ErrorRecord } from '../../../utils/key-429-tracker.js';
import { PipelineHealthManager } from '../../../utils/pipeline-health-manager.js';

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

  // Debug enhancement properties
  private enhancementFactory!: ModuleEnhancementFactory;
  private isEnhanced = false;
  private debugEventBus!: DebugEventBus;
  private managerMetrics: Map<string, any> = new Map();
  private requestHistory: any[] = [];
  private maxHistorySize = 100;

  // 429 error handling properties
  private key429Tracker: Key429Tracker;
  private pipelineHealthManager: PipelineHealthManager;
  private retryAttempts: Map<string, number> = new Map();
  private maxRetries = 3;

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

    // Initialize 429 error handling components
    this.key429Tracker = new Key429Tracker();
    this.pipelineHealthManager = new PipelineHealthManager();

    this.initializeModuleRegistry();
    this.initializeDebugEnhancements();

    // Initialize registry debug enhancements (no debugCenter parameter needed)
    this.registry.initializeDebugEnhancements();
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
      requestId: routeRequest.requestId,
      managerEnhanced: this.isEnhanced
    });

    // Publish selection event with enhanced debug info
    if (this.isEnhanced) {
      this.publishManagerEvent('pipeline-selected', {
        pipelineId,
        providerId: routeRequest.providerId,
        modelId: routeRequest.modelId,
        requestId: routeRequest.requestId,
        pipelineStatus: pipeline.getDebugInfo()
      });
    }

    return pipeline;
  }

  /**
   * Process request through selected pipeline with 429 error handling
   */
  async processRequest(request: PipelineRequest): Promise<PipelineResponse> {
    if (!this.isInitialized) {
      throw new Error('PipelineManager is not initialized');
    }

    const startTime = Date.now();
    const requestId = request.route.requestId;
    const retryKey = `retry_${requestId}_${Date.now()}`;
    const requestContext = {
      requestId,
      providerId: request.route.providerId,
      modelId: request.route.modelId,
      startTime,
      managerEnhanced: this.isEnhanced
    };

    try {
      // Enhanced request logging
      if (this.isEnhanced) {
        this.publishManagerEvent('request-start', requestContext);
        this.recordManagerMetric('request_start', startTime);
      }

      // Select pipeline based on route information
      const pipeline = this.selectPipeline({
        providerId: request.route.providerId,
        modelId: request.route.modelId,
        requestId: request.route.requestId
      });

      // Process request with 429 error handling
      const response = await this.processRequestWithPipeline(pipeline, request, retryKey);

      // Enhanced response logging
      const processingTime = Date.now() - startTime;
      if (this.isEnhanced) {
        this.publishManagerEvent('request-complete', {
          ...requestContext,
          processingTime,
          pipelineDebugInfo: pipeline.getDebugInfo(),
          responseMetadata: response.metadata
        });
        this.recordManagerMetric('request_complete', processingTime);
        this.addToRequestHistory({
          ...requestContext,
          processingTime,
          success: true,
          pipelineId: pipeline.pipelineId
        });
      }

      this.logger.logPipeline('manager', 'request-processed', {
        pipelineId: pipeline.pipelineId,
        processingTime: response.metadata.processingTime,
        requestId: request.route.requestId,
        enhanced: this.isEnhanced
      });

      return response;

    } catch (error) {
      const processingTime = Date.now() - startTime;
      if (this.isEnhanced) {
        this.publishManagerEvent('request-error', {
          ...requestContext,
          processingTime,
          error: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined
        });
        this.addToRequestHistory({
          ...requestContext,
          processingTime,
          success: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      this.logger.logPipeline('manager', 'request-processing-error', {
        error: error instanceof Error ? error.message : String(error),
        requestId: request.route.requestId,
        enhanced: this.isEnhanced
      });

      // Cleanup retry attempts on final error
      this.retryAttempts.delete(retryKey);

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
   * Get debug status with enhanced information
   */
  getDebugStatus(): any {
    const baseStatus = {
      managerId: this.id,
      isInitialized: this.isInitialized,
      type: this.type,
      version: this.version,
      isEnhanced: this.isEnhanced
    };

    if (!this.isEnhanced) {
      return baseStatus;
    }

    return {
      ...baseStatus,
      debugInfo: this.getDebugInfo(),
      performanceStats: this.getPerformanceStats(),
      requestHistory: [...this.requestHistory.slice(-10)], // Last 10 requests
      managerMetrics: this.getManagerMetrics()
    };
  }

  /**
   * Get manager metrics
   */
  private getManagerMetrics(): any {
    const metrics: any = {};

    for (const [operation, metric] of this.managerMetrics.entries()) {
      metrics[operation] = {
        count: metric.values.length,
        lastUpdated: metric.lastUpdated,
        recentValues: metric.values.slice(-5) // Last 5 values
      };
    }

    return metrics;
  }

  /**
   * Get enhanced manager status with debug information
   */
  getStatus(): {
    isInitialized: boolean;
    pipelineCount: number;
    pipelines: any;
    registry: any;
    statistics: any;
    debugInfo?: any;
    performanceStats?: any;
    requestHistory?: any[];
    errorHandling429?: {
      keyTracker: any;
      healthManager: any;
      retryAttempts: number;
    };
  } {
    const baseStatus = {
      isInitialized: this.isInitialized,
      pipelineCount: this.pipelines.size,
      pipelines: this.getPipelineStatus(),
      registry: this.registry.getStatus(),
      statistics: this.logger.getStatistics(),
      errorHandling429: {
        keyTracker: this.key429Tracker.getDebugInfo(),
        healthManager: this.pipelineHealthManager.getDebugInfo(),
        retryAttempts: this.retryAttempts.size
      }
    };

    // Add enhanced debug information if enabled
    if (this.isEnhanced) {
      return {
        ...baseStatus,
        debugInfo: this.getDebugInfo(),
        performanceStats: this.getPerformanceStats(),
        requestHistory: [...this.requestHistory]
      };
    }

    return baseStatus;
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

      // Enhanced logging
      if (this.isEnhanced) {
        this.publishManagerEvent('pipeline-added', {
          pipelineId,
          config,
          totalPipelines: this.pipelines.size
        });
      }

      this.logger.logPipeline('manager', 'pipeline-added', {
        pipelineId,
        totalPipelines: this.pipelines.size,
        enhanced: this.isEnhanced
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
   * Handle 429 error with automatic retry
   */
  private async handle429Error(
    error: any,
    request: PipelineRequest,
    attemptedPipelines: Set<string>,
    retryKey: string
  ): Promise<PipelineResponse> {
    // Extract key from error or request
    const key = this.extractKeyFromError(error) || 'unknown';
    const pipelineIds = Array.from(attemptedPipelines);

    // Record 429 error in tracker
    const trackerResult = this.key429Tracker.record429Error(key, pipelineIds);

    this.logger.logPipeline('manager', '429-error-recorded', {
      key,
      pipelineIds,
      blacklisted: trackerResult.blacklisted,
      shouldRetry: trackerResult.shouldRetry,
      consecutiveCount: trackerResult.record.consecutiveCount
    });

    // If key is blacklisted, don't retry
    if (trackerResult.blacklisted) {
      // Mark affected pipelines as unhealthy
      for (const pipelineId of pipelineIds) {
        this.pipelineHealthManager.record429Error(pipelineId, key);
      }

      throw new Error(`Key ${key} is blacklisted due to too many 429 errors`);
    }

    // Get available pipelines excluding attempted ones
    const availablePipelines = this.getAvailablePipelines(excludeIds => {
      attemptedPipelines.forEach(id => excludeIds.add(id));
      return excludeIds;
    });

    if (availablePipelines.length === 0) {
      throw new Error('No available pipelines for retry after 429 error');
    }

    // Round-robin selection of next pipeline
    const nextPipeline = this.selectNextPipelineRoundRobin(availablePipelines, retryKey);

    this.logger.logPipeline('manager', '429-retry-attempt', {
      retryKey,
      originalError: error.message,
      nextPipeline: nextPipeline.pipelineId,
      attempt: this.retryAttempts.get(retryKey) || 1,
      maxAttempts: this.maxRetries
    });

    // Process request with next pipeline
    return await this.processRequestWithPipeline(nextPipeline, request, retryKey);
  }

  /**
   * Extract key from error
   */
  private extractKeyFromError(error: any): string | null {
    // Try to extract key from error details
    if (error.details?.key) {
      return error.details.key;
    }

    // Try to extract from error context
    if (error.context?.key) {
      return error.context.key;
    }

    // Try to extract from pipeline config
    if (error.config?.auth?.apiKey) {
      return error.config.auth.apiKey;
    }

    // Try to extract from headers or other common places
    if (error.config?.headers?.['Authorization']) {
      return error.config.headers['Authorization'];
    }

    return null;
  }

  /**
   * Get available pipelines for retry
   */
  private getAvailablePipelines(
    excludeFilter: (excludeIds: Set<string>) => Set<string>
  ): BasePipeline[] {
    const excludeIds = excludeFilter(new Set<string>());

    return Array.from(this.pipelines.values()).filter(pipeline => {
      // Skip pipelines that are explicitly excluded
      if (excludeIds.has(pipeline.pipelineId)) {
        return false;
      }

      // Skip unhealthy pipelines
      return this.pipelineHealthManager.isPipelineAvailable(pipeline.pipelineId);
    });
  }

  /**
   * Select next pipeline using round-robin strategy
   */
  private selectNextPipelineRoundRobin(
    availablePipelines: BasePipeline[],
    retryKey: string
  ): BasePipeline {
    if (availablePipelines.length === 0) {
      throw new Error('No available pipelines for round-robin selection');
    }

    // Simple round-robin based on retry count
    const attempt = this.retryAttempts.get(retryKey) || 0;
    const index = attempt % availablePipelines.length;

    return availablePipelines[index];
  }

  /**
   * Process request with specific pipeline and retry tracking
   */
  private async processRequestWithPipeline(
    pipeline: BasePipeline,
    request: PipelineRequest,
    retryKey: string
  ): Promise<PipelineResponse> {
    try {
      const response = await pipeline.processRequest(request);

      // On success, record success and reset retry count
      this.pipelineHealthManager.recordSuccess(pipeline.pipelineId);
      this.retryAttempts.delete(retryKey);

      return response;
    } catch (error) {
      // Check if it's a 429 error
      const errorObj = error as any;
      if (errorObj.statusCode === 429 || errorObj.code === 'HTTP_429') {
        const currentAttempt = this.retryAttempts.get(retryKey) || 0;

        if (currentAttempt < this.maxRetries) {
          this.retryAttempts.set(retryKey, currentAttempt + 1);

          // Handle 429 error with retry
          const attemptedPipelines = new Set([pipeline.pipelineId]);
          return await this.handle429Error(error, request, attemptedPipelines, retryKey);
        }
      }

      // For other errors, just record the error
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.pipelineHealthManager.recordError(pipeline.pipelineId, errorMessage);
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

      // Enhanced logging
      if (this.isEnhanced) {
        this.publishManagerEvent('pipeline-removed', {
          pipelineId,
          remainingPipelines: this.pipelines.size
        });
      }

      this.logger.logPipeline('manager', 'pipeline-removed', {
        pipelineId,
        remainingPipelines: this.pipelines.size,
        enhanced: this.isEnhanced
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

      // Enhanced logging
      if (this.isEnhanced) {
        this.publishManagerEvent('pipeline-updated', {
          pipelineId,
          updatedFields: Object.keys(newConfig),
          newConfig
        });
      }

      this.logger.logPipeline('manager', 'pipeline-updated', {
        pipelineId,
        updatedFields: Object.keys(newConfig),
        enhanced: this.isEnhanced
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
    this.registry.registerModule('llmswitch-openai-openai', this.createOpenAINormalizerModule);
    this.registry.registerModule('llmswitch-anthropic-openai', this.createAnthropicOpenAIConverterModule);
    // Aliases for common config names
    this.registry.registerModule('openai-normalizer', this.createOpenAINormalizerModule);
    this.registry.registerModule('streaming-control', this.createStreamingControlModule);
    this.registry.registerModule('field-mapping', this.createFieldMappingModule);
    this.registry.registerModule('qwen-compatibility', this.createQwenCompatibilityModule);
    // Treat glm-compatibility as passthrough unless a specific module is provided
    this.registry.registerModule('glm-compatibility', this.createPassthroughCompatibilityModule);
    this.registry.registerModule('qwen-provider', this.createQwenProviderModule);
    this.registry.registerModule('generic-http', this.createGenericHTTPModule);
    this.registry.registerModule('lmstudio-http', this.createLMStudioHTTPModule);
    this.registry.registerModule('openai-provider', this.createOpenAIProviderModule);

    // Register LM Studio module factories
    this.registry.registerModule('lmstudio-compatibility', this.createLMStudioCompatibilityModule);
    this.registry.registerModule('passthrough-compatibility', this.createPassthroughCompatibilityModule);
    

    this.logger.logPipeline('manager', 'module-registry-initialized', {
      moduleTypes: this.registry.getAvailableTypes(),
      enhanced: this.isEnhanced
    });
  }

  /**
   * Initialize debug enhancements
   */
  private initializeDebugEnhancements(): void {
    try {
      this.debugEventBus = DebugEventBus.getInstance();

      // Initialize enhancement factory with proper debug center
      this.enhancementFactory = new ModuleEnhancementFactory(this.debugCenter);

      // Register this manager for enhancement
      this.enhancementFactory.registerConfig('pipeline-manager', {
        enabled: true,
        level: 'detailed',
        consoleLogging: true,
        debugCenter: true,
        performanceTracking: true,
        requestLogging: true,
        errorTracking: true,
        transformationLogging: true
      });

      // Subscribe to manager-specific events
      this.subscribeToManagerEvents();

      this.isEnhanced = true;

      this.logger.logPipeline('manager', 'debug-enhancements-initialized', {
        enhanced: true,
        eventBusAvailable: !!this.debugEventBus,
        enhancementFactoryAvailable: !!this.enhancementFactory
      });
    } catch (error) {
      this.logger.logPipeline('manager', 'debug-enhancements-error', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Subscribe to manager-specific debug events
   */
  private subscribeToManagerEvents(): void {
    if (!this.debugEventBus) {return;}

    this.debugEventBus.subscribe('manager-subscription', (event: any) => {
      this.handleManagerDebugEvent(event);
    });
  }

  /**
   * Handle manager debug events
   */
  private handleManagerDebugEvent(event: any): void {
    // Process manager-specific debug events
    if (event.type === 'performance') {
      this.recordManagerMetric(event.data.operationId, event.data.processingTime);
    }

    // Forward to web interface
    this.publishToWebSocket(event);
  }

  /**
   * Record manager-level performance metrics
   */
  private recordManagerMetric(operationId: string, value: number): void {
    if (!this.managerMetrics.has(operationId)) {
      this.managerMetrics.set(operationId, {
        values: [],
        lastUpdated: Date.now()
      });
    }

    const metric = this.managerMetrics.get(operationId)!;
    metric.values.push(value);
    metric.lastUpdated = Date.now();

    // Keep only last 50 measurements
    if (metric.values.length > 50) {
      metric.values.shift();
    }
  }

  /**
   * Get manager performance statistics
   */
  private getPerformanceStats(): any {
    const stats: any = {};

    for (const [operationId, metric] of this.managerMetrics.entries()) {
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
   * Get detailed manager debug information
   */
  private getDebugInfo(): any {
    return {
      managerId: this.id,
      enhanced: this.isEnhanced,
      eventBusAvailable: !!this.debugEventBus,
      pipelineCount: this.pipelines.size,
      performanceStats: this.getPerformanceStats(),
      requestHistorySize: this.requestHistory.length,
      registryStatus: this.registry.getStatus()
    };
  }

  /**
   * Publish manager-specific events
   */
  private publishManagerEvent(type: string, data: any): void {
    if (!this.isEnhanced) {return;}

    this.publishToWebSocket({
      type: 'manager',
      timestamp: Date.now(),
      data: {
        operation: type,
        managerId: this.id,
        ...data
      }
    });
  }

  /**
   * Add request to history for debugging
   */
  private addToRequestHistory(request: any): void {
    this.requestHistory.push({
      ...request,
      timestamp: Date.now()
    });

    // Keep only recent history
    if (this.requestHistory.length > this.maxHistorySize) {
      this.requestHistory.shift();
    }
  }

  /**
   * Publish event to WebSocket
   */
  private publishToWebSocket(event: any): void {
    try {
      this.debugCenter.processDebugEvent({
        sessionId: event.sessionId || 'system',
        moduleId: 'pipeline-manager',
        operationId: event.operationId || event.type,
        timestamp: event.timestamp || Date.now(),
        type: (event.type || 'debug') as 'start' | 'end' | 'error',
        position: 'middle' as 'start' | 'middle' | 'end',
        data: {
          ...event.data,
          managerId: this.id,
          source: 'pipeline-manager'
        }
      });
    } catch (error) {
      // Silent fail if WebSocket is not available
    }
  }

  /**
   * Module factory functions
   */
  private createOpenAINormalizerModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { OpenAINormalizerLLMSwitch } = await import('../modules/llmswitch/openai-normalizer.js');
    return new OpenAINormalizerLLMSwitch(config, dependencies);
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

  private createQwenProviderModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { QwenProvider } = await import('../modules/provider/qwen-provider.js');
    return new QwenProvider(config, dependencies);
  };

  private createGenericHTTPModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { GenericHTTPProvider } = await import('../modules/provider/generic-http-provider.js');
    return new GenericHTTPProvider(config, dependencies);
  };

  private createLMStudioHTTPModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { LMStudioProviderSimple } = await import('../modules/provider/lmstudio-provider-simple.js');
    return new LMStudioProviderSimple(config, dependencies);
  };

  private createOpenAIProviderModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { OpenAIProvider } = await import('../modules/provider/openai-provider.js');
    return new OpenAIProvider(config, dependencies);
  };

  private createLMStudioCompatibilityModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { LMStudioCompatibility } = await import('../modules/compatibility/lmstudio-compatibility.js');
    return new LMStudioCompatibility(config, dependencies);
  };

  private createPassthroughCompatibilityModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { PassthroughCompatibility } = await import('../modules/compatibility/passthrough-compatibility.js');
    return new PassthroughCompatibility(config, dependencies);
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
