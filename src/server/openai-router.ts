/**
 * OpenAI Router Implementation
 * Implements OpenAI API v1 compatibility endpoints (pipeline-only)
 */

import express, { type Router, type Request, type Response, type NextFunction } from 'express';
import { BaseModule, type ModuleInfo } from 'rcc-basemodule';
import { ErrorHandlingCenter, type ErrorContext } from 'rcc-errorhandling';
import { DebugEventBus } from 'rcc-debugcenter';
import { ModuleConfigReader } from '../utils/module-config-reader.js';
import { RequestHandler } from '../core/request-handler.js';
import { ProviderManager } from '../core/provider-manager.js';

/**
 * Helper function to safely extract error messages from various error object structures
 */
import { getErrorMessage } from '../utils/error-handling-utils.js';
import {
  type RequestContext,
  type ResponseContext,
  type OpenAIChatCompletionRequest,
  type OpenAICompletionRequest,
  type OpenAIModel,
  type OpenAICompletionResponse,
  type StreamResponse,
  type StreamOptions,
  RouteCodexError,
  type ServerConfig,
} from './types.js';
import { ConfigRequestClassifier } from '../modules/virtual-router/classifiers/config-request-classifier.js';

/**
 * OpenAI Router configuration interface
 */
export interface OpenAIRouterConfig {
  enableStreaming?: boolean;
  enableMetrics?: boolean;
  enableValidation?: boolean;
  rateLimitEnabled?: boolean;
  authEnabled?: boolean;
  targetUrl?: string;
  timeout?: number;
  // Feature flag: enable modular pipeline path inside router (optional)
  enablePipeline?: boolean;
  // Pipeline provider configuration
  pipelineProvider?: {
    defaultProvider: string;
    modelMapping: Record<string, string>;
  };
}

/**
 * OpenAI Router class
 */
export class OpenAIRouter extends BaseModule {
  private router: Router;
  private moduleConfigReader: ModuleConfigReader;
  private requestHandler: RequestHandler;
  private providerManager: ProviderManager;
  private errorHandling: ErrorHandlingCenter;
  private debugEventBus: DebugEventBus;
  private config: OpenAIRouterConfig;
  // Removed pass-through provider; pipeline-only routing
  private moduleInfo: ModuleInfo;
  private _isInitialized: boolean = false;
  // Optional pipeline manager hook (attached later by server if needed)
  private pipelineManager: any | null = null;
  // Static route pools and RR index for round-robin scheduling per category
  private routePools: Record<string, string[]> | null = null;
  private rrIndex: Map<string, number> = new Map();
  private classifier: ConfigRequestClassifier | null = null;
  private classifierConfig: any | null = null;

  // Debug enhancement properties
  private isDebugEnhanced = false;
  private routerMetrics: Map<string, any> = new Map();
  private requestHistory: any[] = [];
  private errorHistory: any[] = [];
  private maxHistorySize = 100;

  constructor(
    requestHandler: RequestHandler,
    providerManager: ProviderManager,
    moduleConfigReader: ModuleConfigReader,
    config: OpenAIRouterConfig = {}
  ) {
    const moduleInfo: ModuleInfo = {
      id: 'openai-router',
      name: 'OpenAIRouter',
      version: '0.0.1',
      description: 'OpenAI API v1 compatibility router (pipeline-only)',
      type: 'server',
    };

    super(moduleInfo);

    // Store module info for debug access
    this.moduleInfo = moduleInfo;

    this.requestHandler = requestHandler;
    this.providerManager = providerManager;
    this.moduleConfigReader = moduleConfigReader;
    this.errorHandling = new ErrorHandlingCenter();
    this.debugEventBus = DebugEventBus.getInstance();
    this.router = express.Router();

    // Set default configuration
    this.config = {
      enableStreaming: true,
      enableMetrics: true,
      enableValidation: true,
      rateLimitEnabled: false,
      authEnabled: false,
      timeout: 30000,
      enablePipeline: false,
      ...config,
    };

    // Pass-through provider removed; rely on pipeline path only

    // Initialize debug enhancements
    this.initializeDebugEnhancements();
  }

  /**
   * Initialize debug enhancements
   */
  private initializeDebugEnhancements(): void {
    try {
      this.isDebugEnhanced = true;
      console.log('OpenAI Router debug enhancements initialized');
    } catch (error) {
      console.warn('Failed to initialize OpenAI Router debug enhancements:', error);
      this.isDebugEnhanced = false;
    }
  }

  /**
   * Map unknown errors to OpenAI-style error payload with a sensible status and message.
   * - Prefers upstream provider status and message when available
   * - Falls back to RouteCodexError metadata
   * - Provides consistent type/code based on HTTP status or known error kinds
   */
  private buildErrorPayload(error: unknown, requestId: string): { status: number; body: { error: { message: string; type: string; code: string; param?: string | null; details?: Record<string, unknown> } } } {
    const e: any = error as any;
    // Status precedence: explicit status -> statusCode -> response.status -> RouteCodexError.status -> 500
    const statusFromObj = typeof e?.status === 'number' ? e.status
      : (typeof e?.statusCode === 'number' ? e.statusCode
        : (typeof e?.response?.status === 'number' ? e.response.status : undefined));
    const routeCodexStatus = error instanceof RouteCodexError ? error.status : undefined;
    const status = statusFromObj ?? routeCodexStatus ?? 500;

    // Extract best-effort message from common shapes
    const upstreamMsg = e?.response?.data?.error?.message
      ?? e?.response?.data?.message
      ?? e?.data?.error?.message
      ?? e?.data?.message
      ?? (typeof e?.message === 'string' ? e.message : undefined);
    // Fallback when error is an object without message
    let message = upstreamMsg ? String(upstreamMsg) : (error instanceof Error ? error.message : String(error));
    // Guard against unhelpful stringification of objects
    if (message && /^\[object\s+Object\]$/.test(message)) {
      const serializable = e?.response?.data?.error
        ?? e?.response?.data
        ?? e?.error
        ?? e?.data
        ?? e?.details
        ?? e;
      try {
        message = JSON.stringify(serializable);
      } catch {
        message = 'Unknown error';
      }
    }

    // Derive type/code from RouteCodexError, provider error kind, or HTTP status
    const providerKind = typeof e?.type === 'string' ? e.type : undefined; // e.g., 'network' | 'server' | 'timeout' | 'rate_limit'
    const mapStatusToType = (s: number): string => {
      if (s === 400) {return 'bad_request';}
      if (s === 401) {return 'unauthorized';}
      if (s === 403) {return 'forbidden';}
      if (s === 404) {return 'not_found';}
      if (s === 408) {return 'request_timeout';}
      if (s === 409) {return 'conflict';}
      if (s === 422) {return 'unprocessable_entity';}
      if (s === 429) {return 'rate_limit_exceeded';}
      if (s >= 500) {return 'server_error';}
      return 'internal_error';
    };
    const mapKindToType = (k?: string): string | undefined => {
      if (!k) {return undefined;}
      const m: Record<string, string> = {
        network: 'network_error',
        server: 'server_error',
        timeout: 'request_timeout',
        rate_limit: 'rate_limit_exceeded',
      };
      return m[k] || undefined;
    };
    const rcxCode = error instanceof RouteCodexError ? error.code : undefined;
    const upstreamCode = typeof e?.response?.data?.error?.code === 'string' ? e.response.data.error.code : (typeof e?.code === 'string' ? e.code : undefined);
    const type = rcxCode || mapKindToType(providerKind) || mapStatusToType(status);
    const code = upstreamCode || type;

    // Optionally attach minimal details that help debugging without leaking secrets
    const details: Record<string, unknown> = {};
    if (typeof e?.retryable === 'boolean') {details.retryable = e.retryable;}
    if (typeof statusFromObj === 'number') {details.upstreamStatus = statusFromObj;}
    // Prefer structured provider/upstream details when present
    if (e?.details && typeof e.details === 'object') {
      const d = e.details as any;
      if (d.provider) { details.provider = d.provider; }
      if (d.upstream) { details.upstream = d.upstream; }
    } else if (e?.response?.data) {
      details.upstream = e.response.data;
    }
    details.requestId = requestId;

    return {
      status,
      body: {
        error: {
          message,
          type,
          code,
          param: null,
          details: Object.keys(details).length ? details : undefined,
        },
      },
    };
  }

  /**
   * Record router metric
   */
  private recordRouterMetric(operation: string, data: any): void {
    if (!this.routerMetrics.has(operation)) {
      this.routerMetrics.set(operation, {
        values: [],
        lastUpdated: Date.now(),
      });
    }

    const metric = this.routerMetrics.get(operation)!;
    metric.values.push(data);
    metric.lastUpdated = Date.now();

    // Keep only last 50 measurements
    if (metric.values.length > 50) {
      metric.values.shift();
    }
  }

  /**
   * Add to request history
   */
  private addToRequestHistory(request: any): void {
    this.requestHistory.push(request);

    // Keep only recent history
    if (this.requestHistory.length > this.maxHistorySize) {
      this.requestHistory.shift();
    }
  }

  /**
   * Add to error history
   */
  private addToErrorHistory(error: any): void {
    this.errorHistory.push(error);

    // Keep only recent history
    if (this.errorHistory.length > this.maxHistorySize) {
      this.errorHistory.shift();
    }
  }

  /**
   * Publish debug event
   */
  private publishDebugEvent(type: string, data: any): void {
    if (!this.isDebugEnhanced) {
      return;
    }

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: type,
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          ...data,
          routerId: this.moduleInfo.id,
          source: 'openai-router',
        },
      });
    } catch (error) {
      // Silent fail if debug event bus is not available
    }
  }

  /**
   * Get debug status with enhanced information
   */
  getDebugStatus(): any {
    const baseStatus = {
      routerId: this.moduleInfo.id,
      isInitialized: this._isInitialized,
      type: this.moduleInfo.type,
      isEnhanced: this.isDebugEnhanced,
    };

    if (!this.isDebugEnhanced) {
      return baseStatus;
    }

    return {
      ...baseStatus,
      debugInfo: this.getDebugInfo(),
      routerMetrics: this.getRouterMetrics(),
      requestHistory: [...this.requestHistory.slice(-10)], // Last 10 requests
      errorHistory: [...this.errorHistory.slice(-10)], // Last 10 errors
    };
  }

  /**
   * Get detailed debug information
   */
  private getDebugInfo(): any {
    return {
      routerId: this.moduleInfo.id,
      routerType: this.moduleInfo.type,
      enhanced: this.isDebugEnhanced,
      eventBusAvailable: !!this.debugEventBus,
      requestHistorySize: this.requestHistory.length,
      errorHistorySize: this.errorHistory.length,
      hasPipelineManager: !!this.pipelineManager,
      hasRoutePools: !!this.routePools,
      hasClassifier: !!this.classifier,
    };
  }

  /**
   * Get router metrics
   */
  private getRouterMetrics(): any {
    const metrics: any = {};

    for (const [operation, metric] of this.routerMetrics.entries()) {
      metrics[operation] = {
        count: metric.values.length,
        lastUpdated: metric.lastUpdated,
        recentValues: metric.values.slice(-5), // Last 5 values
      };
    }

    return metrics;
  }

  /**
   * Optionally attach a pipeline manager to enable modular pipeline path
   */
  public attachPipelineManager(pipelineManager: any) {
    this.pipelineManager = pipelineManager;
  }

  /** Attach static route pools (routeName -> [pipelineIds]) */
  public attachRoutePools(routePools: Record<string, string[]>): void {
    this.routePools = routePools;
    this.rrIndex.clear();
  }

  /** Attach classification config (from merged-config) */
  public attachRoutingClassifierConfig(classifierConfig: any): void {
    try {
      if (classifierConfig) {
        this.classifierConfig = classifierConfig;
        this.classifier = new ConfigRequestClassifier(classifierConfig);
      }
    } catch (err) {
      console.warn(
        'Failed to initialize ConfigRequestClassifier:',
        getErrorMessage(err)
      );
      this.classifier = null;
    }
  }

  /**
   * Whether to use pipeline path for this request
   */
  private shouldUsePipeline(): boolean {
    return !!(this.config.enablePipeline && this.pipelineManager);
  }

  /**
   * Get provider ID for pipeline routing
   */
  private getPipelineProviderId(model?: string): string {
    if (this.config.pipelineProvider?.defaultProvider) {
      return this.config.pipelineProvider.defaultProvider;
    }
    // Fallback to lmstudio for backward compatibility
    return 'lmstudio';
  }

  /**
   * Get model ID for pipeline routing
   */
  private getPipelineModelId(model?: string): string {
    if (!model) {
      return 'unknown';
    }

    if (
      this.config.pipelineProvider?.modelMapping &&
      model in this.config.pipelineProvider.modelMapping
    ) {
      return this.config.pipelineProvider.modelMapping[model];
    }

    return model;
  }

  /**
   * Initialize the OpenAI router
   */
  public async initialize(): Promise<void> {
    const startTime = Date.now();
    const initId = `init_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Debug: Record initialization start
    if (this.isDebugEnhanced) {
      this.recordRouterMetric('initialization_start', {
        initId,
        config: this.config,
        targetUrl: this.config.targetUrl,
        timestamp: startTime,
      });
      this.publishDebugEvent('initialization_start', {
        initId,
        config: this.config,
        targetUrl: this.config.targetUrl,
        timestamp: startTime,
      });
    }

    try {
      await this.errorHandling.initialize();
      // No pass-through initialization

      // Setup routes
      this.setupRoutes();

      this._isInitialized = true;

      const totalTime = Date.now() - startTime;

      // Debug: Record initialization completion
      if (this.isDebugEnhanced) {
        this.recordRouterMetric('initialization_complete', {
          initId,
          success: true,
          totalTime,
          hasRoutePools: !!this.routePools,
          hasClassifier: !!this.classifier,
        });
        this.publishDebugEvent('initialization_complete', {
          initId,
          success: true,
          totalTime,
          hasRoutePools: !!this.routePools,
          hasClassifier: !!this.classifier,
        });
      }

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'openai_router_initialized',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          config: this.config,
          targetUrl: this.config.targetUrl,
        },
      });
    } catch (error) {
      const totalTime = Date.now() - startTime;

      // Debug: Record initialization failure
      if (this.isDebugEnhanced) {
        this.recordRouterMetric('initialization_failed', {
          initId,
          error: getErrorMessage(error),
          totalTime,
        });
        this.addToErrorHistory({
          initId,
          error,
          startTime,
          endTime: Date.now(),
          totalTime,
          operation: 'initialize',
        });
        this.publishDebugEvent('initialization_failed', {
          initId,
          error: getErrorMessage(error),
          totalTime,
        });
      }

      await this.handleError(error as Error, 'initialization');
      throw error;
    }
  }

  /**
   * Get the Express router instance
   */
  public getRouter(): Router {
    return this.router;
  }

  /**
   * Setup OpenAI API routes
   */
  private setupRoutes(): void {
    // Chat Completions endpoint
    this.router.post('/chat/completions', this.handleChatCompletions.bind(this));

    // Completions endpoint
    this.router.post('/completions', this.handleCompletions.bind(this));

    // Models endpoint
    this.router.get('/models', this.handleModels.bind(this));

    // Model retrieval endpoint
    this.router.get('/models/:model', this.handleModel.bind(this));

    // Embeddings endpoint
    this.router.post('/embeddings', this.handleEmbeddings.bind(this));

    // Moderations endpoint
    this.router.post('/moderations', this.handleModerations.bind(this));

    // Image generation endpoint
    this.router.post('/images/generations', this.handleImageGenerations.bind(this));

    // Audio transcription endpoint
    this.router.post('/audio/transcriptions', this.handleAudioTranscriptions.bind(this));

    // Audio translation endpoint
    this.router.post('/audio/translations', this.handleAudioTranslations.bind(this));

    // File operations
    this.router.get('/files', this.handleFilesList.bind(this));
    this.router.post('/files', this.handleFileUpload.bind(this));
    this.router.delete('/files/:file_id', this.handleFileDelete.bind(this));
    this.router.get('/files/:file_id', this.handleFileRetrieve.bind(this));
    this.router.get('/files/:file_id/content', this.handleFileContent.bind(this));

    // Fine-tuning operations
    this.router.post('/fine_tuning/jobs', this.handleFineTuningCreate.bind(this));
    this.router.get('/fine_tuning/jobs', this.handleFineTuningList.bind(this));
    this.router.get(
      '/fine_tuning/jobs/:fine_tuning_job_id',
      this.handleFineTuningRetrieve.bind(this)
    );
    this.router.post(
      '/fine_tuning/jobs/:fine_tuning_job_id/cancel',
      this.handleFineTuningCancel.bind(this)
    );
    this.router.get(
      '/fine_tuning/jobs/:fine_tuning_job_id/events',
      this.handleFineTuningEvents.bind(this)
    );

    // Batch operations
    this.router.post('/batches', this.handleBatchCreate.bind(this));
    this.router.get('/batches/:batch_id', this.handleBatchRetrieve.bind(this));
    this.router.get('/batches', this.handleBatchList.bind(this));
    this.router.post('/batches/:batch_id/cancel', this.handleBatchCancel.bind(this));

    // API version info
    this.router.get('/assistants', this.handleAssistants.bind(this));
  }

  /**
   * Handle chat completions
   */
  private async handleChatCompletions(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    let ctxProviderId: string | null = null;
    let ctxModelId: string | null = null;

    // Debug: Record request start
    if (this.isDebugEnhanced) {
      this.recordRouterMetric('chat_completions_start', {
        requestId,
        model: req.body.model,
        messageCount: req.body.messages?.length || 0,
        streaming: req.body.stream || false,
        hasTools: !!req.body.tools,
        timestamp: startTime,
      });
      this.addToRequestHistory({
        requestId,
        endpoint: '/chat/completions',
        method: req.method,
        model: req.body.model,
        messageCount: req.body.messages?.length || 0,
        timestamp: startTime,
      });
      this.publishDebugEvent('chat_completions_start', {
        requestId,
        model: req.body.model,
        messageCount: req.body.messages?.length || 0,
        streaming: req.body.stream || false,
        hasTools: !!req.body.tools,
        timestamp: startTime,
      });
    }

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'chat_completions_request_start',
        timestamp: startTime,
        type: 'start',
        position: 'middle',
        data: {
          requestId,
          model: req.body.model,
          messageCount: req.body.messages?.length || 0,
          streaming: req.body.stream || false,
        },
      });

      // Create request context
      const context: RequestContext = {
        id: requestId,
        timestamp: startTime,
        method: req.method,
        url: req.url,
        headers: this.sanitizeHeaders(req.headers),
        body: req.body,
        userAgent: req.get('user-agent'),
        ip: req.ip,
      };

      // Validate request
      if (this.config.enableValidation) {
        const validation = this.validateChatCompletionRequest(req.body);
        if (!validation.isValid) {
          throw new RouteCodexError(
            `Request validation failed: ${validation.errors.join(', ')}`,
            'validation_error',
            400
          );
        }
      }

      let response;

      // Pipeline path (streaming unified to non-streaming by workflow). Use RR within category.
      if (this.shouldUsePipeline() && this.routePools) {
        const routeName = await this.decideRouteCategoryAsync(req);
        let pipelineId = this.pickPipelineId(routeName);
        // Optional override: x-rc-provider: glm|qwen|iflow|modelscope
        const preferredVendor = (req.headers['x-rc-provider'] as string | undefined)?.toLowerCase()?.trim();
        if (preferredVendor && this.routePools[routeName] && this.routePools[routeName].length) {
          const vendorOf = (pid: string) => {
            const dot = pid.lastIndexOf('.');
            const left = dot > 0 ? pid.slice(0, dot) : pid;
            const und = left.indexOf('_');
            return und > 0 ? left.slice(0, und) : left;
          };
          const override = this.routePools[routeName].find(pid => vendorOf(pid) === preferredVendor);
          if (override) { pipelineId = override; }
        }
        const { providerId, modelId } = this.parsePipelineId(pipelineId);
        ctxProviderId = providerId; ctxModelId = modelId;
        // Optional: allow client Authorization header to override upstream API key per-request
        const authHeader = (req.headers['authorization'] || req.headers['Authorization']) as string | undefined;
        const pipelineRequest = {
          data: {
            ...(req.body || {}),
            ...(authHeader ? { __rcc_overrideApiKey: authHeader } : {}),
          },
          route: {
            providerId,
            modelId,
            requestId,
            timestamp: Date.now(),
          },
          metadata: {
            method: req.method,
            url: req.url,
            headers: this.sanitizeHeaders(req.headers),
          },
          debug: {
            enabled: this.config.enableMetrics ?? true,
            stages: {
              llmSwitch: true,
              workflow: true,
              compatibility: true,
              provider: true,
            },
          },
        };

        const pipelineResponse = await this.pipelineManager.processRequest(pipelineRequest);
        response = pipelineResponse?.data ?? pipelineResponse;

        // If client requests streaming, bridge pipeline stream to OpenAI SSE
        if (req.body.stream) {
          await this.streamFromPipeline(response, requestId, res, req.body.model);
          return; // response already sent via SSE
        }

        // If client requests JSON object format, coerce content to strict JSON
        response = this.ensureJsonContentIfRequested(response, req.body, 'chat');
      } else {
        throw new RouteCodexError(
          'OpenAI pipeline not initialized. Configure providers and pipelines in merged-config.',
          'pipeline_not_ready',
          503
        );
      }

      const duration = Date.now() - startTime;

      // Debug: Record request completion
      if (this.isDebugEnhanced) {
        this.recordRouterMetric('chat_completions_complete', {
          requestId,
          success: true,
          duration,
          status: 200,
          model: req.body.model,
          streaming: req.body.stream || false,
          usedPipeline: this.shouldUsePipeline() && !!this.routePools,
        });
        this.publishDebugEvent('chat_completions_complete', {
          requestId,
          success: true,
          duration,
          status: 200,
          model: req.body.model,
          streaming: req.body.stream || false,
          usedPipeline: this.shouldUsePipeline() && !!this.routePools,
        });
      }

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'chat_completions_request_end',
        timestamp: Date.now(),
        type: 'end',
        position: 'middle',
        data: {
          requestId,
          duration,
          status: 200,
          model: req.body.model,
          streaming: req.body.stream || false,
        },
      });

      // Normalize response for OpenAI compatibility and set standard headers
      const normalized = this.normalizeOpenAIResponse(response, 'chat');
      res.setHeader('x-request-id', requestId);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(200).json(normalized);
    } catch (error) {
      const duration = Date.now() - startTime;
      try {
        const details = (error as any).details || {};
        (error as any).details = {
          ...details,
          provider: {
            ...(details.provider || {}),
            vendor: ctxProviderId || (details.provider?.vendor),
            model: ctxModelId || (details.provider?.model),
          }
        };
      } catch {}

      // Debug: Record request error
      if (this.isDebugEnhanced) {
        this.recordRouterMetric('chat_completions_error', {
          requestId,
          error: getErrorMessage(error),
          duration,
          errorType: error instanceof RouteCodexError ? error.code : 'unknown',
        });
        this.addToErrorHistory({
          requestId,
          error,
          request: req.body,
          startTime,
          endTime: Date.now(),
          duration,
          operation: 'handleChatCompletions',
        });
        this.publishDebugEvent('chat_completions_error', {
          requestId,
          error: getErrorMessage(error),
          duration,
          errorType: error instanceof RouteCodexError ? error.code : 'unknown',
        });
      }

      await this.handleError(error as Error, 'chat_completions_handler');

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'chat_completions_request_error',
        timestamp: Date.now(),
        type: 'error',
        position: 'middle',
        data: {
          requestId,
          duration,
          error: getErrorMessage(error),
        },
      });

      // Send error response with improved mapping
      const mapped = this.buildErrorPayload(error, requestId);
      res.setHeader('x-request-id', requestId);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(mapped.status).json(mapped.body);
    }
  }

  

  /**
   * Handle completions
   */
  private async handleCompletions(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    let ctxProviderId: string | null = null;
    let ctxModelId: string | null = null;

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'completions_request_start',
        timestamp: startTime,
        type: 'start',
        position: 'middle',
        data: {
          requestId,
          model: req.body.model,
          promptLength: Array.isArray(req.body.prompt)
            ? req.body.prompt.length
            : req.body.prompt?.length || 0,
          streaming: req.body.stream || false,
        },
      });

      // Create request context
      const context: RequestContext = {
        id: requestId,
        timestamp: startTime,
        method: req.method,
        url: req.url,
        headers: this.sanitizeHeaders(req.headers),
        body: req.body,
        userAgent: req.get('user-agent'),
        ip: req.ip,
      };

      // Validate request
      if (this.config.enableValidation) {
        const validation = this.validateCompletionRequest(req.body);
        if (!validation.isValid) {
          throw new RouteCodexError(
            `Request validation failed: ${validation.errors.join(', ')}`,
            'validation_error',
            400
          );
        }
      }

      // Pipeline path first (no streaming for legacy completions)
      let response;
      if (this.shouldUsePipeline() && this.routePools) {
        const routeName = await this.decideRouteCategoryAsync(req);
        let pipelineId = this.pickPipelineId(routeName);
        const preferredVendor = (req.headers['x-rc-provider'] as string | undefined)?.toLowerCase()?.trim();
        if (preferredVendor && this.routePools[routeName] && this.routePools[routeName].length) {
          const vendorOf = (pid: string) => {
            const dot = pid.lastIndexOf('.');
            const left = dot > 0 ? pid.slice(0, dot) : pid;
            const und = left.indexOf('_');
            return und > 0 ? left.slice(0, und) : left;
          };
          const override = this.routePools[routeName].find(pid => vendorOf(pid) === preferredVendor);
          if (override) { pipelineId = override; }
        }
        const { providerId, modelId } = this.parsePipelineId(pipelineId);
        ctxProviderId = providerId; ctxModelId = modelId;
        const authHeader2 = (req.headers['authorization'] || req.headers['Authorization']) as string | undefined;
        const pipelineRequest = {
          data: {
            ...(req.body || {}),
            ...(authHeader2 ? { __rcc_overrideApiKey: authHeader2 } : {}),
          },
          route: {
            providerId,
            modelId,
            requestId,
            timestamp: Date.now(),
          },
          metadata: {
            method: req.method,
            url: req.url,
            headers: this.sanitizeHeaders(req.headers),
          },
          debug: {
            enabled: this.config.enableMetrics ?? true,
            stages: {
              llmSwitch: true,
              workflow: true,
              compatibility: true,
              provider: true,
            },
          },
        };
        const pipelineResponse = await this.pipelineManager.processRequest(pipelineRequest);
        response = pipelineResponse?.data ?? pipelineResponse;
        // If client requests JSON object format, coerce content to strict JSON
        response = this.ensureJsonContentIfRequested(response, req.body, 'text');
      } else {
        throw new RouteCodexError(
          'OpenAI pipeline not initialized. Configure providers and pipelines in merged-config.',
          'pipeline_not_ready',
          503
        );
      }

      const duration = Date.now() - startTime;

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'completions_request_end',
        timestamp: Date.now(),
        type: 'end',
        position: 'middle',
        data: {
          requestId,
          duration,
          status: 200,
          model: req.body.model,
        },
      });

      // Normalize response for OpenAI compatibility and set standard headers
      const normalized = this.normalizeOpenAIResponse(response, 'text');
      res.setHeader('x-request-id', requestId);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(200).json(normalized);
    } catch (error) {
      const duration = Date.now() - startTime;
      try {
        const details = (error as any).details || {};
        (error as any).details = {
          ...details,
          provider: {
            ...(details.provider || {}),
            vendor: ctxProviderId || (details.provider?.vendor),
            model: ctxModelId || (details.provider?.model),
          }
        };
      } catch {}
      await this.handleError(error as Error, 'completions_handler');

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'completions_request_error',
        timestamp: Date.now(),
        type: 'error',
        position: 'middle',
        data: {
          requestId,
          duration,
          error: getErrorMessage(error),
        },
      });

      // Send error response
      const mapped = this.buildErrorPayload(error, requestId);
      res.setHeader('x-request-id', requestId);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(mapped.status).json(mapped.body);
    }
  }

  /**
   * Normalize provider response to OpenAI-compatible shape.
   * Adds missing standard fields while preserving existing data.
   */
  private normalizeOpenAIResponse(body: any, kind: 'chat' | 'text'): any {
    try {
      if (!body || typeof body !== 'object') {return body;}

      // Unwrap common wrapper shape { data, status, headers, metadata }
      if (
        (body as any)?.data &&
        typeof (body as any).data === 'object'
      ) {
        const inner = (body as any).data;
        if (
          inner &&
          (Array.isArray(inner.choices) || typeof inner.id === 'string' || inner.usage)
        ) {
          body = inner;
        }
      }

      const clone: any = { ...body };

      // Ensure top-level id
      if (!clone.id) {
        const prefix = kind === 'chat' ? 'chatcmpl' : 'cmpl';
        clone.id = `${prefix}-${Date.now().toString(36)}${Math.random()
          .toString(36)
          .slice(2, 8)}`;
      }

      // Ensure object field
      if (!clone.object) {
        clone.object = kind === 'chat' ? 'chat.completion' : 'text_completion';
      }

      // Ensure created timestamp
      if (!clone.created || typeof clone.created !== 'number') {
        clone.created = Math.floor(Date.now() / 1000);
      }

      // Ensure model field exists if we can infer it from choices
      if (!clone.model && Array.isArray(clone.choices) && clone.choices.length > 0) {
        // Best effort: keep existing model if present in nested metadata (no-op otherwise)
        // Do not fabricate arbitrary model names here
      }

      // Ensure choices is an array
      if (!Array.isArray(clone.choices)) {
        clone.choices = [];
      }

      // Ensure finish_reason and role present on each choice
      clone.choices = clone.choices.map((c: any, idx: number) => {
        const choice = { index: idx, ...(c || {}) } as any;
        if (!('finish_reason' in choice) && (choice.finish_reason === null || choice.finish_reason === undefined)) {
          choice.finish_reason = 'stop';
        }
        if (kind === 'chat' && choice.message && typeof choice.message === 'object') {
          if (!choice.message.role) {
            choice.message.role = 'assistant';
          }
        }
        return choice;
      });

      return clone;
    } catch {
      return body;
    }
  }

  /**
   * Bridge pipeline streaming output to OpenAI-compatible Server-Sent Events (SSE).
   */
  private async streamFromPipeline(response: any, requestId: string, res: Response, model?: string) {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('x-request-id', requestId);

    const makeInitial = () => ({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: model || 'unknown',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: undefined }],
    });

    try {
      // Try to obtain async iterator from response
      let iterator: AsyncIterator<any> | null = null;
      const streamObj = response && (response.data ?? response);
      if (streamObj && typeof streamObj[Symbol.asyncIterator] === 'function') {
        iterator = streamObj[Symbol.asyncIterator]();
      } else if (streamObj && typeof streamObj.iterator === 'function') {
        iterator = (streamObj as any).iterator();
      }

      // Send initial role delta
      res.write(`data: ${JSON.stringify(makeInitial())}\n\n`);

      const normalizeChunk = (obj: any) => {
        try {
          if (!obj || typeof obj !== 'object') {return obj;}
          if (!obj.object) {obj.object = 'chat.completion.chunk';}
          if (Array.isArray(obj.choices)) {
            obj.choices = obj.choices.map((ch: any) => {
              const c = { ...(ch || {}) };
              if (c && typeof c === 'object' && c.delta && typeof c.delta === 'object') {
                const d = { ...c.delta } as any;
                if (d.reasoning_content && !d.content) {
                  d.content = d.reasoning_content;
                }
                if ('reasoning_content' in d) {delete d.reasoning_content;}
                c.delta = d;
              }
              return c;
            });
          }
          return obj;
        } catch { return obj; }
      };

      if (iterator) {
        // Relay chunks as-is; assume they are OpenAI chunk objects or strings
        for await (const chunk of iterator as any) {
          if (chunk === null || chunk === undefined) {continue;}
          if (typeof chunk === 'string') {
            if (chunk.trim() === '[DONE]') {break;}
            // Try to parse JSON string; if fails, wrap into delta
            try {
              const obj = normalizeChunk(JSON.parse(chunk));
              res.write(`data: ${JSON.stringify(obj)}\n\n`);
            } catch {
              const delta = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: model || 'unknown',
                choices: [{ index: 0, delta: { content: String(chunk) }, finish_reason: undefined }],
              };
              res.write(`data: ${JSON.stringify(delta)}\n\n`);
            }
          } else {
            // Object chunk; normalize and send
            const obj = normalizeChunk(chunk);
            res.write(`data: ${JSON.stringify(obj)}\n\n`);
          }
        }
      } else {
        // Fallback: pipeline returned a non-stream payload, emit it as a single streamed chunk
        let payload = streamObj;
        try {
          // Unwrap common shape { data }
          if (payload && typeof payload === 'object' && (payload as any).data) {
            payload = (payload as any).data;
          }
          // Attempt to normalize to OpenAI chat completion
          const normalized = this.normalizeOpenAIResponse(payload, 'chat');
          // Extract content from normalized structure
          let content = '';
          if (normalized && Array.isArray(normalized.choices) && normalized.choices[0]) {
            const c0 = normalized.choices[0] as any;
            content = c0?.message?.content || c0?.text || '';
          } else if (typeof normalized === 'string') {
            content = normalized;
          } else if (payload && typeof payload === 'object') {
            // Last resort: stringify payload
            content = JSON.stringify(payload);
          }
          // Coerce JSON if forced/asked
          const fakeReq = { response_format: (process.env.ROUTECODEX_FORCE_JSON==='1') ? { type: 'json_object' } : undefined } as any;
          const cleaned = this.ensureJsonContentIfRequested(
            { choices: [{ index: 0, message: { role: 'assistant', content } }] },
            fakeReq,
            'chat'
          );
          const outContent = cleaned?.choices?.[0]?.message?.content ?? content;
          const single = normalizeChunk({
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model || 'unknown',
            choices: [{ index: 0, delta: { content: outContent }, finish_reason: undefined }],
          });
          res.write(`data: ${JSON.stringify(single)}\n\n`);
        } catch {
          // If anything goes wrong, at least close the stream properly
        }
      }

      // Final termination chunk
      const done = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model || 'unknown',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      };
      res.write(`data: ${JSON.stringify(done)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      // On error, end stream with a final error message and DONE
      const errorChunk = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model || 'unknown',
        choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
      };
      try { res.write(`data: ${JSON.stringify(errorChunk)}\n\n`); } catch (_e) { void 0; }
      try { res.write('data: [DONE]\n\n'); } catch (_e) { void 0; }
      try { res.end(); } catch (_e) { void 0; }
    }
  }

  /**
   * If response_format.type === 'json_object', try to coerce model output to strict JSON string.
   * This helps clients that parse content as JSON and fail on code fences or extra prose.
   */
  private ensureJsonContentIfRequested(body: any, request: any, kind: 'chat' | 'text') {
    try {
      const expectJson =
        request?.response_format?.type === 'json_object' ||
        process.env.ROUTECODEX_FORCE_JSON === '1';
      if (!expectJson || !body) {return body;}

      const container = (body && typeof body === 'object' && (body as any).data) ? (body as any).data : body;
      if (!container || typeof container !== 'object') {return body;}

      const choices = Array.isArray(container.choices) ? container.choices : [];
      const clean = (s: string): string => {
        if (typeof s !== 'string') {return s as unknown as string;}
        // Prefer fenced JSON block
        const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        const candidate = fence ? fence[1] : s;
        // Try parse as-is
          try {
            const obj = JSON.parse(candidate);
            return JSON.stringify(obj);
          } catch (_e) { void 0; }
        // Try extract first JSON object/array substring
        const matchObj = candidate.match(/\{[\s\S]*\}/);
        if (matchObj) {
          try {
            const obj = JSON.parse(matchObj[0]);
            return JSON.stringify(obj);
          } catch (_e) { void 0; }
        }
        const matchArr = candidate.match(/\[[\s\S]*\]/);
        if (matchArr) {
          try {
            const obj = JSON.parse(matchArr[0]);
            return JSON.stringify(obj);
          } catch (_e) { void 0; }
        }
        // Fallback: strip common wrappers/backticks
        return candidate.replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
      };

      for (let i = 0; i < choices.length; i++) {
        const c = choices[i] || {};
        if (kind === 'chat') {
          if (c.message && typeof c.message === 'object' && typeof c.message.content === 'string') {
            c.message.content = clean(c.message.content);
            if (!c.message.role) {c.message.role = 'assistant';}
            // Remove verbose or non-standard fields that may confuse strict clients
            if ('reasoning_content' in c.message) {
              try { delete (c.message as any).reasoning_content; } catch (_e) { void 0; }
            }
          }
        } else {
          if (typeof c.text === 'string') {
            c.text = clean(c.text);
          }
        }
        choices[i] = c;
      }

      container.choices = choices;
      if ((body as any).data) {
        (body as any).data = container;
      } else {
        body = container;
      }
      return body;
    } catch {
      return body;
    }
  }

  /**
   * Decide route category for a request. For now, default to 'default' if available, else first key.
   * (Hook: can integrate ConfigRequestClassifier here.)
   */
  private decideRouteCategory(req: Request): string {
    if (!this.routePools) {
      return 'default';
    }
    const categories = Object.keys(this.routePools);
    if (categories.includes('default')) {
      return 'default';
    }
    return categories[0] || 'default';
  }

  private async decideRouteCategoryAsync(req: Request): Promise<string> {
    const fallback = () => {
      if (!this.routePools) {
        return 'default';
      }
      const categories = Object.keys(this.routePools);
      if (categories.includes('default')) {
        return 'default';
      }
      return categories[0] || 'default';
    };
    try {
      if (!this.classifier) {
        return fallback();
      }
      const input = {
        request: req.body,
        endpoint: req.url || '/v1/openai/chat/completions',
        protocol: 'openai',
      };
      const res = await this.classifier.classify(input);
      const route = res?.route;
      if (route && this.routePools && this.routePools[route]) {
        return route;
      }
      return fallback();
    } catch {
      return fallback();
    }
  }

  /** Round-robin pick within a category */
  private pickPipelineId(routeName: string): string {
    const pool = (this.routePools && this.routePools[routeName]) || [];
    if (pool.length === 0) {
      throw new Error(`No pipelines available for route ${routeName}`);
    }
    const idx = this.rrIndex.get(routeName) ?? 0;
    const chosen = pool[idx % pool.length];
    this.rrIndex.set(routeName, (idx + 1) % pool.length);
    return chosen;
  }

  /** Parse providerId and modelId from pipelineId '<providerComposite>.<modelId>' */
  private parsePipelineId(pipelineId: string): { providerId: string; modelId: string } {
    const dot = pipelineId.lastIndexOf('.');
    if (dot === -1) {
      return { providerId: pipelineId, modelId: 'unknown' };
    }
    return { providerId: pipelineId.slice(0, dot), modelId: pipelineId.slice(dot + 1) };
  }

  /**
   * Handle models list
   */
  private async handleModels(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'models_request_start',
        timestamp: startTime,
        type: 'start',
        position: 'middle',
        data: {
          requestId,
        },
      });

      // Not implemented without pass-through
      res.status(501).json({
        error: {
          message: 'Models endpoint not implemented. Configure pipeline.',
          type: 'not_implemented',
        },
      });
      const duration = Date.now() - startTime;
    } catch (error) {
      const duration = Date.now() - startTime;
      await this.handleError(error as Error, 'models_handler');

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'models_request_error',
        timestamp: Date.now(),
        type: 'error',
        position: 'middle',
        data: {
          requestId,
          duration,
          error: getErrorMessage(error),
        },
      });

      // Send error response
      const mapped = this.buildErrorPayload(error, requestId);
      res.setHeader('x-request-id', requestId);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(mapped.status).json(mapped.body);
    }
  }

  /**
   * Handle specific model retrieval
   */
  private async handleModel(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const modelId = req.params.model;

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'model_request_start',
        timestamp: startTime,
        type: 'start',
        position: 'middle',
        data: {
          requestId,
          modelId,
        },
      });

      // Not implemented without pass-through
      res.status(501).json({
        error: {
          message: 'Model endpoint not implemented. Configure pipeline.',
          type: 'not_implemented',
        },
      });
      const duration = Date.now() - startTime;
    } catch (error) {
      const duration = Date.now() - startTime;
      await this.handleError(error as Error, 'model_handler');

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'model_request_error',
        timestamp: Date.now(),
        type: 'error',
        position: 'middle',
        data: {
          requestId,
          duration,
          modelId,
          error: getErrorMessage(error),
        },
      });

      const mapped = this.buildErrorPayload(error, requestId);
      res.setHeader('x-request-id', requestId);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(mapped.status).json(mapped.body);
    }
  }

  /**
   * Handle embeddings (pass-through)
   */
  private async handleEmbeddings(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      const context: RequestContext = {
        id: requestId,
        timestamp: startTime,
        method: req.method,
        url: req.url,
        headers: this.sanitizeHeaders(req.headers),
        body: req.body,
        userAgent: req.get('user-agent'),
        ip: req.ip,
      };

      // Not implemented without pass-through
      const duration = Date.now() - startTime;
      res.status(501).json({
        error: {
          message: 'Embeddings not implemented. Configure pipeline.',
          type: 'not_implemented',
        },
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      await this.handleError(error as Error, 'embeddings_handler');

      const status = error instanceof RouteCodexError ? error.status : 500;
      const mapped = this.buildErrorPayload(error, requestId);
      res.setHeader('x-request-id', requestId);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(mapped.status).json(mapped.body);
    }
  }

  /**
   * Handle moderations (pass-through)
   */
  private async handleModerations(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      const context: RequestContext = {
        id: requestId,
        timestamp: startTime,
        method: req.method,
        url: req.url,
        headers: this.sanitizeHeaders(req.headers),
        body: req.body,
        userAgent: req.get('user-agent'),
        ip: req.ip,
      };

      // Not implemented without pass-through
      const duration = Date.now() - startTime;
      res.status(501).json({
        error: {
          message: 'Moderations not implemented. Configure pipeline.',
          type: 'not_implemented',
        },
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      await this.handleError(error as Error, 'moderations_handler');

      const status = error instanceof RouteCodexError ? error.status : 500;
      const mapped = this.buildErrorPayload(error, requestId);
      res.setHeader('x-request-id', requestId);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(mapped.status).json(mapped.body);
    }
  }

  /**
   * Handle image generations (pass-through)
   */
  private async handleImageGenerations(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      const context: RequestContext = {
        id: requestId,
        timestamp: startTime,
        method: req.method,
        url: req.url,
        headers: this.sanitizeHeaders(req.headers),
        body: req.body,
        userAgent: req.get('user-agent'),
        ip: req.ip,
      };

      // Not implemented without pass-through
      const duration = Date.now() - startTime;
      res.status(501).json({
        error: {
          message: 'Image generations not implemented. Configure pipeline.',
          type: 'not_implemented',
        },
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      await this.handleError(error as Error, 'image_generations_handler');

      const status = error instanceof RouteCodexError ? error.status : 500;
      res.status(status).json({
        error: {
          message: getErrorMessage(error),
          type: error instanceof RouteCodexError ? error.code : 'internal_error',
          code: error instanceof RouteCodexError ? error.code : 'internal_error',
        },
      });
    }
  }

  /**
   * Handle audio transcriptions (pass-through)
   */
  private async handleAudioTranscriptions(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      const context: RequestContext = {
        id: requestId,
        timestamp: startTime,
        method: req.method,
        url: req.url,
        headers: this.sanitizeHeaders(req.headers),
        body: req.body,
        userAgent: req.get('user-agent'),
        ip: req.ip,
      };

      // Not implemented without pass-through
      const duration = Date.now() - startTime;
      res.status(501).json({
        error: {
          message: 'Audio transcriptions not implemented. Configure pipeline.',
          type: 'not_implemented',
        },
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      await this.handleError(error as Error, 'audio_transcriptions_handler');

      const status = error instanceof RouteCodexError ? error.status : 500;
      const mapped = this.buildErrorPayload(error, requestId);
      res.setHeader('x-request-id', requestId);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(mapped.status).json(mapped.body);
    }
  }

  /**
   * Handle audio translations (pass-through)
   */
  private async handleAudioTranslations(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      const context: RequestContext = {
        id: requestId,
        timestamp: startTime,
        method: req.method,
        url: req.url,
        headers: this.sanitizeHeaders(req.headers),
        body: req.body,
        userAgent: req.get('user-agent'),
        ip: req.ip,
      };

      // Not implemented without pass-through
      const duration = Date.now() - startTime;
      res.status(501).json({
        error: {
          message: 'Audio translations not implemented. Configure pipeline.',
          type: 'not_implemented',
        },
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      await this.handleError(error as Error, 'audio_translations_handler');

      const status = error instanceof RouteCodexError ? error.status : 500;
      const mapped = this.buildErrorPayload(error, requestId);
      res.setHeader('x-request-id', requestId);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(mapped.status).json(mapped.body);
    }
  }

  // Placeholder handlers for file operations
  private async handleFilesList(req: Request, res: Response): Promise<void> {
    res.status(501).json({
      error: {
        message: 'Files API not implemented in pass-through mode',
        type: 'not_implemented',
      },
    });
  }

  private async handleFileUpload(req: Request, res: Response): Promise<void> {
    res.status(501).json({
      error: {
        message: 'Files API not implemented in pass-through mode',
        type: 'not_implemented',
      },
    });
  }

  private async handleFileDelete(req: Request, res: Response): Promise<void> {
    res.status(501).json({
      error: {
        message: 'Files API not implemented in pass-through mode',
        type: 'not_implemented',
      },
    });
  }

  private async handleFileRetrieve(req: Request, res: Response): Promise<void> {
    res.status(501).json({
      error: {
        message: 'Files API not implemented in pass-through mode',
        type: 'not_implemented',
      },
    });
  }

  private async handleFileContent(req: Request, res: Response): Promise<void> {
    res.status(501).json({
      error: {
        message: 'Files API not implemented in pass-through mode',
        type: 'not_implemented',
      },
    });
  }

  // Placeholder handlers for fine-tuning operations
  private async handleFineTuningCreate(req: Request, res: Response): Promise<void> {
    res.status(501).json({
      error: {
        message: 'Fine-tuning API not implemented in pass-through mode',
        type: 'not_implemented',
      },
    });
  }

  private async handleFineTuningList(req: Request, res: Response): Promise<void> {
    res.status(501).json({
      error: {
        message: 'Fine-tuning API not implemented in pass-through mode',
        type: 'not_implemented',
      },
    });
  }

  private async handleFineTuningRetrieve(req: Request, res: Response): Promise<void> {
    res.status(501).json({
      error: {
        message: 'Fine-tuning API not implemented in pass-through mode',
        type: 'not_implemented',
      },
    });
  }

  private async handleFineTuningCancel(req: Request, res: Response): Promise<void> {
    res.status(501).json({
      error: {
        message: 'Fine-tuning API not implemented in pass-through mode',
        type: 'not_implemented',
      },
    });
  }

  private async handleFineTuningEvents(req: Request, res: Response): Promise<void> {
    res.status(501).json({
      error: {
        message: 'Fine-tuning API not implemented in pass-through mode',
        type: 'not_implemented',
      },
    });
  }

  // Placeholder handlers for batch operations
  private async handleBatchCreate(req: Request, res: Response): Promise<void> {
    res.status(501).json({
      error: {
        message: 'Batch API not implemented in pass-through mode',
        type: 'not_implemented',
      },
    });
  }

  private async handleBatchRetrieve(req: Request, res: Response): Promise<void> {
    res.status(501).json({
      error: {
        message: 'Batch API not implemented in pass-through mode',
        type: 'not_implemented',
      },
    });
  }

  private async handleBatchList(req: Request, res: Response): Promise<void> {
    res.status(501).json({
      error: {
        message: 'Batch API not implemented in pass-through mode',
        type: 'not_implemented',
      },
    });
  }

  private async handleBatchCancel(req: Request, res: Response): Promise<void> {
    res.status(501).json({
      error: {
        message: 'Batch API not implemented in pass-through mode',
        type: 'not_implemented',
      },
    });
  }

  private async handleAssistants(req: Request, res: Response): Promise<void> {
    res.status(501).json({
      error: {
        message: 'Assistants API not implemented in pass-through mode',
        type: 'not_implemented',
      },
    });
  }

  /**
   * Handle streaming chat completion
   */
  private async handleStreamingChatCompletion(
    request: OpenAIChatCompletionRequest,
    context: RequestContext,
    res: Response
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      // Set appropriate headers for streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Transfer-Encoding', 'chunked');

      // Send the initial response
      const initialResponse: StreamResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant' },
            finish_reason: undefined,
          },
        ],
      };

      res.write(`data: ${JSON.stringify(initialResponse)}\n\n`);

      // Simulate streaming response (in real implementation, this would stream from the provider)
      const contentChunks = this.splitIntoChunks(
        'This is a simulated streaming response. In a real implementation, this would stream from the target provider.',
        10
      );

      let chunkIndex = 0;
      const sendChunks = () => {
        if (chunkIndex < contentChunks.length) {
          const chunkResponse: StreamResponse = {
            id: initialResponse.id,
            object: 'chat.completion.chunk',
            created: initialResponse.created,
            model: request.model,
            choices: [
              {
                index: 0,
                delta: { content: contentChunks[chunkIndex] },
                finish_reason: undefined,
              },
            ],
          };

          res.write(`data: ${JSON.stringify(chunkResponse)}\n\n`);
          chunkIndex++;
          setTimeout(sendChunks, 50); // Simulate streaming delay
        } else {
          // Send final message
          const finalResponse: StreamResponse = {
            id: initialResponse.id,
            object: 'chat.completion.chunk',
            created: initialResponse.created,
            model: request.model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: 'stop',
              },
            ],
          };

          res.write(`data: ${JSON.stringify(finalResponse)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();

          // Return the aggregated response
          resolve({
            id: initialResponse.id,
            object: 'chat.completion',
            created: initialResponse.created,
            model: request.model,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: contentChunks.join(''),
                },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
            },
          });
        }
      };

      sendChunks();
    });
  }

  /**
   * Split text into chunks for streaming
   */
  private splitIntoChunks(text: string, chunkSize: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /**
   * Validate chat completion request
   */
  private validateChatCompletionRequest(request: OpenAIChatCompletionRequest): {
    isValid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    // Validate required fields
    if (!request.model || typeof request.model !== 'string') {
      errors.push('Model is required and must be a string');
    }

    if (!request.messages || !Array.isArray(request.messages) || request.messages.length === 0) {
      errors.push('Messages are required and must be a non-empty array');
    }

    // Validate messages
    if (request.messages && Array.isArray(request.messages)) {
      for (let i = 0; i < request.messages.length; i++) {
        const message = request.messages[i];
        if (!message.role || !['system', 'user', 'assistant', 'tool'].includes(message.role)) {
          errors.push(`Message ${i} has invalid role: ${message.role}`);
        }

        if (!message.content || typeof message.content !== 'string') {
          errors.push(`Message ${i} has invalid content: must be a string`);
        }
      }
    }

    // Validate numeric fields
    if (
      request.max_tokens !== undefined &&
      (typeof request.max_tokens !== 'number' || request.max_tokens < 1)
    ) {
      errors.push('max_tokens must be a positive number');
    }

    if (
      request.temperature !== undefined &&
      (typeof request.temperature !== 'number' ||
        request.temperature < 0 ||
        request.temperature > 2)
    ) {
      errors.push('temperature must be a number between 0 and 2');
    }

    if (
      request.top_p !== undefined &&
      (typeof request.top_p !== 'number' || request.top_p < 0 || request.top_p > 1)
    ) {
      errors.push('top_p must be a number between 0 and 1');
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate completion request
   */
  private validateCompletionRequest(request: OpenAICompletionRequest): {
    isValid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    // Validate required fields
    if (!request.model || typeof request.model !== 'string') {
      errors.push('Model is required and must be a string');
    }

    if (!request.prompt || (typeof request.prompt !== 'string' && !Array.isArray(request.prompt))) {
      errors.push('Prompt is required and must be a string or array of strings');
    }

    // Validate numeric fields
    if (
      request.max_tokens !== undefined &&
      (typeof request.max_tokens !== 'number' || request.max_tokens < 1)
    ) {
      errors.push('max_tokens must be a positive number');
    }

    if (
      request.temperature !== undefined &&
      (typeof request.temperature !== 'number' ||
        request.temperature < 0 ||
        request.temperature > 2)
    ) {
      errors.push('temperature must be a number between 0 and 2');
    }

    if (
      request.top_p !== undefined &&
      (typeof request.top_p !== 'number' || request.top_p < 0 || request.top_p > 1)
    ) {
      errors.push('top_p must be a number between 0 and 1');
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Sanitize headers for logging
   */
  private sanitizeHeaders(headers: any): Record<string, string> {
    const sanitized: Record<string, string> = {};
    const sensitiveHeaders = ['authorization', 'api-key', 'x-api-key', 'cookie'];

    for (const [key, value] of Object.entries(headers)) {
      if (sensitiveHeaders.includes(key.toLowerCase())) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = String(value);
      }
    }

    return sanitized;
  }

  /**
   * Handle error with error handling center
   */
  private async handleError(error: Error, context: string): Promise<void> {
    try {
      // Ensure the error has a proper message property
      const errorMessage = error.message || getErrorMessage(error) || 'Unknown error';
      const errorContext: ErrorContext = {
        error: errorMessage,
        source: `openai-router.${context}`,
        severity: 'medium',
        timestamp: Date.now(),
        moduleId: 'openai-router',
        context: {
          stack: error.stack,
          name: error.name || 'UnknownError',
        },
      };

      await this.errorHandling.handleError(errorContext);
    } catch (handlerError) {
      console.error('Failed to handle error:', handlerError);
      console.error('Original error:', error);
    }
  }

  /**
   * Stop the OpenAI router
   */
  public async stop(): Promise<void> {
    try {
      // passThroughProvider was removed - pipeline-only routing
      await this.errorHandling.destroy();
    } catch (error) {
      console.error('Error stopping OpenAI router:', error);
    }
  }
}
