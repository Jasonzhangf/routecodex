/**
 * Base Pipeline Implementation
 *
 * Core pipeline implementation that orchestrates all modules and provides
 * unified request processing with error handling and debugging support.
 */

import type { RCCBaseModule, ErrorHandlingCenter, DebugCenter } from '../types/external-types.js';
import { PipelineNodeRegistry } from '../orchestrator/node-registry.js';
import { PipelineNodeExecutor } from '../orchestrator/node-executor.js';
import { PipelineContext, type PipelineMetadata } from '../orchestrator/pipeline-context.js';
import type { PipelinePhase } from '../orchestrator/types.js';
import type { PipelineErrorCallback, PipelineWarningCallback, PipelineNodeError } from '../orchestrator/pipeline-node-errors.js';
import { ProviderNode } from '../nodes/provider/provider-node.js';
import { CompatibilityProcessNode } from '../nodes/compatibility/compatibility-node.js';
import { LlmswitchNode } from '../nodes/llmswitch/llmswitch-node.js';
import {
  runCompatibilityRequest as runCompatibilityRequestHelper,
  runCompatibilityResponse as runCompatibilityResponseHelper
} from '../nodes/compatibility/compatibility-runner.js';
import { buildProviderResponseArtifacts } from '../nodes/provider/provider-utils.js';
import type {
  PipelineRequest,
  PipelineResponse,
  PipelineError,
  BasePipeline as IBasePipeline,
  PipelineConfig,
  PipelineStatus,
  CompatibilityModule,
  ProviderModule,
  ModuleDependencies,
  ModuleFactory
} from '../interfaces/pipeline-interfaces.js';
import { PipelineErrorIntegration } from '../utils/error-integration.js';
import { PipelineDebugLogger } from '../utils/debug-logger.js';
import { DebugEventBus } from '../../debugcenter/debug-event-bus-shim.js';
import { PipelineSnapshotRecorder } from '../utils/pipeline-snapshot-recorder.js';
import type { SharedPipelineRequest, SharedPipelineResponse } from '../../../types/shared-dtos.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { PipelineBlueprint } from '../orchestrator/types.js';

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
  private isEnhanced = false;
  private debugEventBus!: DebugEventBus;
  private performanceMetrics: Map<string, number[]> = new Map();
  private readonly nodeRegistry: PipelineNodeRegistry;
  private readonly nodeExecutor: PipelineNodeExecutor;
  private registerBuiltInNodes(): void {
    this.nodeRegistry.register('provider-http', (descriptor) => new ProviderNode(descriptor));
    this.nodeRegistry.register('compatibility-process', (descriptor) => new CompatibilityProcessNode(descriptor));
    const llmswitchImplementations = [
      'sse-input',
      'chat-input',
      'anthropic-input',
      'responses-input',
      'openai-response-input',
      'anthropic-response-input',
      'responses-response-input',
      'chat-process',
      'passthrough-process',
      'response-process',
      'openai-output',
      'anthropic-output',
      'responses-output',
      'sse-output'
    ];
    llmswitchImplementations.forEach((impl) => {
      this.nodeRegistry.register(impl, (descriptor) => new LlmswitchNode(descriptor));
    });
  }

  private modules: {
    compatibility: CompatibilityModule | null;
    provider: ProviderModule | null;
  } = {
    compatibility: null,
    provider: null
  };

  private errorIntegration: PipelineErrorIntegration;
  private debugLogger: PipelineDebugLogger;
  private isInitialized = false;
  private _status: PipelineStatus;
  private requestCount = 0;
  private errorCount = 0;
  private readonly blueprints: {
    request?: PipelineBlueprint | null;
    response?: PipelineBlueprint | null;
  };
  private readonly passthroughPipeline: boolean;

  constructor(
    config: PipelineConfig,
    private errorHandlingCenter: ErrorHandlingCenter,
    private debugCenter: DebugCenter,
    private moduleFactory: ModuleFactory, // Use the proper ModuleFactory type
    blueprints?: {
      request?: PipelineBlueprint | null;
      response?: PipelineBlueprint | null;
    }
  ) {
    this.pipelineId = config.id;
    this.config = config;
    this.id = `pipeline-${config.id}`;
    this.type = 'pipeline';
    this.version = '1.0.0';
    this.blueprints = {
      request: blueprints?.request ?? null,
      response: blueprints?.response ?? null
    };
    this.passthroughPipeline = this.detectPassthroughMode(config, this.blueprints.request ?? null);
    this.nodeRegistry = new PipelineNodeRegistry();
    this.nodeExecutor = new PipelineNodeExecutor(this.nodeRegistry);
    this.registerBuiltInNodes();

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

  private detectPassthroughMode(config: PipelineConfig, blueprint: PipelineBlueprint | null): boolean {
    if (blueprint) {
      return blueprint.processMode === 'passthrough';
    }
    try {
      const llmSwitchCfg = (config.modules?.llmSwitch?.config || {}) as Record<string, unknown>;
      const rawProcess = typeof llmSwitchCfg.process === 'string' ? llmSwitchCfg.process : undefined;
      const reqProcess = typeof llmSwitchCfg.requestProcess === 'string' ? llmSwitchCfg.requestProcess : undefined;
      const moduleType = typeof config.modules?.llmSwitch?.type === 'string'
        ? config.modules.llmSwitch.type.toLowerCase()
        : '';
      const normalized = (value?: string) => (value || '').trim().toLowerCase();
      return (
        normalized(rawProcess) === 'passthrough' ||
        normalized(reqProcess) === 'passthrough' ||
        moduleType.includes('passthrough')
      );
    } catch {
      return false;
    }
  }

  /**
   * Process a pipeline request with enhanced debug support
   */
  async processRequest(request: PipelineRequest): Promise<PipelineResponse> {
    if (!this.isInitialized) {
      throw new Error(`Pipeline ${this.pipelineId} is not initialized`);
    }

    request = this.enrichRequestMetadata(request as SharedPipelineRequest);
    const startTime = Date.now();
    const requestId = request.route?.requestId || `req-${Date.now()}-${this.pipelineId}`;
    const debugStages: string[] = [];
    const transformationLogs: unknown[] = [];
    const timings: Record<string, number> = {};
    const requestEntryEndpoint = this.extractEntryEndpointFromUnknown(request);
    const normalizedEntryEndpoint = requestEntryEndpoint || '/v1/chat/completions';
    const requestBlueprint = this.blueprints.request;
    const snapshotRecorder = new PipelineSnapshotRecorder({
      requestId,
      pipelineId: this.pipelineId,
      entryEndpoint: normalizedEntryEndpoint,
      blueprint: requestBlueprint
        ? {
            id: requestBlueprint.id,
            phase: requestBlueprint.phase,
            processMode: requestBlueprint.processMode
          }
        : undefined,
      route: request.route,
      metadata: (request as any)?.metadata as Record<string, unknown> | undefined
    });
    let currentStageLabel = 'initial';

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

      let processedRequest = request as SharedPipelineRequest;
      if (this.passthroughPipeline) {
        processedRequest = this.preparePassthroughRequest(processedRequest, snapshotRecorder);
      }
      this.applyBlueprintMetadata(processedRequest);
      const requestPipelineContext = this.createPipelineContext('request', {
        request: processedRequest,
        requestId,
        entryEndpoint: normalizedEntryEndpoint,
        providerId: request.route?.providerId,
        modelId: request.route?.modelId,
        providerProtocol: this.extractProviderProtocol(processedRequest),
        routeName: (request as any)?.routeName,
        snapshotRecorder
      });
      await this.executePipelineNodes(requestPipelineContext);

      // Stage 4: Provider - Service execution
      currentStageLabel = 'provider.request';
      timings.providerStart = Date.now();
      let providerPayload = requestPipelineContext?.extra?.providerPayload as UnknownObject | undefined;
      if (!providerPayload) {
        providerPayload = await this.processProvider(processedRequest, snapshotRecorder);
      }
      timings.providerEnd = Date.now();
      debugStages.push('provider');

      let responseDto = requestPipelineContext?.response;
      if (!responseDto || !providerPayload) {
        const fallbackArtifacts = await buildProviderResponseArtifacts({
          rawPayload: (providerPayload ?? {}) as UnknownObject,
          request: processedRequest,
          metadata: this.createFallbackProviderMetadata({
            requestId,
            entryEndpoint: normalizedEntryEndpoint,
            providerId: request.route?.providerId,
            modelId: request.route?.modelId,
            processedRequest
          }),
          pipelineId: this.pipelineId,
          providerModuleType: this.config.modules?.provider?.type
        });
        providerPayload = fallbackArtifacts.providerPayload;
        responseDto = fallbackArtifacts.response;
      }

      const responsePipelineContext = this.createPipelineContext('response', {
        requestId,
        entryEndpoint: normalizedEntryEndpoint,
        response: responseDto,
        providerId: request.route?.providerId,
        modelId: request.route?.modelId,
        providerProtocol: this.extractProviderProtocol(processedRequest),
        routeName: (request as any)?.routeName,
        snapshotRecorder
      });
      await this.executePipelineNodes(responsePipelineContext);
      if (responsePipelineContext?.response) {
        responseDto = responsePipelineContext.response;
      }

      const processingTime = Date.now() - startTime;

      // Update metrics
      this.updateMetrics(processingTime, true);

      // Create response
      const stageTimings = this.calculateTimings(timings);
      const response: PipelineResponse = {
        data: responseDto.data,
        metadata: {
          pipelineId: this.pipelineId,
          processingTime,
          stages: debugStages,
          requestId: request.route?.requestId || 'unknown'
        },
        debug: request.debug.enabled ? {
          request: request.data,
          response: responseDto.data,
          transformations: transformationLogs,
          timings: stageTimings
        } : undefined
      };

      snapshotRecorder.record({
        module: 'pipeline',
        stage: 'pipeline.response.final',
        hookStage: 'response_6_snapshot_post',
        direction: 'response',
        payload: response
      });
      await snapshotRecorder.flushSuccess({ response, timings: stageTimings });
      this.debugLogger.logResponse(requestId, 'pipeline-success', { response });
      this._status.state = 'ready';

      return response;

    } catch (error) {
      const processingTime = Date.now() - startTime;
      this.updateMetrics(processingTime, false);
      this.errorCount++;

      try {
        await snapshotRecorder.flushError(currentStageLabel, error);
      } catch { /* ignore snapshot errors */ }
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

  getBlueprint(): PipelineBlueprint | null {
    return this.blueprints.request ?? null;
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
    // Enhancements removed
    this.isEnhanced = false;
  }

  /**
   * Subscribe to debug events
   */
  private subscribeToDebugEvents(): void {
    if (!this.debugEventBus) {return;}

    // Subscribe to pipeline-specific events
    this.debugEventBus.subscribe('pipeline-subscription', (event: unknown) => {
      this.handleDebugEvent(event);
    });
  }

  /**
   * Handle debug events
   */
  private handleDebugEvent(event: unknown): void {
    // Process debug events for real-time monitoring
    const ev = event as Record<string, unknown>;
    if (ev && typeof ev === 'object' && ev['type'] === 'performance') {
      const data = ev['data'] as Record<string, unknown> | undefined;
      const opId = typeof data?.operationId === 'string' ? data.operationId : undefined;
      const pt = typeof data?.processingTime === 'number' ? data.processingTime : undefined;
      if (opId && typeof pt === 'number') {
        this.recordPerformanceMetric(opId, pt);
      }
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
  getPerformanceStats(operationId?: string): unknown {
    if (operationId) {
      const metrics = this.performanceMetrics.get(operationId) || [];
      return this.calculateStats(metrics);
    }

    // Return stats for all operations
    const allStats: Record<string, { count: number; avg: number; min: number; max: number; sum: number }> = {};
    for (const [opId, metrics] of Array.from(this.performanceMetrics.entries())) {
      allStats[opId] = this.calculateStats(metrics);
    }
    return allStats;
  }

  /**
   * Calculate statistics from metrics array
   */
  private calculateStats(metrics: number[]): { count: number; avg: number; min: number; max: number; sum: number } {
    if (metrics.length === 0) {
      return { count: 0, avg: 0, min: 0, max: 0, sum: 0 };
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
  private publishToWebSocket(event: unknown): void {
    // This will be connected to the WebSocket debug server
    try {
      // Event will be published through the debug center to WebSocket
      const edata = (event as Record<string, unknown>)?.['data'] as unknown;
      const dataObj = (edata && typeof edata === 'object') ? (edata as Record<string, unknown>) : { value: edata };
      this.debugCenter.processDebugEvent({
        sessionId: (typeof (event as Record<string, unknown>)?.sessionId === 'string'
          ? (event as Record<string, unknown>)?.sessionId as string
          : 'system'),
        moduleId: this.pipelineId,
        operationId: (typeof (event as Record<string, unknown>)?.operationId === 'string'
          ? (event as Record<string, unknown>)?.operationId as string
          : String((event as Record<string, unknown>)?.type || 'event')),
        timestamp: (event as Record<string, unknown>)?.timestamp as number || Date.now(),
        type: (((event as Record<string, unknown>)?.type as 'start' | 'end' | 'error') || 'debug') as any,
        position: 'middle' as 'start' | 'middle' | 'end',
        data: {
          ...dataObj,
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
  getDebugInfo(): unknown {
    return {
      pipelineId: this.pipelineId,
      enhanced: this.isEnhanced,
      eventBusAvailable: !!this.debugEventBus,
      performanceMetrics: this.getPerformanceStats(),
      status: this.getStatus(),
      moduleCount: Object.values(this.modules).filter(m => m !== null).length,
      uptime: Date.now() - (
        this._status.modules['provider']?.lastActivity ||
        this._status.modules['compatibility']?.lastActivity ||
        Date.now()
      )
    };
  }

  /**
   * Get debug status with enhanced information
   */
  getDebugStatus(): unknown {
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
  private getModuleDebugInfo(): Record<string, unknown> {
    const moduleInfo: Record<string, unknown> = {};

    for (const [moduleName, module] of Object.entries(this.modules)) {
      if (module) {
        moduleInfo[moduleName] = {
          isInitialized: this.isModuleInitialized(module),
          type: module.type,
          hasDebugStatus: typeof (module as any)?.getDebugStatus === 'function',
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
  private isModuleInitialized(module: unknown): boolean {
    const m = module as { isInitialized?: boolean };
    return !!(m && typeof m.isInitialized === 'boolean' ? m.isInitialized : false);
  }

  /**
   * Enhanced error handling with debug context
   */
  private async handleEnhancedError(error: unknown, context: unknown): Promise<void> {
    const baseCtx = (context && typeof context === 'object') ? (context as Record<string, unknown>) : {};
    const errorContext = {
      ...baseCtx,
      pipelineId: this.pipelineId,
      enhanced: this.isEnhanced,
      performanceMetrics: this.getPerformanceStats(),
      moduleStatus: this._status.modules,
      requestId: (baseCtx['requestId'] as string) || 'unknown',
      stage: (baseCtx['stage'] as string) || 'enhanced-error'
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
    await this.errorIntegration.handleModuleError(error, errorContext);
  }

  /**
   * Sanitize request for WebSocket publishing (remove sensitive data)
   */
  private sanitizeRequest(request: PipelineRequest): unknown {
    const sanitized = {
      route: request.route,
      metadata: request.metadata,
      debug: request.debug
    };

    // Copy safe data fields
    const reqo = request as unknown as { data?: unknown };
    const data = reqo.data as Record<string, unknown> | undefined;
    if (data) {
      (sanitized as Record<string, unknown>)['data'] = {
        model: data['model'],
        messages: Array.isArray(data['messages'])
          ? (data['messages'] as Array<Record<string, unknown>>).map((msg) => ({
              role: msg['role'],
              content: typeof msg['content'] === 'string' ? '[CONTENT]' : '[MULTIMODAL_CONTENT]'
            }))
          : undefined,
        max_tokens: data['max_tokens'],
        temperature: data['temperature'],
        stream: data['stream']
      };
    }

    return sanitized;
  }

  private extractEntryEndpointFromUnknown(payload: unknown): string | undefined {
    try {
      if (!payload || typeof payload !== 'object') return undefined;
      const obj = payload as Record<string, unknown>;
      const directMeta = obj.metadata;
      if (directMeta && typeof directMeta === 'object') {
        const entry = (directMeta as Record<string, unknown>).entryEndpoint;
        if (typeof entry === 'string' && entry.trim()) return entry;
        const endpoint = (directMeta as Record<string, unknown>).endpoint;
        if (typeof endpoint === 'string' && endpoint.trim()) return endpoint;
      }
      const data = obj.data;
      if (data && typeof data === 'object') {
        const nestedMeta = (data as Record<string, unknown>).metadata;
        if (nestedMeta && typeof nestedMeta === 'object') {
          const entry = (nestedMeta as Record<string, unknown>).entryEndpoint;
          if (typeof entry === 'string' && entry.trim()) return entry;
          const endpoint = (nestedMeta as Record<string, unknown>).endpoint;
          if (typeof endpoint === 'string' && endpoint.trim()) return endpoint;
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
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
    // Host-provided invoker for llmswitch-core autoloop second round
    (dependencies as any).invokeSecondRound = async (sharedReq: any) => {
      try {
        const resp = await this.processRequest(sharedReq);
        return resp;
      } catch (e) {
        return { data: { error: String((e as any)?.message || e) } } as any;
      }
    };
    const strictEnv = process.env.ROUTECODEX_PIPELINE_STRICT !== '0';
    const skipTransformStages = this.passthroughPipeline;
    const strict = this.passthroughPipeline ? false : strictEnv;

    // Initialize Compatibility module (required)
    if (!skipTransformStages && this.config.modules.compatibility && this.config.modules.compatibility.enabled !== false) {
      this.modules.compatibility = await this.moduleFactory(this.config.modules.compatibility, dependencies) as CompatibilityModule;
      await this.modules.compatibility.initialize();
    }
    if (!skipTransformStages && strict && !this.modules.compatibility) {
      throw new Error(`Pipeline ${this.pipelineId} missing required module: compatibility`);
    }

    // Initialize Provider module (required)
    if (this.config.modules.provider && this.config.modules.provider.enabled !== false) {
      this.modules.provider = await this.moduleFactory(this.config.modules.provider, dependencies) as ProviderModule;
      await this.modules.provider.initialize();
    }
    if (strict && !this.modules.provider) {
      throw new Error(`Pipeline ${this.pipelineId} missing required module: provider`);
    }

    this.updateModuleStatuses();
  }

  /**
   * Process request through Compatibility module
   */
  public async runCompatibilityRequest(
    request: SharedPipelineRequest,
    recorder?: PipelineSnapshotRecorder,
    _options?: Record<string, unknown>
  ): Promise<SharedPipelineRequest> {
    if (!this.modules.compatibility) {
      return request;
    }

    try {
      return await runCompatibilityRequestHelper({
        module: this.modules.compatibility,
        request,
        recorder,
        entryEndpoint: this.extractEntryEndpointFromUnknown(request),
        logger: this.debugLogger,
        pipelineId: this.pipelineId,
        requestId: request.route?.requestId
      });
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
  async processProvider(request: SharedPipelineRequest, recorder?: PipelineSnapshotRecorder): Promise<UnknownObject> {
    if (!this.modules.provider) {
      throw new Error(`Pipeline ${this.pipelineId} provider not initialized`);
    }

    try {
      // Do NOT inject metadata into the provider body.
      // Provider should receive pure Chat JSON (model/messages/tools/...).
      const dataBody: any = request.data as UnknownObject;
      const dataWithMeta = { ...(dataBody || {}) } as UnknownObject;

      // 确保在到达 Provider 前请求始终带有逻辑模型 ID：
      // - 若 Chat 载荷中已存在 model 字段，则保持不变；
      // - 若缺失，则回填为 route.modelId（由虚拟路由/组装器确定的逻辑模型）。
      try {
        const hasModel =
          typeof (dataWithMeta as any).model === 'string' &&
          (dataWithMeta as any).model.trim().length > 0;
        const routeModel = request.route?.modelId;
        if (!hasModel && typeof routeModel === 'string' && routeModel.trim()) {
          (dataWithMeta as any).model = routeModel.trim();
        }
      } catch {
        // best-effort：不影响主流程
      }
      const providerLogRequestId = request.route?.requestId || `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const providerLogPayload = {
        ...dataWithMeta,
        route: { ...(request.route || {}) },
        metadata: { ...(request.metadata || {}) },
        providerId: request.route?.providerId || 'unknown',
        providerType: this.modules.provider?.type || 'unknown',
        pipelineId: this.pipelineId,
        entryEndpoint: this.extractEntryEndpointFromUnknown(request),
        stream: typeof (request.metadata as any)?.stream === 'boolean' ? (request.metadata as any).stream : undefined
      };
      this.debugLogger.logProviderRequest(
        providerLogRequestId,
        'request-start',
        providerLogPayload
      );
      recorder?.record({
        module: 'provider',
        stage: 'pipeline.provider.request.pre',
        hookStage: 'request_6_snapshot_pre',
        direction: 'request',
        payload: dataWithMeta,
        metadata: {
          entryEndpoint: this.extractEntryEndpointFromUnknown(request),
          providerId: request.route?.providerId
        }
      });
      const responsePayload = await this.modules.provider.processIncoming(dataWithMeta);
      this.debugLogger.logProviderRequest(
        providerLogRequestId,
        'request-success',
        providerLogPayload,
        responsePayload
      );
      recorder?.record({
        module: 'provider',
        stage: 'pipeline.provider.response.post',
        hookStage: 'response_6_snapshot_pre',
        direction: 'response',
        payload: responsePayload,
        metadata: {
          entryEndpoint: this.extractEntryEndpointFromUnknown(request),
          providerId: request.route?.providerId
        }
      });
      return responsePayload as UnknownObject;
    } catch (error) {
      // Enrich error with provider context for standard error center handling
      try {
        type ProviderModuleConfig = { type?: string; baseUrl?: string; baseURL?: string; model?: string };
        const provCfg = ((this.config as unknown as { modules?: { provider?: { config?: ProviderModuleConfig } } })
          ?.modules?.provider?.config) ?? {};
        const errRec = error as Record<string, unknown>;
        const details = (errRec['details'] as Record<string, unknown>) || {};
        const enriched = {
          provider: {
            moduleType: this.modules.provider?.type || 'unknown',
            pipelineId: this.pipelineId,
            vendor: provCfg?.type,
            baseUrl: provCfg?.baseUrl || provCfg?.baseURL,
            model: ((request.data as Record<string, unknown>)?.['model'] as string | undefined) || provCfg?.model,
          },
        };
        errRec['details'] = { ...details, ...enriched } as unknown;
      } catch {
        // best-effort enrichment; ignore failures
      }

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
  public async runCompatibilityResponse(
    response: SharedPipelineResponse,
    recorder?: PipelineSnapshotRecorder,
    _options?: Record<string, unknown>
  ): Promise<SharedPipelineResponse> {
    if (!this.modules.compatibility) {
      return response;
    }

    try {
      return await runCompatibilityResponseHelper({
        module: this.modules.compatibility,
        response,
        recorder,
        entryEndpoint: this.extractEntryEndpointFromUnknown(response),
        logger: this.debugLogger,
        pipelineId: this.pipelineId,
        requestId: response.metadata?.requestId
      });
    } catch (error) {
      await this.errorIntegration.handleModuleError(error, {
        stage: 'compatibility-response',
        pipelineId: this.pipelineId,
        requestId: response.metadata?.requestId || 'unknown'
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

  private applyBlueprintMetadata(request: SharedPipelineRequest): void {
    const blueprint = this.blueprints.request;
    if (!blueprint) return;
    if (!request.metadata || typeof request.metadata !== 'object') {
      (request as any).metadata = {};
    }
    const meta = request.metadata as Record<string, unknown>;
    meta.pipelineBlueprint = {
      id: blueprint.id,
      phase: blueprint.phase,
      processMode: blueprint.processMode,
      providerProtocols: [...blueprint.providerProtocols]
    };
    if (blueprint.streaming === 'always') {
      meta.stream = true;
    } else if (blueprint.streaming === 'never') {
      meta.stream = false;
    }
  }

  private createPipelineContext(
    phase: PipelinePhase,
    options: {
      requestId: string;
      entryEndpoint: string;
      request?: SharedPipelineRequest;
      response?: SharedPipelineResponse;
      providerId?: string;
      modelId?: string;
      providerProtocol?: string;
      routeName?: string;
      snapshotRecorder?: PipelineSnapshotRecorder;
    }
  ): PipelineContext | null {
    const blueprint = this.blueprints[phase];
    if (!blueprint || blueprint.phase !== phase) {
      return null;
    }
    const metadata: PipelineMetadata = {
      requestId: options.requestId,
      entryEndpoint: options.entryEndpoint,
      providerProtocol: options.providerProtocol,
      processMode: blueprint.processMode,
      streaming: blueprint.streaming,
      routeName: options.routeName,
      pipelineId: this.pipelineId,
      providerId: options.providerId,
      modelId: options.modelId
    };
    const context = new PipelineContext(blueprint, phase, metadata);
    if (options.request) {
      context.request = options.request;
    }
    if (options.response) {
      context.response = options.response;
    }
    context.extra.pipelineInstance = this;
    if (options.snapshotRecorder) {
      context.extra.snapshotRecorder = options.snapshotRecorder;
    }
    context.errorCallback = this.createNodeErrorCallback(phase);
    context.warningCallback = this.createNodeWarningCallback(phase);
    if (phase === 'request') {
      context.nodes = [
        ...context.nodes,
        {
          id: 'provider-http-node',
          kind: 'provider',
          implementation: 'provider-http'
        }
      ];
    }
    return context;
  }

  private async executePipelineNodes(context: PipelineContext | null): Promise<void> {
    if (!context) return;
    await this.nodeExecutor.execute(context);
    this.applyLlmswitchRuntimeOutputs(context);
  }

  private applyLlmswitchRuntimeOutputs(context: PipelineContext): void {
    const runtimeKey = context.phase === 'response' ? '__llmswitchRuntimeResponse' : '__llmswitchRuntimeRequest';
    const runtime = (context.extra as Record<string, unknown>)[runtimeKey] as Record<string, unknown> | undefined;
    if (!runtime || typeof runtime !== 'object') return;
    const currentData = runtime['currentData'];
    if (!currentData || typeof currentData !== 'object') return;
    if (context.phase === 'request' && !context.extra.providerPayload) {
      context.extra.providerPayload = currentData;
    }
    if (context.phase === 'response' && !context.response) {
      context.response = {
        data: currentData as Record<string, unknown>,
        metadata: {
          pipelineId: context.metadata.pipelineId || this.pipelineId,
          processingTime: 0,
          stages: []
        }
      } as SharedPipelineResponse;
    }
  }

  private createFallbackProviderMetadata(options: {
    requestId: string;
    entryEndpoint: string;
    providerId?: string;
    modelId?: string;
    processedRequest: SharedPipelineRequest;
  }): PipelineMetadata {
    return {
      requestId: options.requestId,
      entryEndpoint: options.entryEndpoint,
      providerProtocol: this.extractProviderProtocol(options.processedRequest),
      processMode: this.blueprints.request?.processMode ?? (this.passthroughPipeline ? 'passthrough' : 'chat'),
      streaming: this.blueprints.request?.streaming ?? 'auto',
      pipelineId: this.pipelineId,
      providerId: options.providerId,
      modelId: options.modelId
    };
  }

  private createNodeErrorCallback(phase: PipelinePhase): PipelineErrorCallback {
    return async (nodeError: PipelineNodeError) => {
      const stageLabel = `${phase}.${nodeError.stage}`;
      const pipelineError: PipelineError = {
        stage: stageLabel,
        code: 'PIPELINE_NODE_ERROR',
        message: nodeError.message,
        details: {
          nodeId: nodeError.nodeId,
          implementation: nodeError.implementation,
          pipelineId: nodeError.pipelineId,
          phase: nodeError.phase,
          metadata: nodeError.metadata,
          cause: nodeError.cause
        },
        timestamp: Date.now()
      };
      await this.errorIntegration.handleModuleError(nodeError, {
        stage: stageLabel,
        pipelineId: this.pipelineId,
        requestId: nodeError.requestId,
        error: pipelineError
      });
      this.debugLogger.logError(pipelineError, {
        requestId: nodeError.requestId,
        stage: stageLabel,
        nodeId: nodeError.nodeId,
        implementation: nodeError.implementation
      });
    };
  }

  private createNodeWarningCallback(phase: PipelinePhase): PipelineWarningCallback {
    return async (warning) => {
      this.debugLogger.logPipeline(this.pipelineId, 'node-warning', {
        phase,
        stage: warning.stage,
        nodeId: warning.nodeId,
        implementation: warning.implementation,
        message: warning.message,
        detail: warning.detail,
        requestId: warning.requestId
      });
    };
  }

  private extractProviderProtocol(request: SharedPipelineRequest): string | undefined {
    try {
      const meta = request.metadata as Record<string, unknown> | undefined;
      if (meta && typeof meta.providerProtocol === 'string') {
        return meta.providerProtocol;
      }
      if (meta && typeof (meta as any).protocol === 'string') {
        return (meta as any).protocol;
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  /**
   * Calculate timing information
   */
  private calculateTimings(timings: Record<string, number>): Record<string, number> {
    const duration = (key: string): number => {
      const start = timings[`${key}.start`];
      const end = timings[`${key}.end`];
      if (typeof start !== 'number' || typeof end !== 'number') return 0;
      return end - start;
    };
    const llmSwitchReq = duration('request.llm-switch-inbound') + duration('request.llm-switch-outbound');
    const compatibilityReq = duration('request.compatibility');
    const providerDuration =
      typeof timings.providerStart === 'number' && typeof timings.providerEnd === 'number'
        ? timings.providerEnd - timings.providerStart
        : 0;
    const compatibilityResp = duration('response.compatibility');
    const llmSwitchResp = duration('response.llm-switch-inbound') + duration('response.llm-switch-outbound');
    const allValues = Object.entries(timings)
      .filter(([key]) => key.endsWith('.start') || key.endsWith('.end') || key === 'providerStart' || key === 'providerEnd')
      .map(([, value]) => value)
      .filter((value): value is number => typeof value === 'number');
    const total =
      allValues.length >= 2 ? Math.max(...allValues) - Math.min(...allValues) : providerDuration;
    return {
      llmSwitch: llmSwitchReq,
      compatibility: compatibilityReq,
      provider: providerDuration,
      compatibilityResponse: compatibilityResp,
      llmSwitchResponse: llmSwitchResp,
      total
    };
  }

  private hasBlueprintNode(phase: PipelinePhase, implementation: string): boolean {
    const blueprint = this.blueprints[phase];
    if (!blueprint) return false;
    return blueprint.nodes.some((node) => node.implementation === implementation);
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
    const eRec = errorObj as unknown as Record<string, unknown>;
    const pipelineError: PipelineError = {
      stage: stages[stages.length - 1] || 'unknown',
      code: (eRec['code'] as string) || 'PROCESSING_ERROR',
      message: errorObj.message,
      details: eRec['details'] as Record<string, unknown> || { stack: errorObj.stack },
      timestamp: Date.now()
    };

    // Defensive coding for undefined route
    const requestId = request.route?.requestId || 'unknown';
    // const route = request.route || { providerId: 'unknown', modelId: 'unknown', requestId, timestamp: Date.now() };

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

  private enrichRequestMetadata(request: SharedPipelineRequest): SharedPipelineRequest {
    try {
      const providerId = request.route?.providerId;
      const providerType =
        typeof this.config.provider?.type === 'string' && this.config.provider.type.trim().length
          ? this.config.provider.type
          : undefined;
      const llmSwitchModule = this.config.modules?.llmSwitch as { config?: Record<string, unknown> } | undefined;
      const providerProtocolRaw =
        llmSwitchModule && llmSwitchModule.config && typeof llmSwitchModule.config === 'object'
          ? (llmSwitchModule.config as Record<string, unknown>).providerProtocol
          : undefined;
      const providerProtocol =
        typeof providerProtocolRaw === 'string' && providerProtocolRaw.trim().length
          ? providerProtocolRaw
          : undefined;

      const mergedMetadata = {
        ...(request.metadata || {}),
        ...(providerId ? { providerId, provider: providerId } : {}),
        ...(providerType ? { providerType } : {}),
        ...(providerProtocol ? { providerProtocol } : {})
      };

      if (mergedMetadata === request.metadata) {
        return request;
      }

      return {
        ...request,
        metadata: mergedMetadata
      };
    } catch {
      return request;
    }
  }

  private preparePassthroughRequest(
    request: SharedPipelineRequest,
    recorder?: PipelineSnapshotRecorder
  ): SharedPipelineRequest {
    const clone = request;
    try {
      const meta =
        clone.metadata && typeof clone.metadata === 'object'
          ? { ...(clone.metadata as Record<string, unknown>) }
          : {};
      (clone as any).metadata = meta;
      meta.passthrough = {
        enabled: true,
        reason: 'llmswitch-disabled',
        pipelineId: this.pipelineId
      };
      recorder?.record({
        module: 'pipeline',
        stage: 'pipeline.passthrough.request',
        hookStage: 'request_6_snapshot_pre',
        direction: 'request',
        payload: clone.data,
        metadata: { entryEndpoint: this.extractEntryEndpointFromUnknown(clone) }
      });
    } catch {
      // best-effort annotations
    }
    return clone;
  }

}
