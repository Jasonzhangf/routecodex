/**
 * Base Pipeline Implementation
 *
 * Core pipeline implementation that orchestrates all modules and provides
 * unified request processing with error handling and debugging support.
 */

import type { RCCBaseModule, ErrorHandlingCenter, DebugCenter } from '../types/external-types.js';
import { EnhancementRegistry } from '../../enhancement/module-enhancement-factory.js';
import type {
  PipelineRequest,
  PipelineResponse,
  PipelineError,
  BasePipeline as IBasePipeline,
  PipelineConfig,
  PipelineStatus,
  LLMSwitchModule,
  WorkflowModule,
  CompatibilityModule,
  ProviderModule,
  ModuleDependencies,
  ModuleFactory,
  ModuleConfig
} from '../interfaces/pipeline-interfaces.js';
import { PipelineErrorIntegration } from '../utils/error-integration.js';
import { PipelineDebugLogger } from '../utils/debug-logger.js';
import { DebugEventBus } from 'rcc-debugcenter';
import { ModuleEnhancementFactory } from '../../enhancement/module-enhancement-factory.js';

/**
 * Base pipeline implementation that orchestrates all modules
 */
export class BasePipeline implements IBasePipeline, RCCBaseModule {
  readonly pipelineId: string;
  readonly config: PipelineConfig;
  readonly id: string;
  readonly type: string;
  readonly version: string;
  readonly moduleName = 'BasePipeline';
  readonly moduleVersion = '1.0.0';

  // Debug enhancement properties
  private enhancementFactory!: ModuleEnhancementFactory;
  private isEnhanced = false;
  private debugEventBus!: DebugEventBus;
  private performanceMetrics: Map<string, number[]> = new Map();

  private modules: {
    llmSwitch: LLMSwitchModule | null;
    workflow: WorkflowModule | null;
    compatibility: CompatibilityModule | null;
    provider: ProviderModule | null;
  } = {
    llmSwitch: null,
    workflow: null,
    compatibility: null,
    provider: null
  };

  private errorIntegration: PipelineErrorIntegration;
  private debugLogger: PipelineDebugLogger;
  private isInitialized = false;
  private _status: PipelineStatus;
  private requestCount = 0;
  private errorCount = 0;

  constructor(
    config: PipelineConfig,
    private errorHandlingCenter: ErrorHandlingCenter,
    private debugCenter: DebugCenter,
    private moduleFactory: ModuleFactory // Use the proper ModuleFactory type
  ) {
    this.pipelineId = config.id;
    this.config = config;
    this.id = `pipeline-${config.id}`;
    this.type = 'pipeline';
    this.version = '1.0.0';

    // Initialize status
    this._status = {
      id: this.pipelineId,
      state: 'initializing',
      modules: {},
      metrics: {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        averageResponseTime: 0
      }
    };

    // Initialize utilities
    this.errorIntegration = new PipelineErrorIntegration(errorHandlingCenter);
    this.debugLogger = new PipelineDebugLogger(debugCenter);

    // Initialize debug enhancements
    this.initializeDebugEnhancements();
  }

  /**
   * Initialize the pipeline and all modules
   */
  async initialize(): Promise<void> {
    try {
      this.debugLogger.logPipeline(this.pipelineId, 'initializing', {
        config: this.config
      });

      // Initialize modules
      await this.initializeModules();

      // Update status
      this._status.state = 'ready';
      this.updateModuleStatuses();
      this.isInitialized = true;

      this.debugLogger.logPipeline(this.pipelineId, 'initialized', {
        modules: Object.keys(this.modules).filter(key => this.modules[key as keyof typeof this.modules] !== null)
      });

    } catch (error) {
      this._status.state = 'error';
      await this.handleInitializationError(error);
      throw error;
    }
  }

  /**
   * Process a pipeline request with enhanced debug support
   */
  async processRequest(request: PipelineRequest): Promise<PipelineResponse> {
    if (!this.isInitialized) {
      throw new Error(`Pipeline ${this.pipelineId} is not initialized`);
    }

    const startTime = Date.now();
    const requestId = request.route?.requestId || `req-${Date.now()}-${this.pipelineId}`;
    const debugStages: string[] = [];
    const transformationLogs: any[] = [];
    const timings: Record<string, number> = {};

    try {
      this.debugLogger.logRequest(requestId, 'pipeline-start', {
        ...request,
        enhanced: this.isEnhanced,
        debugInfo: this.getDebugInfo()
      });

      // Publish pipeline start event
      this.publishToWebSocket({
        type: 'pipeline',
        timestamp: startTime,
        data: {
          operation: 'start',
          pipelineId: this.pipelineId,
          requestId,
          request: this.sanitizeRequest(request),
          enhanced: this.isEnhanced
        }
      });

      // Update request count
      this.requestCount++;
      this._status.state = 'processing';

      // Stage 1: LLMSwitch - Protocol transformation
      timings.llmSwitchStart = Date.now();
      let processedRequest = await this.processLLMSwitch(request);
      timings.llmSwitchEnd = Date.now();
      debugStages.push('llm-switch');

      // Stage 2: Workflow - Streaming control
      timings.workflowStart = Date.now();
      processedRequest = await this.processWorkflow(processedRequest);
      timings.workflowEnd = Date.now();
      debugStages.push('workflow');

      // Stage 3: Compatibility - Field mapping
      timings.compatibilityStart = Date.now();
      processedRequest = await this.processCompatibility(processedRequest);
      timings.compatibilityEnd = Date.now();
      debugStages.push('compatibility');

      // Stage 4: Provider - Service execution
      timings.providerStart = Date.now();
      let providerResponse = await this.processProvider(processedRequest);
      timings.providerEnd = Date.now();
      debugStages.push('provider');

      // Stage 5: Response transformation chain (reverse order)
      timings.compatibilityResponseStart = Date.now();
      providerResponse = await this.processCompatibilityResponse(providerResponse);
      timings.compatibilityResponseEnd = Date.now();

      timings.workflowResponseStart = Date.now();
      providerResponse = await this.processWorkflowResponse(providerResponse);
      timings.workflowResponseEnd = Date.now();

      timings.llmSwitchResponseStart = Date.now();
      const finalResponse = await this.processLLMSwitchResponse(providerResponse);
      timings.llmSwitchResponseEnd = Date.now();

      const processingTime = Date.now() - startTime;

      // Update metrics
      this.updateMetrics(processingTime, true);

      // Create response
      const response: PipelineResponse = {
        data: finalResponse,
        metadata: {
          pipelineId: this.pipelineId,
          processingTime,
          stages: debugStages
        },
        debug: request.debug.enabled ? {
          request: request.data,
          response: finalResponse,
          transformations: transformationLogs,
          timings: this.calculateTimings(timings)
        } : undefined
      };

      this.debugLogger.logResponse(requestId, 'pipeline-success', response);
      this._status.state = 'ready';

      return response;

    } catch (error) {
      const processingTime = Date.now() - startTime;
      this.updateMetrics(processingTime, false);
      this.errorCount++;

      await this.handleRequestError(error, request, debugStages);
      throw error;
    }
  }

  /**
   * Get pipeline status
   */
  getStatus(): PipelineStatus {
    return {
      ...this._status,
      modules: { ...this._status.modules },
      metrics: { ...this._status.metrics }
    };
  }

  /**
   * Clean up pipeline resources
   */
  async cleanup(): Promise<void> {
    try {
      this.debugLogger.logPipeline(this.pipelineId, 'cleanup-start');

      // Clean up all modules
      const cleanupPromises = Object.entries(this.modules).map(async ([key, module]) => {
        if (module) {
          try {
            await module.cleanup();
            this.debugLogger.logPipeline(this.pipelineId, 'module-cleanup', { module: key });
          } catch (error) {
            this.debugLogger.logPipeline(this.pipelineId, 'module-cleanup-error', { module: key, error });
          }
        }
      });

      await Promise.all(cleanupPromises);

      // Reset modules
      this.modules = {
        llmSwitch: null,
        workflow: null,
        compatibility: null,
        provider: null
      };

      this.isInitialized = false;
      this._status.state = 'stopped';

      this.debugLogger.logPipeline(this.pipelineId, 'cleanup-complete');

    } catch (error) {
      this.debugLogger.logPipeline(this.pipelineId, 'cleanup-error', { error });
      throw error;
    }
  }

  /**
   * Initialize debug enhancements
   */
  private initializeDebugEnhancements(): void {
    try {
      this.debugEventBus = DebugEventBus.getInstance();

      // Initialize enhancement factory with proper debug center
      this.enhancementFactory = new ModuleEnhancementFactory(this.debugCenter);

      // Register this pipeline for enhancement
      EnhancementRegistry.getInstance().registerConfig(this.pipelineId, {
        enabled: true,
        level: 'detailed',
        consoleLogging: true,
        debugCenter: true,
        performanceTracking: true,
        requestLogging: true,
        errorTracking: true,
        transformationLogging: true
      });

      this.isEnhanced = true;

      this.debugLogger.logPipeline(this.pipelineId, 'debug-enhancements-initialized', {
        enhanced: true,
        eventBusAvailable: !!this.debugEventBus,
        enhancementFactoryAvailable: !!this.enhancementFactory
      });
    } catch (error) {
      this.debugLogger.logPipeline(this.pipelineId, 'debug-enhancements-error', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Subscribe to debug events
   */
  private subscribeToDebugEvents(): void {
    if (!this.debugEventBus) {return;}

    // Subscribe to pipeline-specific events
    this.debugEventBus.subscribe('pipeline-subscription', (event: any) => {
      this.handleDebugEvent(event);
    });
  }

  /**
   * Handle debug events
   */
  private handleDebugEvent(event: any): void {
    // Process debug events for real-time monitoring
    if (event.type === 'performance') {
      this.recordPerformanceMetric(event.data.operationId, event.data.processingTime);
    }

    // Forward to web interface if available
    this.publishToWebSocket(event);
  }

  /**
   * Record performance metrics
   */
  private recordPerformanceMetric(operationId: string, processingTime: number): void {
    if (!this.performanceMetrics.has(operationId)) {
      this.performanceMetrics.set(operationId, []);
    }

    const metrics = this.performanceMetrics.get(operationId)!;
    metrics.push(processingTime);

    // Keep only last 100 measurements
    if (metrics.length > 100) {
      metrics.shift();
    }
  }

  /**
   * Get performance statistics
   */
  getPerformanceStats(operationId?: string): any {
    if (operationId) {
      const metrics = this.performanceMetrics.get(operationId) || [];
      return this.calculateStats(metrics);
    }

    // Return stats for all operations
    const allStats: any = {};
    for (const [opId, metrics] of Array.from(this.performanceMetrics.entries())) {
      allStats[opId] = this.calculateStats(metrics);
    }
    return allStats;
  }

  /**
   * Calculate statistics from metrics array
   */
  private calculateStats(metrics: number[]): any {
    if (metrics.length === 0) {
      return { count: 0, avg: 0, min: 0, max: 0 };
    }

    const sum = metrics.reduce((a, b) => a + b, 0);
    const avg = sum / metrics.length;
    const min = Math.min(...metrics);
    const max = Math.max(...metrics);

    return {
      count: metrics.length,
      avg: Math.round(avg),
      min,
      max,
      sum: Math.round(sum)
    };
  }

  /**
   * Publish event to WebSocket for real-time monitoring
   */
  private publishToWebSocket(event: any): void {
    // This will be connected to the WebSocket debug server
    try {
      // Event will be published through the debug center to WebSocket
      this.debugCenter.processDebugEvent({
        sessionId: event.sessionId || 'system',
        moduleId: this.pipelineId,
        operationId: event.operationId || event.type,
        timestamp: event.timestamp || Date.now(),
        type: (event.type || 'debug') as 'start' | 'end' | 'error',
        position: 'middle' as 'start' | 'middle' | 'end',
        data: {
          ...event.data,
          pipelineId: this.pipelineId,
          source: 'base-pipeline'
        }
      });
    } catch (error) {
      // Silent fail if WebSocket is not available
    }
  }

  /**
   * Get detailed debug information
   */
  getDebugInfo(): any {
    return {
      pipelineId: this.pipelineId,
      enhanced: this.isEnhanced,
      eventBusAvailable: !!this.debugEventBus,
      performanceMetrics: this.getPerformanceStats(),
      status: this.getStatus(),
      moduleCount: Object.values(this.modules).filter(m => m !== null).length,
      uptime: Date.now() - (this._status.modules['llm-switch']?.lastActivity || Date.now())
    };
  }

  /**
   * Get debug status with enhanced information
   */
  getDebugStatus(): any {
    const baseStatus = {
      pipelineId: this.pipelineId,
      id: this.id,
      type: this.type,
      version: this.version,
      isInitialized: this.isInitialized,
      isEnhanced: this.isEnhanced
    };

    if (!this.isEnhanced) {
      return baseStatus;
    }

    return {
      ...baseStatus,
      debugInfo: this.getDebugInfo(),
      performanceMetrics: this.getPerformanceStats(),
      status: this.getStatus(),
      modules: this.getModuleDebugInfo(),
      requestStats: {
        totalRequests: this.requestCount,
        errorCount: this.errorCount,
        successRate: this.requestCount > 0 ? `${((this.requestCount - this.errorCount) / this.requestCount * 100).toFixed(2)  }%` : '0%'
      }
    };
  }

  /**
   * Get module debug information
   */
  private getModuleDebugInfo(): any {
    const moduleInfo: any = {};

    for (const [moduleName, module] of Object.entries(this.modules)) {
      if (module) {
        moduleInfo[moduleName] = {
          isInitialized: this.isModuleInitialized(module),
          type: module.type,
          hasDebugStatus: typeof (module as any).getDebugStatus === 'function',
          status: this._status.modules[moduleName] || null
        };
      } else {
        moduleInfo[moduleName] = null;
      }
    }

    return moduleInfo;
  }

  /**
   * Check if module is initialized
   */
  private isModuleInitialized(module: any): boolean {
    return module && typeof module.isInitialized === 'boolean' ? module.isInitialized : false;
  }

  /**
   * Enhanced error handling with debug context
   */
  private async handleEnhancedError(error: unknown, context: any): Promise<void> {
    const errorContext = {
      ...context,
      pipelineId: this.pipelineId,
      enhanced: this.isEnhanced,
      performanceMetrics: this.getPerformanceStats(),
      moduleStatus: this._status.modules
    };

    // Publish enhanced error event
    this.publishToWebSocket({
      type: 'error',
      timestamp: Date.now(),
      data: {
        error: error instanceof Error ? error.message : String(error),
        context: errorContext,
        stack: error instanceof Error ? error.stack : undefined
      }
    });

    // Use existing error integration
    await this.errorIntegration.handleModuleError(error, context);
  }

  /**
   * Sanitize request for WebSocket publishing (remove sensitive data)
   */
  private sanitizeRequest(request: PipelineRequest): any {
    const sanitized = {
      route: request.route,
      metadata: request.metadata,
      debug: request.debug
    };

    // Copy safe data fields
    if ((request as any).data) {
      (sanitized as any).data = {
        model: (request as any).data.model,
        messages: (request as any).data.messages?.map((msg: any) => ({
          role: msg.role,
          content: typeof msg.content === 'string' ? '[CONTENT]' : '[MULTIMODAL_CONTENT]'
        })),
        max_tokens: (request as any).data.max_tokens,
        temperature: (request as any).data.temperature,
        stream: (request as any).data.stream
      };
    }

    return sanitized;
  }

  /**
   * Initialize all modules
   */
  private async initializeModules(): Promise<void> {
    const dependencies: ModuleDependencies = {
      errorHandlingCenter: this.errorHandlingCenter,
      debugCenter: this.debugCenter,
      logger: this.debugLogger
    };

    // Initialize LLMSwitch module
    if (this.config.modules.llmSwitch.enabled !== false) {
      this.modules.llmSwitch = await this.moduleFactory(this.config.modules.llmSwitch, dependencies) as LLMSwitchModule;
      await this.modules.llmSwitch.initialize();
    }

    // Initialize Workflow module
    if (this.config.modules.workflow.enabled !== false) {
      this.modules.workflow = await this.moduleFactory(this.config.modules.workflow, dependencies) as WorkflowModule;
      await this.modules.workflow.initialize();
    }

    // Initialize Compatibility module
    if (this.config.modules.compatibility.enabled !== false) {
      this.modules.compatibility = await this.moduleFactory(this.config.modules.compatibility, dependencies) as CompatibilityModule;
      await this.modules.compatibility.initialize();
    }

    // Initialize Provider module
    if (this.config.modules.provider.enabled !== false) {
      this.modules.provider = await this.moduleFactory(this.config.modules.provider, dependencies) as ProviderModule;
      await this.modules.provider.initialize();
    }

    this.updateModuleStatuses();
  }

  /**
   * Process request through LLMSwitch module
   */
  private async processLLMSwitch(request: PipelineRequest): Promise<any> {
    if (!this.modules.llmSwitch) {
      return request;
    }

    try {
      const transformed = await this.modules.llmSwitch.processIncoming(request.data);
      // Maintain the complete request structure with route information
      const result = {
        ...transformed,
        route: request.route || transformed.route, // Fallback to transformed.route
        metadata: request.metadata || transformed.metadata, // Fallback to transformed.metadata
        debug: request.debug || transformed.debug // Fallback to transformed.debug
      };
      this.debugLogger.logTransformation(request.route?.requestId || transformed.route?.requestId || 'unknown', 'llm-switch-request', request.data, transformed);
      return result;
    } catch (error) {
      await this.errorIntegration.handleModuleError(error, {
        stage: 'llm-switch',
        pipelineId: this.pipelineId,
        requestId: request.route?.requestId || 'unknown'
      });
      throw error;
    }
  }

  /**
   * Process request through Workflow module
   */
  private async processWorkflow(request: any): Promise<any> {
    if (!this.modules.workflow) {
      return request;
    }

    try {
      const processed = await this.modules.workflow.processIncoming(request);
      // Maintain the complete request structure with route information
      const result = {
        ...processed,
        route: request.route || processed.route, // Fallback to processed.route
        metadata: request.metadata || processed.metadata, // Fallback to processed.metadata
        debug: request.debug || processed.debug // Fallback to processed.debug
      };
      this.debugLogger.logTransformation(request.route?.requestId || processed.route?.requestId || 'unknown', 'workflow-request', request, processed);
      return result;
    } catch (error) {
      await this.errorIntegration.handleModuleError(error, {
        stage: 'workflow',
        pipelineId: this.pipelineId,
        requestId: request.route?.requestId || 'unknown'
      });
      throw error;
    }
  }

  /**
   * Process request through Compatibility module
   */
  private async processCompatibility(request: any): Promise<any> {
    if (!this.modules.compatibility) {
      return request;
    }

    try {
      const transformed = await this.modules.compatibility.processIncoming(request);
      // Maintain the complete request structure with route information
      const result = {
        ...transformed,
        route: request.route || transformed.route, // Fallback to transformed.route
        metadata: request.metadata || transformed.metadata, // Fallback to transformed.metadata
        debug: request.debug || transformed.debug // Fallback to transformed.debug
      };
      this.debugLogger.logTransformation(request.route?.requestId || transformed.route?.requestId || 'unknown', 'compatibility-request', request, transformed);
      return result;
    } catch (error) {
      await this.errorIntegration.handleModuleError(error, {
        stage: 'compatibility',
        pipelineId: this.pipelineId,
        requestId: request.route?.requestId || 'unknown'
      });
      throw error;
    }
  }

  /**
   * Process request through Provider module
   */
  private async processProvider(request: any): Promise<any> {
    if (!this.modules.provider) {
      throw new Error('Provider module not available');
    }

    try {
      const response = await this.modules.provider.processIncoming(request);
      this.debugLogger.logProviderRequest(this.pipelineId, 'request-start', request, response);
      return response;
    } catch (error) {
      await this.errorIntegration.handleModuleError(error, {
        stage: 'provider',
        pipelineId: this.pipelineId,
        requestId: request.route?.requestId || 'unknown'
      });
      throw error;
    }
  }

  /**
   * Process response through Compatibility module
   */
  private async processCompatibilityResponse(response: any): Promise<any> {
    if (!this.modules.compatibility) {
      return response;
    }

    try {
      const transformed = await this.modules.compatibility.processOutgoing(response);
      this.debugLogger.logTransformation(response.route?.requestId || 'unknown', 'compatibility-response', response, transformed);
      return transformed;
    } catch (error) {
      await this.errorIntegration.handleModuleError(error, {
        stage: 'compatibility-response',
        pipelineId: this.pipelineId,
        requestId: response.route?.requestId || 'unknown'
      });
      throw error;
    }
  }

  /**
   * Process response through Workflow module
   */
  private async processWorkflowResponse(response: any): Promise<any> {
    if (!this.modules.workflow) {
      return response;
    }

    try {
      const processed = await this.modules.workflow.processOutgoing(response);
      this.debugLogger.logTransformation(response.route?.requestId || 'unknown', 'workflow-response', response, processed);
      return processed;
    } catch (error) {
      await this.errorIntegration.handleModuleError(error, {
        stage: 'workflow-response',
        pipelineId: this.pipelineId,
        requestId: response.route?.requestId || 'unknown'
      });
      throw error;
    }
  }

  /**
   * Process response through LLMSwitch module
   */
  private async processLLMSwitchResponse(response: any): Promise<any> {
    if (!this.modules.llmSwitch) {
      return response;
    }

    try {
      const transformed = await this.modules.llmSwitch.processOutgoing(response);
      this.debugLogger.logTransformation(response.route?.requestId || 'unknown', 'llm-switch-response', response, transformed);
      return transformed;
    } catch (error) {
      await this.errorIntegration.handleModuleError(error, {
        stage: 'llm-switch-response',
        pipelineId: this.pipelineId,
        requestId: response.route?.requestId || 'unknown'
      });
      throw error;
    }
  }

  /**
   * Update pipeline metrics
   */
  private updateMetrics(processingTime: number, success: boolean): void {
    this._status.metrics.totalRequests++;

    if (success) {
      this._status.metrics.successfulRequests++;
    } else {
      this._status.metrics.failedRequests++;
    }

    // Calculate average response time
    const totalRequests = this._status.metrics.totalRequests;
    const currentAverage = this._status.metrics.averageResponseTime;
    this._status.metrics.averageResponseTime =
      (currentAverage * (totalRequests - 1) + processingTime) / totalRequests;
  }

  /**
   * Update module statuses
   */
  private updateModuleStatuses(): void {
    this._status.modules = {
      'llm-switch': this.modules.llmSwitch ? {
        type: this.modules.llmSwitch.type,
        state: 'ready',
        lastActivity: Date.now()
      } : { type: 'none', state: 'disabled', lastActivity: 0 },
      'workflow': this.modules.workflow ? {
        type: this.modules.workflow.type,
        state: 'ready',
        lastActivity: Date.now()
      } : { type: 'none', state: 'disabled', lastActivity: 0 },
      'compatibility': this.modules.compatibility ? {
        type: this.modules.compatibility.type,
        state: 'ready',
        lastActivity: Date.now()
      } : { type: 'none', state: 'disabled', lastActivity: 0 },
      'provider': this.modules.provider ? {
        type: this.modules.provider.type,
        state: 'ready',
        lastActivity: Date.now()
      } : { type: 'none', state: 'disabled', lastActivity: 0 }
    };
  }

  /**
   * Calculate timing information
   */
  private calculateTimings(timings: Record<string, number>): Record<string, number> {
    return {
      llmSwitch: timings.llmSwitchEnd - timings.llmSwitchStart,
      workflow: timings.workflowEnd - timings.workflowStart,
      compatibility: timings.compatibilityEnd - timings.compatibilityStart,
      provider: timings.providerEnd - timings.providerStart,
      compatibilityResponse: timings.compatibilityResponseEnd - timings.compatibilityResponseStart,
      workflowResponse: timings.workflowResponseEnd - timings.workflowResponseStart,
      llmSwitchResponse: timings.llmSwitchResponseEnd - timings.llmSwitchResponseStart,
      total: Math.max(...Object.values(timings)) - Math.min(...Object.values(timings))
    };
  }

  /**
   * Handle initialization error
   */
  private async handleInitializationError(error: unknown): Promise<void> {
    await this.errorIntegration.handleModuleError(error, {
      stage: 'initialization',
      pipelineId: this.pipelineId,
      requestId: 'initialization'
    });
  }

  /**
   * Handle request processing error
   */
  private async handleRequestError(error: unknown, request: PipelineRequest, stages: string[]): Promise<void> {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    const pipelineError: PipelineError = {
      stage: stages[stages.length - 1] || 'unknown',
      code: (errorObj as any).code || 'PROCESSING_ERROR',
      message: errorObj.message,
      details: (errorObj as any).details || { stack: errorObj.stack },
      timestamp: Date.now()
    };

    // Defensive coding for undefined route
    const requestId = request.route?.requestId || 'unknown';
    const route = request.route || { providerId: 'unknown', modelId: 'unknown', requestId, timestamp: Date.now() };

    await this.errorIntegration.handleModuleError(error, {
      stage: pipelineError.stage,
      pipelineId: this.pipelineId,
      requestId: requestId,
      error: pipelineError
    });

    this.debugLogger.logError(pipelineError, {
      requestId: requestId,
      stage: 'pipeline-error',
      stages
    });
  }
}