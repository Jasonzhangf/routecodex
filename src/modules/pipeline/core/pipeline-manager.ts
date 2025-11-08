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
import { Key429Tracker, /* type Key429ErrorRecord */ } from '../../../utils/key-429-tracker.js';
import { PipelineHealthManager } from '../../../utils/pipeline-health-manager.js';

const APP_VERSION = String(process.env.ROUTECODEX_VERSION || 'dev');

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
  private isEnhanced = false;
  private debugEventBus!: DebugEventBus;
  private managerMetrics: Map<string, { values: number[]; lastUpdated: number }> = new Map();
  private requestHistory: unknown[] = [];
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
    this.version = APP_VERSION;
    this.config = config;
    this.logger = new PipelineDebugLogger(debugCenter);
    this.registry = new PipelineModuleRegistryImpl();

    // Initialize 429 error handling components
    this.key429Tracker = new Key429Tracker();
    this.pipelineHealthManager = new PipelineHealthManager();

    this.initializeModuleRegistry();
    this.initializeDebugEnhancements();
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

      // After creation, expose a concise summary for consistency checks
      try {
        this.logger.logPipeline('manager', 'pipelines-summary', {
          ids: Array.from(this.pipelines.keys()),
          count: this.pipelines.size
        });
      } catch { /* ignore */ }

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
   * Returns list of created pipeline IDs (for router consistency checks)
   */
  public getPipelineIds(): string[] {
    return Array.from(this.pipelines.keys());
  }

  /**
   * Check whether a pipeline with the given id exists
   */
  public hasPipeline(id: string): boolean {
    return this.pipelines.has(id);
  }

  /**
   * Select pipeline for request based on provider.model routing
   */
  selectPipeline(routeRequest: RouteRequest): BasePipeline {
    if (!this.isInitialized) {
      throw new Error('PipelineManager is not initialized');
    }

    // Strict mode: require explicit pipelineId
    const directId = (routeRequest as any).pipelineId as string | undefined;
    if (!directId) {
      const keys = Array.from(this.pipelines.keys());
      this.logger.logPipeline('manager', 'pipeline-id-missing', {
        providerId: routeRequest.providerId,
        modelId: routeRequest.modelId,
        availableCount: keys.length,
        sample: keys.slice(0, 10)
      });
      throw new Error('Pipeline ID missing in route; selection by provider/model is disabled');
    }

    const pipeline = this.pipelines.get(directId);
    if (!pipeline) {
      const keys = Array.from(this.pipelines.keys());
      this.logger.logPipeline('manager', 'pipeline-id-not-found', {
        pipelineId: directId,
        availableCount: keys.length,
        sample: keys.slice(0, 10),
        version: APP_VERSION
      });
      try {
        console.error('[PipelineManager] pipeline-id-not-found', {
          requested: directId,
          known: keys,
          version: APP_VERSION
        });
      } catch { /* non-blocking logging */ }
      throw new Error(`No pipeline found for id ${directId}`);
    }

    this.logger.logPipeline('manager', 'pipeline-selected-direct', {
      pipelineId: directId,
      providerId: routeRequest.providerId,
      modelId: routeRequest.modelId,
      requestId: routeRequest.requestId
    });

    // Publish selection event with enhanced debug info
    if (this.isEnhanced) {
      this.publishManagerEvent('pipeline-selected', {
        pipelineId: (pipeline as any).pipelineId,
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

      // Select pipeline strictly by explicit pipelineId (if provided)
      const pipeline = this.selectPipeline({
        providerId: request.route.providerId,
        modelId: request.route.modelId,
        requestId: request.route.requestId,
        // pass-through for strict selection; tolerated by selectPipeline via structural typing
        ...(request as any)?.route?.pipelineId ? { pipelineId: (request as any).route.pipelineId as string } : {},
      } as any);

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
  getPipelineStatus(pipelineId?: string): unknown {
    if (pipelineId) {
      const pipeline = this.pipelines.get(pipelineId);
      return pipeline ? pipeline.getStatus() : null;
    }

    // Return status of all pipelines
    const statuses: Record<string, unknown> = {};
    for (const [id, pipeline] of this.pipelines.entries()) {
      statuses[id] = pipeline.getStatus();
    }
    return statuses;
  }

  /**
   * Get debug status with enhanced information
   */
  getDebugStatus(): unknown {
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
  private getManagerMetrics(): Record<string, { count: number; lastUpdated: number; recentValues: number[] }> {
    const metrics: Record<string, { count: number; lastUpdated: number; recentValues: number[] }> = {};

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
    pipelines: unknown;
    registry: unknown;
    statistics: unknown;
    debugInfo?: unknown;
    performanceStats?: unknown;
    requestHistory?: unknown[];
    errorHandling429?: {
      keyTracker: unknown;
      healthManager: unknown;
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
    error: unknown,
    request: PipelineRequest,
    attemptedPipelines: Set<string>,
    retryKey: string
  ): Promise<PipelineResponse> {
    // Extract key from error or request; avoid blacklisting unknown keys
    const rawKey = this.extractKeyFromError(error) || 'unknown';
    const pipelineIds = Array.from(attemptedPipelines);
    let trackerResult: { blacklisted: boolean; shouldRetry: boolean; record: any } = { blacklisted: false, shouldRetry: true, record: { consecutiveCount: 0 } } as any;
    if (rawKey && rawKey !== 'unknown') {
      // Record 429 error in tracker only when key is known (fingerprinted)
      trackerResult = this.key429Tracker.record429Error(rawKey, pipelineIds);

      this.logger.logPipeline('manager', '429-error-recorded', {
        key: rawKey,
        pipelineIds,
        blacklisted: trackerResult.blacklisted,
        shouldRetry: trackerResult.shouldRetry,
        consecutiveCount: trackerResult.record.consecutiveCount
      });

      // If key is blacklisted, don't retry
      if (trackerResult.blacklisted) {
        // Mark affected pipelines as unhealthy
        for (const pipelineId of pipelineIds) {
          this.pipelineHealthManager.record429Error(pipelineId, rawKey);
        }

        throw new Error(`Key ${rawKey} is blacklisted due to too many 429 errors`);
      }
    } else {
      // Unknown key: avoid blacklisting; just log and proceed with generic retry flow
      this.logger.logPipeline('manager', '429-error-unknown-key', {
        key: rawKey,
        pipelineIds
      });
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
      originalError: (error instanceof Error ? error.message : String(error)),
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
  private extractKeyFromError(error: unknown): string | null {
    // Try to extract key from error details
    const e = error as Record<string, unknown>;
    const details = e['details'] as Record<string, unknown> | undefined;
    if (details && typeof details['key'] === 'string') {
      return details['key'];
    }

    // Try to extract from error context
    const context = e['context'] as Record<string, unknown> | undefined;
    if (context && typeof context['key'] === 'string') {
      return context['key'];
    }

    // Try to extract from pipeline config
    const config = e['config'] as Record<string, unknown> | undefined;
    const auth = config?.['auth'] as Record<string, unknown> | undefined;
    if (auth && typeof auth['apiKey'] === 'string') {
      return auth['apiKey'];
    }

    // Try to extract from headers or other common places
    const headers = config?.['headers'] as Record<string, unknown> | undefined;
    const authHeader = headers?.['Authorization'] as string | undefined;
    if (typeof authHeader === 'string') {
      return authHeader;
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
      // 禁止 Anthrop ic (/v1/messages) 的任何自动重试，直接抛出错误（零回退策略）
      try {
        const ep = String(((request as any)?.metadata?.entryEndpoint) || '').toLowerCase();
        if (ep === '/v1/messages') {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.pipelineHealthManager.recordError(pipeline.pipelineId, errorMessage);
          throw error;
        }
      } catch { /* ignore and continue */ }
      // Check if it's a 429 error
      const errorObj = error as Record<string, unknown>;
      if (errorObj['statusCode'] === 429 || errorObj['code'] === 'HTTP_429') {
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
      failed,
      version: APP_VERSION
    });

    try {
      console.log('[PipelineManager] pipelines-initialized', {
        total: this.pipelines.size,
        ids: Array.from(this.pipelines.keys()),
        version: APP_VERSION
      });
    } catch { /* ignore console errors */ }
  }

  /**
   * Initialize module registry with default factories
   */
  private initializeModuleRegistry(): void {
    // Register default module factories
    // Canonical LLMSwitch names
    // Route legacy openai normalizer type to conversion router to ensure single entrypoint
    this.registry.registerModule('llmswitch-openai-openai', this.createConversionRouterModule);
    this.registry.registerModule('llmswitch-anthropic-openai', this.createConversionRouterModule);
    this.registry.registerModule('llmswitch-response-chat', this.createConversionRouterModule);
    this.registry.registerModule('llmswitch-conversion-router', this.createConversionRouterModule);
    this.registry.registerModule('llmswitch-responses-passthrough', this.createConversionRouterModule);
    // unified switch removed; use llmswitch-conversion-router instead
    // Aliases for backward compatibility (map to conversion-router to keep single path)
    this.registry.registerModule('openai-normalizer', this.createConversionRouterModule);
    this.registry.registerModule('anthropic-openai-converter', this.createConversionRouterModule);
    this.registry.registerModule('responses-chat-switch', this.createConversionRouterModule);
    this.registry.registerModule('streaming-control', this.createStreamingControlModule);
    this.registry.registerModule('field-mapping', this.createFieldMappingModule);
    // Standard V2 compatibility wrapper (single entry)
    this.registry.registerModule('compatibility', this.createStandardCompatibilityModule);
    this.registry.registerModule('iflow-provider', this.createIFlowProviderModule);
    this.registry.registerModule('glm-http-provider', this.createGLMHTTPProviderModule);
    this.registry.registerModule('generic-openai-provider', this.createGenericOpenAIProviderModule);
    this.registry.registerModule('qwen-provider', this.createQwenProviderModule);
    // Add alias for configuration compatibility
    this.registry.registerModule('qwen', this.createQwenProviderModule);
    // Provider family aliases → concrete provider modules (V2)
    this.registry.registerModule('glm', this.createGLMHTTPProviderModule);
    this.registry.registerModule('openai', this.createOpenAIProviderModule);
    // Responses provider (real SSE passthrough) → uses ProviderFactory to build ResponsesProvider
    this.registry.registerModule('responses', this.createOpenAIProviderModule);
    this.registry.registerModule('lmstudio', this.createLMStudioHTTPModule);
    this.registry.registerModule('iflow', this.createIFlowProviderModule);
    this.registry.registerModule('generic_responses', this.createGenericResponsesProviderModule);
    this.registry.registerModule('generic-http', this.createGenericHTTPModule);
    this.registry.registerModule('lmstudio-http', this.createLMStudioHTTPModule);
    this.registry.registerModule('openai-provider', this.createOpenAIProviderModule);
    this.registry.registerModule('generic-responses', this.createGenericResponsesProviderModule);

    // Register LM Studio module factories
    // Remove legacy compatibility module registrations: only use standard wrapper
    

    this.logger.logPipeline('manager', 'module-registry-initialized', {
      moduleTypes: this.registry.getAvailableTypes(),
      enhanced: this.isEnhanced
    });
  }

  /**
   * Initialize debug enhancements
   */
  private initializeDebugEnhancements(): void {
    // Enhancements removed
    this.isEnhanced = false;
  }

  /**
   * Subscribe to manager-specific debug events
   */
  private subscribeToManagerEvents(): void {
    if (!this.debugEventBus) {return;}

    this.debugEventBus.subscribe('manager-subscription', (event: unknown) => {
      this.handleManagerDebugEvent(event);
    });
  }

  /**
   * Handle manager debug events
   */
  private handleManagerDebugEvent(event: unknown): void {
    // Process manager-specific debug events
    const ev = event as Record<string, unknown>;
    if (ev && typeof ev === 'object' && ev['type'] === 'performance') {
      const data = ev['data'] as Record<string, unknown> | undefined;
      const opId = typeof data?.operationId === 'string' ? data.operationId : undefined;
      const val = typeof data?.processingTime === 'number' ? data.processingTime : undefined;
      if (opId && typeof val === 'number') {
        this.recordManagerMetric(opId, val);
      }
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
  private getPerformanceStats(): Record<string, { count: number; avg: number; min: number; max: number; lastUpdated: number }> {
    const stats: Record<string, { count: number; avg: number; min: number; max: number; lastUpdated: number }> = {};

    for (const [operationId, metric] of this.managerMetrics.entries()) {
      const values = metric.values;
      if (values.length > 0) {
        stats[operationId] = {
          count: values.length,
          avg: Math.round(values.reduce((a: number, b: number) => a + b, 0) / values.length),
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
  private getDebugInfo(): unknown {
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
  private publishManagerEvent(type: string, data: unknown): void {
    if (!this.isEnhanced) {return;}

    const payload = (data && typeof data === 'object') ? (data as Record<string, unknown>) : { value: data };
    this.publishToWebSocket({
      type: 'manager',
      timestamp: Date.now(),
      data: {
        operation: type,
        managerId: this.id,
        ...payload
      }
    });
  }

  /**
   * Add request to history for debugging
   */
  private addToRequestHistory(request: unknown): void {
    const reqObj = (request && typeof request === 'object') ? (request as Record<string, unknown>) : { value: request };
    this.requestHistory.push({
      ...reqObj,
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
  private publishToWebSocket(event: unknown): void {
    try {
      const edata = (event as Record<string, unknown>)?.['data'] as unknown;
      const dataObj = (edata && typeof edata === 'object') ? (edata as Record<string, unknown>) : { value: edata };
      this.debugCenter.processDebugEvent({
        sessionId: (typeof (event as Record<string, unknown>)?.sessionId === 'string'
          ? (event as Record<string, unknown>)?.sessionId as string
          : 'system'),
        moduleId: 'pipeline-manager' as string,
        operationId: (typeof (event as Record<string, unknown>)?.operationId === 'string'
          ? (event as Record<string, unknown>)?.operationId as string
          : String((event as Record<string, unknown>)?.type || 'event')),
        timestamp: (event as Record<string, unknown>)?.timestamp as number || Date.now(),
        type: (((event as Record<string, unknown>)?.type as 'start' | 'end' | 'error') || 'debug') as any,
        position: 'middle' as const,
        data: {
          ...dataObj,
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
    const { OpenAIOpenAIAdapter } = await import('../modules/llmswitch-v2-adapters.js');
    return new OpenAIOpenAIAdapter(config, dependencies) as unknown as PipelineModule;
  };

  private createAnthropicOpenAIConverterModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { AnthropicOpenAIAdapter } = await import('../modules/llmswitch-v2-adapters.js');
    return new AnthropicOpenAIAdapter(config, dependencies) as unknown as PipelineModule;
  };

  private createResponsesChatLLMSwitchModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { ResponsesToChatAdapter } = await import('../modules/llmswitch-v2-adapters.js');
    return new ResponsesToChatAdapter(config, dependencies) as unknown as PipelineModule;
  };

  private createResponsesPassthroughLLMSwitchModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { ResponsesPassthroughAdapter } = await import('../modules/llmswitch-v2-adapters.js');
    return new ResponsesPassthroughAdapter(config, dependencies) as unknown as PipelineModule;
  };

  private createConversionRouterModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { ConversionRouterAdapter } = await import('../modules/llmswitch-v2-adapters.js');
    // Dynamic router: choose codec by entryEndpoint (/v1/messages → anthropic, /v1/responses → responses)
    return new ConversionRouterAdapter(config, dependencies) as unknown as PipelineModule;
  };

  // unified switch factory removed

  private createStreamingControlModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { StreamingControlWorkflow } = await import('../modules/workflow/streaming-control.js');
    return new StreamingControlWorkflow(config, dependencies);
  };

  private createFieldMappingModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { FieldMappingCompatibility } = await import('../modules/compatibility/field-mapping.js');
    return new FieldMappingCompatibility(config, dependencies);
  };

  private createStandardCompatibilityModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { StandardCompatibility } = await import('../modules/compatibility/standard-compatibility.js');
    return new StandardCompatibility(config, dependencies);
  };

  private createQwenCompatibilityModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { QwenCompatibility } = await import('../modules/compatibility/qwen-compatibility.js');
    return new QwenCompatibility(config, dependencies);
  };

  private createQwenProviderModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { ProviderFactory } = await import('../modules/provider/v2/core/provider-factory.js');
    const v2Config = this.toV2ProviderConfig(config);
    const validation = ProviderFactory.validateConfig(v2Config);
    if (!validation.isValid) {
      throw new Error(`Invalid V2 Qwen provider configuration: ${validation.errors.join(', ')}`);
    }
    return ProviderFactory.createProvider(v2Config, dependencies);
  };

  private createIFlowProviderModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { ProviderFactory } = await import('../modules/provider/v2/core/provider-factory.js');
    const v2Config = this.toV2ProviderConfig(config);
    const validation = ProviderFactory.validateConfig(v2Config);
    if (!validation.isValid) {
      throw new Error(`Invalid V2 iFlow provider configuration: ${validation.errors.join(', ')}`);
    }
    return ProviderFactory.createProvider(v2Config, dependencies);
  };

  private createGLMHTTPProviderModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { ProviderFactory } = await import('../modules/provider/v2/core/provider-factory.js');
    const v2Config = this.toV2ProviderConfig(config);
    const validation = ProviderFactory.validateConfig(v2Config);
    if (!validation.isValid) {
      throw new Error(`Invalid V2 GLM provider configuration: ${validation.errors.join(', ')}`);
    }
    return ProviderFactory.createProvider(v2Config, dependencies);
  };

  private createGenericOpenAIProviderModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { ProviderFactory } = await import('../modules/provider/v2/core/provider-factory.js');
    const v2Config = this.toV2ProviderConfig(config);
    const validation = ProviderFactory.validateConfig(v2Config);
    if (!validation.isValid) {
      throw new Error(`Invalid V2 Generic OpenAI provider configuration: ${validation.errors.join(', ')}`);
    }
    return ProviderFactory.createProvider(v2Config, dependencies);
  };

  private createGenericHTTPModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { ProviderFactory } = await import('../modules/provider/v2/core/provider-factory.js');
    const v2Config = this.toV2ProviderConfig(config);
    const validation = ProviderFactory.validateConfig(v2Config);
    if (!validation.isValid) {
      throw new Error(`Invalid V2 generic HTTP provider configuration: ${validation.errors.join(', ')}`);
    }
    return ProviderFactory.createProvider(v2Config, dependencies);
  };

  private createLMStudioHTTPModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { ProviderFactory } = await import('../modules/provider/v2/core/provider-factory.js');
    const v2Config = this.toV2ProviderConfig(config);
    const validation = ProviderFactory.validateConfig(v2Config);
    if (!validation.isValid) {
      throw new Error(`Invalid V2 LMStudio provider configuration: ${validation.errors.join(', ')}`);
    }
    return ProviderFactory.createProvider(v2Config, dependencies);
  };

  private createOpenAIProviderModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { ProviderFactory } = await import('../modules/provider/v2/core/provider-factory.js');
    const v2Config = this.toV2ProviderConfig(config);
    const validation = ProviderFactory.validateConfig(v2Config);
    if (!validation.isValid) {
      throw new Error(`Invalid V2 provider configuration: ${validation.errors.join(', ')}`);
    }
    return ProviderFactory.createProvider(v2Config, dependencies);
  };

  private createGenericResponsesProviderModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { ProviderFactory } = await import('../modules/provider/v2/core/provider-factory.js');
    const v2Config = this.toV2ProviderConfig(config);
    const validation = ProviderFactory.validateConfig(v2Config);
    if (!validation.isValid) {
      throw new Error(`Invalid V2 generic responses provider configuration: ${validation.errors.join(', ')}`);
    }
    return ProviderFactory.createProvider(v2Config, dependencies);
  };

  /**
   * 将组装后的 ModuleConfig 直接转换为 V2 OpenAIStandardConfig（不再走 V1 兼容路径）。
   * 严格要求 provider.config.providerType 存在；不做推测与回退。
   */
  private toV2ProviderConfig(config: ModuleConfig): import('../modules/provider/v2/api/provider-config.js').OpenAIStandardConfig {
    const cfg = (config?.config || {}) as Record<string, unknown>;
    const providerType = typeof cfg['providerType'] === 'string' ? (cfg['providerType'] as string).trim() : '';
    if (!providerType) {
      throw new Error(`Missing required field: provider.config.providerType for module type '${config.type}'`);
    }

    const auth = (cfg['auth'] || {}) as Record<string, unknown>;
    if (!auth || typeof auth !== 'object' || !('type' in auth)) {
      throw new Error(`Missing required field: provider.config.auth for module type '${config.type}'`);
    }

    const baseUrl = (cfg['baseUrl'] as string) || (cfg['baseURL'] as string) || '';
    const endpoint = (cfg['endpoint'] as string) || '';
    const timeout = (cfg['timeout'] as number) || undefined;
    const maxRetries = (cfg['maxRetries'] as number) || undefined;
    const headers = (cfg['headers'] as Record<string, string>) || undefined;
    const model = typeof cfg['model'] === 'string' ? (cfg['model'] as string) : undefined;

    const overrides: Record<string, unknown> = {};
    if (endpoint) overrides['endpoint'] = endpoint;
    if (typeof timeout === 'number') overrides['timeout'] = timeout;
    if (typeof maxRetries === 'number') overrides['maxRetries'] = maxRetries;
    if (headers && Object.keys(headers).length) overrides['headers'] = headers;

    const v2: any = {
      type: 'openai-standard',
      config: {
        providerType,
        auth,
        ...(baseUrl ? { baseUrl } : {}),
        ...(model ? { model } : {}),
        ...(Object.keys(overrides).length ? { overrides } : {})
      }
    };
    return v2;
  }

  private createLMStudioCompatibilityModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { LMStudioCompatibility } = await import('../modules/compatibility/lmstudio-compatibility.js');
    return new LMStudioCompatibility(config, dependencies);
  };

  private createPassthroughCompatibilityModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { PassthroughCompatibility } = await import('../modules/compatibility/passthrough-compatibility.js');
    return new PassthroughCompatibility(config, dependencies);
  };

  private createIFlowCompatibilityModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { iFlowCompatibility } = await import('../modules/compatibility/iflow-compatibility.js');
    return new iFlowCompatibility(config, dependencies);
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
