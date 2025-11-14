/**
 * Base Pipeline Implementation
 *
 * Core pipeline implementation that orchestrates all modules and provides
 * unified request processing with error handling and debugging support.
 */

import type { RCCBaseModule, ErrorHandlingCenter, DebugCenter } from '../types/external-types.js';
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
  // ModuleConfig
} from '../interfaces/pipeline-interfaces.js';
import { PipelineErrorIntegration } from '../utils/error-integration.js';
import { PipelineDebugLogger } from '../utils/debug-logger.js';
import { DebugEventBus } from '../../debugcenter/debug-event-bus-shim.js';
import type { SharedPipelineRequest, SharedPipelineResponse } from '../../../types/shared-dtos.js';
import type { UnknownObject } from '../../../types/common-types.js';

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
    const transformationLogs: unknown[] = [];
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
      let processedRequest = await this.processLLMSwitch(request as SharedPipelineRequest);
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
      const providerPayload = await this.processProvider(processedRequest);
      timings.providerEnd = Date.now();
      debugStages.push('provider');

      // Streaming fast-path: only allow when inbound/outbound are both Responses
      // (i.e., entry endpoint is '/v1/responses'). Otherwise, do not use upstream
      // SSE direct conversion to keep path consistent with Chat finalize.
      try {
        const anyProv: any = providerPayload as any;
        // Derive entryEndpoint before deciding fast-path
        const __processedMeta = (processedRequest && typeof processedRequest === 'object' && (processedRequest as any).metadata)
          ? (processedRequest as any).metadata as Record<string, unknown>
          : {};
        const __originalMeta = ((request as any)?.metadata && typeof (request as any).metadata === 'object')
          ? (request as any).metadata as Record<string, unknown>
          : {};
        const __entryEndpoint = (__processedMeta as any).entryEndpoint
          ?? (__originalMeta as any).entryEndpoint
          ?? (request as any)?.entryEndpoint
          ?? (request as any)?.data?.metadata?.entryEndpoint;

        const allowResponsesFastPath = String(__entryEndpoint || '').toLowerCase() === '/v1/responses';

        if (allowResponsesFastPath && anyProv && typeof anyProv === 'object' && anyProv.__sse_stream) {
          const upstream = anyProv.__sse_stream;
          // Dynamic import to vendor/core
          const importCore = async (sub: string) => {
            const path = await import('path');
            const { fileURLToPath, pathToFileURL } = await import('url');
            try {
              const __filename = fileURLToPath(import.meta.url);
              const __dirname = path.dirname(__filename);
              const vendor = path.resolve(__dirname, '..', '..', '..', '..', 'vendor', 'rcc-llmswitch-core', 'dist');
              const full = path.join(vendor, sub);
              return await import(pathToFileURL(full).href);
            } catch {
              return await import('rcc-llmswitch-core/' + sub);
            }
          };
          const mod = await importCore('v2/conversion/streaming/openai-to-responses-stream.js');
          const fn = (mod && (mod.createResponsesSSEStreamFromOpenAI || mod.default?.createResponsesSSEStreamFromOpenAI)) as any;
          if (typeof fn === 'function') {
            const tools = ((processedRequest as any)?.data as any)?.tools;
            const sse = fn(upstream, { requestId, model: String(((processedRequest as any)?.data as any)?.model || 'unknown'), tools });
            const processingTime = Date.now() - startTime;
            this.updateMetrics(processingTime, true);
            const response: PipelineResponse = {
              data: { __sse_responses: sse },
              metadata: {
                pipelineId: this.pipelineId,
                processingTime,
                stages: debugStages,
                requestId: request.route?.requestId || 'unknown'
              },
              debug: undefined
            } as any;
            this.debugLogger.logResponse(request.route?.requestId || 'unknown', 'pipeline-success-stream', { note: 'core transformed SSE' });
            this._status.state = 'ready';
            return response;
          }
        }
      } catch { /* ignore */ }

      // Wrap provider payload to DTO for response transformation chain
      // Preserve routing metadata (entryEndpoint/protocol) for response phase so llmswitch can route correctly
      const processedMeta = (processedRequest && typeof processedRequest === 'object' && (processedRequest as any).metadata)
        ? (processedRequest as any).metadata as Record<string, unknown>
        : {};
      const originalMeta = ((request as any)?.metadata && typeof (request as any).metadata === 'object')
        ? (request as any).metadata as Record<string, unknown>
        : {};
      const entryEndpoint = (processedMeta as any).entryEndpoint ?? (originalMeta as any).entryEndpoint ?? (request as any)?.entryEndpoint ?? (request as any)?.data?.metadata?.entryEndpoint;
      const endpoint = (processedMeta as any).endpoint ?? (originalMeta as any).endpoint ?? entryEndpoint;
      const protocol = (processedMeta as any).protocol ?? (originalMeta as any).protocol;
      let responseDto: SharedPipelineResponse = {
        data: providerPayload,
        metadata: {
          pipelineId: this.pipelineId,
          processingTime: 0,
          stages: [],
          requestId: request.route?.requestId || 'unknown',
          // 传递入站的 stream 标志，供后续 llmswitch 在响应阶段决定是否产出 __sse_responses
          ...(typeof (processedRequest as any)?.metadata?.stream === 'boolean'
            ? { stream: (processedRequest as any).metadata.stream }
            : (typeof (request as any)?.metadata?.stream === 'boolean' ? { stream: (request as any).metadata.stream } : {})),
          ...(entryEndpoint ? { entryEndpoint } : {}),
          ...(endpoint ? { endpoint } : {}),
          ...(protocol ? { protocol } : {})
        } as any
      };

      // Stage 5: Response transformation chain (reverse order)
      timings.compatibilityResponseStart = Date.now();
      responseDto = await this.processCompatibilityResponse(responseDto);
      timings.compatibilityResponseEnd = Date.now();

      timings.workflowResponseStart = Date.now();
      responseDto = await this.processWorkflowResponse(responseDto);
      timings.workflowResponseEnd = Date.now();

      timings.llmSwitchResponseStart = Date.now();
      responseDto = await this.processLLMSwitchResponse(responseDto);
      timings.llmSwitchResponseEnd = Date.now();

      const processingTime = Date.now() - startTime;

      // Update metrics
      this.updateMetrics(processingTime, true);

      // Create response
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
          timings: this.calculateTimings(timings)
        } : undefined
      };

      this.debugLogger.logResponse(requestId, 'pipeline-success', { response });
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
      uptime: Date.now() - (this._status.modules['llm-switch']?.lastActivity || Date.now())
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
    const strict = process.env.ROUTECODEX_PIPELINE_STRICT !== '0';

    // Initialize LLMSwitch module (required in strict mode)
    if (this.config.modules.llmSwitch && this.config.modules.llmSwitch.enabled !== false) {
      this.modules.llmSwitch = await this.moduleFactory(this.config.modules.llmSwitch, dependencies) as LLMSwitchModule;
      await this.modules.llmSwitch.initialize();
    }
    if (strict && !this.modules.llmSwitch) {
      throw new Error(`Pipeline ${this.pipelineId} missing required module: llmSwitch`);
    }

    // Initialize Workflow module (required in strict mode)
    if (this.config.modules.workflow && this.config.modules.workflow.enabled !== false) {
      this.modules.workflow = await this.moduleFactory(this.config.modules.workflow, dependencies) as WorkflowModule;
      await this.modules.workflow.initialize();
    }
    if (strict && !this.modules.workflow) {
      throw new Error(`Pipeline ${this.pipelineId} missing required module: workflow`);
    }

    // Initialize Compatibility module (required)
    if (this.config.modules.compatibility && this.config.modules.compatibility.enabled !== false) {
      this.modules.compatibility = await this.moduleFactory(this.config.modules.compatibility, dependencies) as CompatibilityModule;
      await this.modules.compatibility.initialize();
    }
    if (strict && !this.modules.compatibility) {
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
   * Process request through LLMSwitch module
   */
  private async processLLMSwitch(request: SharedPipelineRequest): Promise<SharedPipelineRequest> {
    if (!this.modules.llmSwitch) {
      throw new Error(`Pipeline ${this.pipelineId} llmSwitch not initialized`);
    }

    try {
      try {
        console.log('[LLMSWITCH] entryEndpoint:', (request as any)?.metadata?.entryEndpoint);
        const { writePipelineSnapshot } = await import('../utils/pipeline-snapshot-writer.js');
        await writePipelineSnapshot({
          stage: 'pipeline.llmswitch.request.pre',
          requestId: request.route?.requestId || 'unknown',
          pipelineId: this.pipelineId,
          data: request.data,
          entryEndpoint: (request as any)?.metadata?.entryEndpoint as any
        });
      } catch { /* ignore */ }
      const transformed = await this.modules.llmSwitch.processIncoming(request);
      const trObj = transformed as unknown as Record<string, unknown>;
      const isDto = trObj && typeof trObj === 'object'
        && 'data' in trObj
        && 'metadata' in trObj;
      const out: SharedPipelineRequest = isDto
        ? { ...(request as any), ...(transformed as any), route: request.route }
        : { ...request, data: (transformed as unknown as UnknownObject) } as SharedPipelineRequest;
      this.debugLogger.logTransformation(request.route?.requestId || 'unknown', 'llm-switch-request', request.data, (out as any).data);
      try {
        const { writePipelineSnapshot } = await import('../utils/pipeline-snapshot-writer.js');
        await writePipelineSnapshot({
          stage: 'pipeline.llmswitch.request.post',
          requestId: request.route?.requestId || 'unknown',
          pipelineId: this.pipelineId,
          data: (out as any).data,
          entryEndpoint: (request as any)?.metadata?.entryEndpoint as any
        });
      } catch { /* ignore */ }
      return out;
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
  private async processWorkflow(request: SharedPipelineRequest): Promise<SharedPipelineRequest> {
    if (!this.modules.workflow) {
      throw new Error(`Pipeline ${this.pipelineId} workflow not initialized`);
    }

    try {
      try {
        const { writePipelineSnapshot } = await import('../utils/pipeline-snapshot-writer.js');
        await writePipelineSnapshot({ stage: 'pipeline.workflow.request.pre', requestId: request.route?.requestId || 'unknown', pipelineId: this.pipelineId, data: request.data, entryEndpoint: (request as any)?.metadata?.entryEndpoint as any });
      } catch { /* ignore */ }
      const processed = await this.modules.workflow.processIncoming(request);
      const prObj = processed as unknown as Record<string, unknown>;
      const isDto = prObj && typeof prObj === 'object'
        && 'data' in prObj
        && 'metadata' in prObj;
      const out: SharedPipelineRequest = isDto
        ? { ...(request as any), ...(processed as any), route: request.route }
        : { ...request, data: (processed as unknown as UnknownObject) } as SharedPipelineRequest;
      this.debugLogger.logTransformation(request.route?.requestId || 'unknown', 'workflow-request', request.data, (out as any).data);
      try {
        const { writePipelineSnapshot } = await import('../utils/pipeline-snapshot-writer.js');
        await writePipelineSnapshot({ stage: 'pipeline.workflow.request.post', requestId: request.route?.requestId || 'unknown', pipelineId: this.pipelineId, data: (out as any).data, entryEndpoint: (request as any)?.metadata?.entryEndpoint as any });
      } catch { /* ignore */ }
      return out;
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
  private async processCompatibility(request: SharedPipelineRequest): Promise<SharedPipelineRequest> {
    if (!this.modules.compatibility) {
      throw new Error(`Pipeline ${this.pipelineId} compatibility not initialized`);
    }

    try {
      try {
        const { writePipelineSnapshot } = await import('../utils/pipeline-snapshot-writer.js');
        await writePipelineSnapshot({ stage: 'pipeline.compatibility.request.pre', requestId: request.route?.requestId || 'unknown', pipelineId: this.pipelineId, data: request.data, entryEndpoint: (request as any)?.metadata?.entryEndpoint as any });
      } catch { /* ignore */ }
      const transformed = await this.modules.compatibility.processIncoming(request);
      const cObj = transformed as unknown as Record<string, unknown>;
      const isDto = cObj && typeof cObj === 'object'
        && 'data' in cObj
        && 'metadata' in cObj;
      const out: SharedPipelineRequest = isDto
        ? { ...(request as any), ...(transformed as any), route: request.route }
        : { ...request, data: (transformed as unknown as UnknownObject) } as SharedPipelineRequest;
      this.debugLogger.logTransformation(request.route?.requestId || 'unknown', 'compatibility-request', request.data, (out as any).data);
      try {
        const { writePipelineSnapshot } = await import('../utils/pipeline-snapshot-writer.js');
        await writePipelineSnapshot({ stage: 'pipeline.compatibility.request.post', requestId: request.route?.requestId || 'unknown', pipelineId: this.pipelineId, data: (out as any).data, entryEndpoint: (request as any)?.metadata?.entryEndpoint as any });
      } catch { /* ignore */ }
      return out;
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
  private async processProvider(request: SharedPipelineRequest): Promise<UnknownObject> {
    if (!this.modules.provider) {
      throw new Error(`Pipeline ${this.pipelineId} provider not initialized`);
    }

    try {
      // Do NOT inject metadata into the provider body.
      // Provider should receive pure Chat JSON (model/messages/tools/...).
      const dataBody: any = request.data as UnknownObject;
      const dataWithMeta = { ...(dataBody || {}) } as UnknownObject;
      try {
        const { writePipelineSnapshot } = await import('../utils/pipeline-snapshot-writer.js');
        await writePipelineSnapshot({
          stage: 'pipeline.provider.request.pre',
          requestId: request.route?.requestId || 'unknown',
          pipelineId: this.pipelineId,
          data: dataWithMeta,
          entryEndpoint: (request as any)?.metadata?.entryEndpoint as any,
          metadata: (request as any)?.metadata as any
        });
      } catch { /* ignore */ }
      const responsePayload = await this.modules.provider.processIncoming(dataWithMeta);
      this.debugLogger.logProviderRequest(this.pipelineId, 'request-start', request, responsePayload);
      try {
        const { writePipelineSnapshot } = await import('../utils/pipeline-snapshot-writer.js');
        await writePipelineSnapshot({ stage: 'pipeline.provider.response.post', requestId: request.route?.requestId || 'unknown', pipelineId: this.pipelineId, data: responsePayload, entryEndpoint: (request as any)?.metadata?.entryEndpoint as any });
      } catch { /* ignore */ }
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
  private async processCompatibilityResponse(response: SharedPipelineResponse): Promise<SharedPipelineResponse> {
    if (!this.modules.compatibility) {
      return response;
    }

    try {
      try {
        const { writePipelineSnapshot } = await import('../utils/pipeline-snapshot-writer.js');
        await writePipelineSnapshot({ stage: 'pipeline.compatibility.response.pre', requestId: 'unknown', pipelineId: this.pipelineId, data: response, entryEndpoint: undefined });
      } catch { /* ignore */ }
      const transformed = await this.modules.compatibility.processOutgoing(response as unknown as UnknownObject);
      const isDto = transformed && typeof transformed === 'object' && 'data' in (transformed as Record<string, unknown>) && 'metadata' in (transformed as Record<string, unknown>);
      const out: SharedPipelineResponse = isDto
        ? transformed as SharedPipelineResponse
        : { ...response, data: transformed as UnknownObject };
      this.debugLogger.logTransformation('unknown', 'compatibility-response', response, out);
      try {
        const { writePipelineSnapshot } = await import('../utils/pipeline-snapshot-writer.js');
        await writePipelineSnapshot({ stage: 'pipeline.compatibility.response.post', requestId: 'unknown', pipelineId: this.pipelineId, data: out, entryEndpoint: undefined });
      } catch { /* ignore */ }
      return out;
    } catch (error) {
      await this.errorIntegration.handleModuleError(error, {
        stage: 'compatibility-response',
        pipelineId: this.pipelineId,
        requestId: 'unknown'
      });
      throw error;
    }
  }

  /**
   * Process response through Workflow module
   */
  private async processWorkflowResponse(response: SharedPipelineResponse): Promise<SharedPipelineResponse> {
    if (!this.modules.workflow) {
      return response;
    }

    try {
      try {
        const { writePipelineSnapshot } = await import('../utils/pipeline-snapshot-writer.js');
        await writePipelineSnapshot({ stage: 'pipeline.workflow.response.pre', requestId: 'unknown', pipelineId: this.pipelineId, data: response, entryEndpoint: undefined });
      } catch { /* ignore */ }
      const processed = await this.modules.workflow.processOutgoing(response as unknown as UnknownObject);
      const isDto = processed && typeof processed === 'object' && 'data' in (processed as Record<string, unknown>) && 'metadata' in (processed as Record<string, unknown>);
      const out: SharedPipelineResponse = isDto
        ? processed as SharedPipelineResponse
        : { ...response, data: processed as UnknownObject };
      this.debugLogger.logTransformation('unknown', 'workflow-response', response, out);
      try {
        const { writePipelineSnapshot } = await import('../utils/pipeline-snapshot-writer.js');
        await writePipelineSnapshot({ stage: 'pipeline.workflow.response.post', requestId: 'unknown', pipelineId: this.pipelineId, data: out, entryEndpoint: undefined });
      } catch { /* ignore */ }
      return out;
    } catch (error) {
      await this.errorIntegration.handleModuleError(error, {
        stage: 'workflow-response',
        pipelineId: this.pipelineId,
        requestId: 'unknown'
      });
      throw error;
    }
  }

  /**
   * Process response through LLMSwitch module
   */
  private async processLLMSwitchResponse(response: SharedPipelineResponse): Promise<SharedPipelineResponse> {
    if (!this.modules.llmSwitch) {
      return response;
    }

    try {
      try {
        const { writePipelineSnapshot } = await import('../utils/pipeline-snapshot-writer.js');
        await writePipelineSnapshot({ stage: 'pipeline.llmswitch.response.pre', requestId: 'unknown', pipelineId: this.pipelineId, data: response, entryEndpoint: undefined });
      } catch { /* ignore */ }
      const transformed = await this.modules.llmSwitch.processOutgoing(response as unknown as UnknownObject);
      const isDto = transformed && typeof transformed === 'object' && 'data' in (transformed as Record<string, unknown>) && 'metadata' in (transformed as Record<string, unknown>);
      const out: SharedPipelineResponse = isDto
        ? transformed as SharedPipelineResponse
        : { ...response, data: transformed as UnknownObject };
      this.debugLogger.logTransformation('unknown', 'llm-switch-response', response, out);
      try {
        const { writePipelineSnapshot } = await import('../utils/pipeline-snapshot-writer.js');
        await writePipelineSnapshot({ stage: 'pipeline.llmswitch.response.post', requestId: 'unknown', pipelineId: this.pipelineId, data: out, entryEndpoint: undefined });
      } catch { /* ignore */ }
      return out;
    } catch (error) {
      await this.errorIntegration.handleModuleError(error, {
        stage: 'llm-switch-response',
        pipelineId: this.pipelineId,
        requestId: 'unknown'
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
}
