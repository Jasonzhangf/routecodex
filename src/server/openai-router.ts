/**
 * OpenAI Router Implementation
 * Implements OpenAI API v1 compatibility endpoints (pipeline-only)
 */

import express, { type Router, type Request, type Response } from 'express';
import { ErrorHandlingUtils } from '../utils/error-handling-utils.js';
import fs from 'fs/promises';
import { BaseModule, type ModuleInfo } from 'rcc-basemodule';
import { ErrorHandlingCenter } from 'rcc-errorhandling';
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
  type OpenAIChatCompletionRequest,
  type OpenAICompletionRequest,
  type StreamResponse,
  RouteCodexError,
} from './types.js';
import { ConfigRequestClassifier, type ConfigClassifierConfig, type ConfigClassificationInput } from '../modules/virtual-router/classifiers/config-request-classifier.js';

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
  private pipelineManager: Record<string, unknown> | null = null;
  // Static route pools and RR index for round-robin scheduling per category
  private routePools: Record<string, string[]> | null = null;
  private rrIndex: Map<string, number> = new Map();
  private classifier: ConfigRequestClassifier | null = null;
  private classifierConfig: Record<string, unknown> | null = null;

  // Debug enhancement properties
  private isDebugEnhanced = false;
  private routerMetrics: Map<string, { values: unknown[]; lastUpdated: number }> = new Map();
  private requestHistory: unknown[] = [];
  private errorHistory: unknown[] = [];
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
    const e = error as Record<string, unknown>;
    // Status precedence: explicit status -> statusCode -> response.status -> RouteCodexError.status -> 500
    const statusFromObj = typeof e?.status === 'number' ? e.status
      : (typeof e?.statusCode === 'number' ? e.statusCode
        : (e?.response && typeof e.response === 'object' && e.response !== null && 'status' in e.response && typeof (e.response as Record<string, unknown>).status === 'number' ? (e.response as Record<string, unknown>).status : undefined));
    const routeCodexStatus = error instanceof RouteCodexError ? error.status : undefined;
    let status = statusFromObj ?? routeCodexStatus ?? 500;

    // Extract best-effort message from common shapes
    const response = e?.response as any;
    const data = e?.data as any;
    const upstreamMsg = response?.data?.error?.message 
      || response?.data?.message 
      || data?.error?.message 
      || data?.message
      || (typeof e?.message === 'string' ? e.message : undefined);

    // Fallback when error is an object without message
    let message = upstreamMsg ? String(upstreamMsg) : (error instanceof Error ? error.message : String(error));
    // Guard against unhelpful stringification of objects
    if (message && /^\[object\s+Object\]$/.test(message)) {
      const serializable = e?.response && typeof e.response === 'object' && e.response !== null && 'data' in e.response && (e.response as Record<string, unknown>).data && typeof (e.response as Record<string, unknown>).data === 'object' && (e.response as Record<string, unknown>).data !== null ? (e.response as Record<string, unknown>).data
        : e?.error ? e.error
        : e?.data ? e.data
        : e?.details ? e.details
        : e;
      try {
        message = JSON.stringify(serializable);
      } catch {
        message = 'Unknown error';
      }
    }

    // Derive type/code from RouteCodexError, provider error kind, network cause, or HTTP status
    const providerKind = typeof e?.type === 'string' ? e.type : undefined; // e.g., 'network' | 'server' | 'timeout' | 'rate_limit'
    const cause = (e && typeof e === 'object' && e !== null && 'cause' in e) ? (e as any).cause : undefined;
    const causeCode: string | undefined = (cause && typeof cause === 'object' && cause !== null && 'code' in cause && typeof (cause as any).code === 'string') ? (cause as any).code : undefined;
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
    // Adjust status/type for known network cause codes when upstream didn't provide status
    if (!statusFromObj && causeCode) {
      const cc = causeCode.toUpperCase();
      if (cc === 'ETIMEDOUT' || cc === 'UND_ERR_CONNECT_TIMEOUT') {
        status = 504;
      } else if (cc === 'ENOTFOUND' || cc === 'EAI_AGAIN') {
        status = 502;
      } else if (cc === 'ECONNREFUSED' || cc === 'ECONNRESET') {
        status = 502;
      } else if (cc.startsWith('CERT_') || cc.includes('TLS')) {
        status = 502;
      }
    }
    const rcxCode = error instanceof RouteCodexError ? error.code : undefined;
    const upstreamCode = response?.data?.error?.code || (typeof e?.code === 'string' ? e.code : undefined);
    const type = rcxCode || mapKindToType(providerKind) || (causeCode ? 'network_error' : mapStatusToType(status as number));
    const code = (causeCode || upstreamCode || type);

    // Optionally attach minimal details that help debugging without leaking secrets
    const details: Record<string, unknown> = {};
    if (typeof e?.retryable === 'boolean') {details.retryable = e.retryable;}
    if (typeof statusFromObj === 'number') {details.upstreamStatus = statusFromObj;}
    // Prefer structured provider/upstream details when present
    if (e?.details && typeof e.details === 'object' && e.details !== null) {
      const d = e.details as Record<string, unknown>;
      if ('provider' in d) { details.provider = d.provider; }
      if ('upstream' in d) { details.upstream = d.upstream; }
    } else if (e?.response && typeof e.response === 'object' && e.response !== null && 'data' in e.response) {
      details.upstream = (e.response as Record<string, unknown>).data;
    }
    if (causeCode || (cause && typeof cause === 'object' && cause !== null)) {
      details.network = {
        code: causeCode,
        message: cause && typeof cause === 'object' && cause !== null && 'message' in cause ? (cause as Record<string, unknown>).message : undefined,
        errno: cause && typeof cause === 'object' && cause !== null && 'errno' in cause ? (cause as Record<string, unknown>).errno : undefined,
        syscall: cause && typeof cause === 'object' && cause !== null && 'syscall' in cause ? (cause as Record<string, unknown>).syscall : undefined,
        hostname: cause && typeof cause === 'object' && cause !== null && 'hostname' in cause ? (cause as Record<string, unknown>).hostname : undefined,
      };
    }
    details.requestId = requestId;

    // Sandbox/permission denied normalization => 500 + sandbox_denied
    try {
      const det = ErrorHandlingUtils.detectSandboxPermissionError(e);
      if (det.isSandbox) {
        status = 500;
        (details as Record<string, unknown>).category = 'sandbox';
        (details as Record<string, unknown>).retryable = false;
        if (det.reason) { (details as Record<string, unknown>).sandbox = { reason: det.reason }; }
        return {
          status: status as number,
          body: {
            error: {
              message: typeof e?.message === 'string' ? e.message : 'Operation denied by sandbox or permission policy',
              type: 'server_error',
              code: 'sandbox_denied',
              param: null,
              details: details,
            },
          },
        };
      }
    } catch { /* ignore */ }

    return {
      status: status as number,
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
  private recordRouterMetric(operation: string, data: unknown): void {
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
  private addToRequestHistory(request: unknown): void {
    this.requestHistory.push(request);

    // Keep only recent history
    if (this.requestHistory.length > this.maxHistorySize) {
      this.requestHistory.shift();
    }
  }

  /**
   * Add to error history
   */
  private addToErrorHistory(error: unknown): void {
    this.errorHistory.push(error);

    // Keep only recent history
    if (this.errorHistory.length > this.maxHistorySize) {
      this.errorHistory.shift();
    }
  }

  /**
   * Publish debug event
   */
  private publishDebugEvent(type: string, data: Record<string, unknown>): void {
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
  getDebugStatus(): Record<string, unknown> {
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
  private getDebugInfo(): Record<string, unknown> {
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
  private getRouterMetrics(): Record<string, unknown> {
    const metrics: Record<string, unknown> = {};

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
  public attachPipelineManager(pipelineManager: unknown) {
    if (pipelineManager && typeof pipelineManager === 'object' && pipelineManager !== null) {
      this.pipelineManager = pipelineManager as Record<string, unknown>;
    }
  }

  /** Attach static route pools (routeName -> [pipelineIds]) */
  public attachRoutePools(routePools: Record<string, string[]>): void {
    this.routePools = routePools;
    this.rrIndex.clear();
  }

  /** Attach classification config (from merged-config) */
  public attachRoutingClassifierConfig(classifierConfig: unknown): void {
    try {
      if (classifierConfig && typeof classifierConfig === 'object' && classifierConfig !== null) {
        this.classifierConfig = classifierConfig as Record<string, unknown>;
        this.classifier = new ConfigRequestClassifier(classifierConfig as ConfigClassifierConfig);
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
  private getPipelineProviderId(_model?: string): string {
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
    // No request body mutation: honor original message history and content as received
    // Pre-SSE heartbeat stopper (if streaming)
    let stopPreHeartbeat: (() => void) | null = null;

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

      // Optionally record Codex CLI inputs as standard samples (redacted)
      try {
        const ua = (req.get('user-agent') || '').toLowerCase();
        if (ua.includes('codex') || ua.includes('claude')) {
          const dir = `${process.env.HOME || ''}/.routecodex/codex-samples`;
          await fs.mkdir(dir, { recursive: true });
          const sample = {
            requestId,
            endpoint: '/chat/completions',
            timestamp: startTime,
            model: req.body?.model,
            messageCount: Array.isArray(req.body?.messages) ? req.body.messages.length : 0,
            headers: this.sanitizeHeaders(req.headers),
            body: req.body,
          };
          const p = `${dir}/chat-${requestId}.json`;
          await fs.writeFile(p, JSON.stringify(sample, null, 2));
        }
      } catch { /* non-blocking */ }

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

      let response: unknown;
      // Start pre-stream heartbeat immediately for streaming requests (independent of upstream processing)
      if (req.body.stream === true) {
        try {
          stopPreHeartbeat = this.startPreStreamHeartbeat(res, requestId, req.body?.model);
        } catch { /* non-blocking */ }
      }

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
        // Upstream auth override (disabled by default). Enable only if:
        //  - explicit env RCC_ALLOW_UPSTREAM_OVERRIDE=1, or
        //  - client uses dedicated header x-rcc-upstream-authorization / x-rc-upstream-authorization
        const authHeader = (req.headers['authorization'] || req.headers['Authorization']) as string | undefined;
        const upstreamAuthHeader = (req.headers['x-rcc-upstream-authorization'] || req.headers['x-rc-upstream-authorization']) as string | undefined;
        const allowOverride = process.env.RCC_ALLOW_UPSTREAM_OVERRIDE === '1' || !!upstreamAuthHeader;
        const chosenOverride = allowOverride ? (upstreamAuthHeader || authHeader) : undefined;
        // Optional: Replace only system prompt (tools untouched) if selector active
        try {
          const { shouldReplaceSystemPrompt, SystemPromptLoader, replaceSystemInOpenAIMessages } = await import('../utils/system-prompt-loader.js');
          const sel = shouldReplaceSystemPrompt();
          if (sel) {
            const loader = SystemPromptLoader.getInstance();
            const sys = await loader.getPrompt(sel);
            if (sys && req.body && Array.isArray(req.body.messages)) {
              // Guard: do not replace if system content references CLAUDE.md / AGENT(S).md
              const msgs = req.body.messages as any[];
              const idx = msgs.findIndex((m) => m && m.role === 'system' && typeof m.content === 'string');
              const currentSys = idx >= 0 ? String(msgs[idx].content) : '';
              const hasMdMarkers = /\bCLAUDE\.md\b|\bAGENT(?:S)?\.md\b/i.test(currentSys);
              if (!hasMdMarkers) {
                req.body = { ...req.body, messages: replaceSystemInOpenAIMessages(req.body.messages, sys) };
              }
            }
          }
        } catch { /* non-blocking */ }

        const endpointStr = `${(req.baseUrl || '')}${req.url || ''}`;
        const pipelineRequest = {
          data: {
            ...(req.body || {}),
            ...(chosenOverride ? { __rcc_overrideApiKey: chosenOverride } : {}),
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
            targetProtocol: 'openai',
            endpoint: endpointStr,
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

        // Record pipeline input sample for Codex CLI requests
        try {
          const ua = (req.get('user-agent') || '').toLowerCase();
          if (ua.includes('codex') || ua.includes('claude')) {
            const dir = `${process.env.HOME || ''}/.routecodex/codex-samples`;
            await fs.mkdir(dir, { recursive: true });
            const sampleIn = JSON.parse(JSON.stringify(pipelineRequest)) as Record<string, unknown>;
            if (sampleIn?.data && typeof sampleIn.data === 'object' && sampleIn.data !== null && '__rcc_overrideApiKey' in sampleIn.data) {
              (sampleIn.data as Record<string, unknown>).__rcc_overrideApiKey = '[REDACTED]';
            }
            await fs.writeFile(`${dir}/pipeline-in-${requestId}.json`, JSON.stringify(sampleIn, null, 2));
          }
        } catch { /* non-blocking */ }

        const pipelineTimeoutMs = Number(process.env.RCC_PIPELINE_MAX_WAIT_MS || 300000);
        const pipelineResponse = await Promise.race([
          this.pipelineManager && 'processRequest' in this.pipelineManager ? (this.pipelineManager as any).processRequest(pipelineRequest) : Promise.reject(new Error('Pipeline manager not available')),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`Pipeline timeout after ${pipelineTimeoutMs}ms`)), Math.max(1, pipelineTimeoutMs)))
        ]);
        response = pipelineResponse && typeof pipelineResponse === 'object' && pipelineResponse !== null && 'data' in pipelineResponse ? (pipelineResponse as Record<string, unknown>).data : pipelineResponse;

        // Record pipeline output sample for Codex CLI requests
        try {
          const ua = (req.get('user-agent') || '').toLowerCase();
          if (ua.includes('codex') || ua.includes('claude')) {
            const dir = `${process.env.HOME || ''}/.routecodex/codex-samples`;
            await fs.mkdir(dir, { recursive: true });
            const sampleOut = JSON.parse(JSON.stringify(response)) as Record<string, unknown>;
            await fs.writeFile(`${dir}/pipeline-out-${requestId}.json`, JSON.stringify(sampleOut, null, 2));
          }
        } catch { /* non-blocking */ }

        // Ensure early heartbeat is stopped in non-stream path as well
        try {
          if (stopPreHeartbeat) { stopPreHeartbeat(); stopPreHeartbeat = null; }
        } catch { /* ignore */ }

        // Early phase complete inside pipeline branch; final metrics recorded below

        // If client requests streaming, bridge pipeline stream to OpenAI SSE
        if (req.body.stream) {
          // Stop early heartbeat before handing over to real SSE bridge
          try { if (stopPreHeartbeat) { stopPreHeartbeat(); stopPreHeartbeat = null; } } catch { /* ignore */ }
          await this.streamFromPipeline(response, requestId, res, req.body.model);
          return; // response already sent via SSE
        }

        // If client requests JSON object format, coerce content to strict JSON
        response = this.ensureJsonContentIfRequested(response, req.body, 'chat');

        // Tool-call reconstruction is handled in compatibility modules.
        // Router does not mutate content/tool_calls here.
      } else {
        throw new RouteCodexError(
          'OpenAI pipeline not initialized. Configure providers and pipelines in merged-config.',
          'pipeline_not_ready',
          503
        );
      }

      // Ensure early heartbeat is stopped in non-stream path as well
      try { if (stopPreHeartbeat) { stopPreHeartbeat(); stopPreHeartbeat = null; } } catch { /* ignore */ }

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
      // Stop early heartbeat on error if running
      try { if (stopPreHeartbeat) { stopPreHeartbeat(); stopPreHeartbeat = null; } } catch { /* ignore */ }
      const duration = Date.now() - startTime;
      try {
        const errorObj = error as Record<string, unknown>;
        const details = errorObj && typeof errorObj === 'object' && 'details' in errorObj ? errorObj.details : {};
        errorObj.details = {
          ...((details && typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : {}) as Record<string, unknown>),
          provider: {
            ...(details && typeof details === 'object' && details !== null && 'provider' in details && typeof (details as Record<string, unknown>).provider === 'object' && (details as Record<string, unknown>).provider !== null ? (details as Record<string, unknown>).provider as Record<string, unknown> : {}),
            vendor: ctxProviderId || (details && typeof details === 'object' && details !== null && 'provider' in details && typeof (details as Record<string, unknown>).provider === 'object' && (details as Record<string, unknown>).provider !== null && 'vendor' in ((details as Record<string, unknown>).provider as Record<string, unknown>) ? (((details as Record<string, unknown>).provider as Record<string, unknown>).vendor) : undefined),
            model: ctxModelId || (details && typeof details === 'object' && details !== null && 'provider' in details && typeof (details as Record<string, unknown>).provider === 'object' && (details as Record<string, unknown>).provider !== null && 'model' in ((details as Record<string, unknown>).provider as Record<string, unknown>) ? (((details as Record<string, unknown>).provider as Record<string, unknown>).model) : undefined),
          }
        };
      } catch (_e) { void 0; }

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

      // Prefer JSON error if we haven't started SSE yet (even when client requested stream)
      // If SSE headers already sent, end stream gracefully with an error chunk.
      if (res.headersSent) {
        try {
          // Ensure SSE headers if not yet sent
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('x-request-id', requestId);
        try { res.setHeader('x-worker-pid', String(process.pid)); } catch { /* ignore */ }
      }
          const errorObj = error as Record<string, unknown>;
          const cause = errorObj && typeof errorObj === 'object' && errorObj !== null && 'cause' in errorObj ? errorObj.cause : undefined;
          const causeCode: string | undefined = cause && typeof cause === 'object' && cause !== null && 'code' in cause && typeof (cause as Record<string, unknown>).code === 'string' ? (cause as Record<string, unknown>).code as string : (errorObj && typeof errorObj === 'object' && errorObj !== null && 'code' in errorObj && typeof errorObj.code === 'string' ? errorObj.code as string : undefined);
          const msg = getErrorMessage(error);
          const render = causeCode ? `Error [${causeCode}]: ${msg}` : `Error: ${msg}`;
          const errorChunk = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: req.body?.model || 'unknown',
            choices: [{ index: 0, delta: { content: render }, finish_reason: 'stop' }],
          };
          // Persist error snapshot for diagnostics
          try {
            const dir = `${process.env.HOME || ''}/.routecodex/codex-samples`;
            await fs.mkdir(dir, { recursive: true });
            const snap = { requestId, model: req.body?.model, stream: true, error: render, headers: this.sanitizeHeaders(req.headers) };
            await fs.writeFile(`${dir}/error-out-${requestId}.json`, JSON.stringify(snap, null, 2));
          } catch { /* ignore */ }
          try { res.write(`data: ${JSON.stringify(errorChunk)}\n\n`); } catch { /* ignore */ }
          try { res.write('data: [DONE]\n\n'); } catch { /* ignore */ }
          try { res.end(); } catch { /* ignore */ }
          return;
        } catch {
          // fall through to JSON mapping as last resort
        }
      }

      // Send error response with improved mapping (non-stream path)
      const mapped = this.buildErrorPayload(error, requestId);
      // Persist error snapshot for diagnostics
      try {
        const dir = `${process.env.HOME || ''}/.routecodex/codex-samples`;
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(`${dir}/error-out-${requestId}.json`, JSON.stringify({ requestId, mapped, model: req.body?.model, stream: !!req.body?.stream, headers: this.sanitizeHeaders(req.headers) }, null, 2));
      } catch { /* ignore */ }
      if (!res.headersSent) {
        res.setHeader('x-request-id', requestId);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      res.status(mapped.status).json(mapped.body);
    }
  }

  // (Sanitization removed per requirement: do not modify history/messages)

  

  

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
      let response: unknown;
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
        const upstreamAuth2 = (req.headers['x-rcc-upstream-authorization'] || req.headers['x-rc-upstream-authorization']) as string | undefined;
        const allowOverride2 = process.env.RCC_ALLOW_UPSTREAM_OVERRIDE === '1' || !!upstreamAuth2;
        const chosenOverride2 = allowOverride2 ? (upstreamAuth2 || authHeader2) : undefined;
        const endpointStr2 = `${(req.baseUrl || '')}${req.url || ''}`;
        const pipelineRequest = {
          data: {
            ...(req.body || {}),
            ...(chosenOverride2 ? { __rcc_overrideApiKey: chosenOverride2 } : {}),
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
            targetProtocol: 'openai',
            endpoint: endpointStr2,
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
        const pipelineResponse = await (this.pipelineManager && typeof this.pipelineManager === 'object' && this.pipelineManager !== null && 'processRequest' in this.pipelineManager ? ((this.pipelineManager as Record<string, unknown>).processRequest as Function)(pipelineRequest) : Promise.reject(new Error('Pipeline manager not available')));
        response = pipelineResponse && typeof pipelineResponse === 'object' && pipelineResponse !== null && 'data' in pipelineResponse ? (pipelineResponse as Record<string, unknown>).data : pipelineResponse;
        // If client requests JSON object format, coerce content to strict JSON
        response = this.ensureJsonContentIfRequested(response, req.body, 'text');
      } else {
        throw new RouteCodexError(
          'OpenAI pipeline not initialized. Configure providers and pipelines in merged-config.',
          'pipeline_not_ready',
          503
        );
      }

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'openai-router',
        operationId: 'completions_request_end',
        timestamp: Date.now(),
        type: 'end',
        position: 'middle',
        data: {
          requestId,
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
      try {
        const errorObj = error as Record<string, unknown>;
        const details = errorObj && typeof errorObj === 'object' && 'details' in errorObj ? errorObj.details : {};
        errorObj.details = {
          ...((details && typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : {})),
          provider: {
            ...(details && typeof details === 'object' && details !== null && 'provider' in details && typeof (details as Record<string, unknown>).provider === 'object' && (details as Record<string, unknown>).provider !== null ? (details as Record<string, unknown>).provider as Record<string, unknown> : {}),
            vendor: ctxProviderId || (details && typeof details === 'object' && details !== null && 'provider' in details && typeof (details as Record<string, unknown>).provider === 'object' && (details as Record<string, unknown>).provider !== null && 'vendor' in ((details as Record<string, unknown>).provider as Record<string, unknown>) ? (((details as Record<string, unknown>).provider as Record<string, unknown>).vendor) : undefined),
            model: ctxModelId || (details && typeof details === 'object' && details !== null && 'provider' in details && typeof (details as Record<string, unknown>).provider === 'object' && (details as Record<string, unknown>).provider !== null && 'model' in ((details as Record<string, unknown>).provider as Record<string, unknown>) ? (((details as Record<string, unknown>).provider as Record<string, unknown>).model) : undefined),
          }
        };
      } catch (_e) { void 0; }
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
  private normalizeOpenAIResponse(body: unknown, kind: 'chat' | 'text'): Record<string, unknown> | unknown {
    try {
      if (!body || typeof body !== 'object') {return body;}

      // Unwrap common wrapper shape { data, status, headers, metadata }
      if (
        body && typeof body === 'object' && body !== null && 'data' in body &&
        typeof (body as Record<string, unknown>).data === 'object'
      ) {
        const inner = (body as Record<string, unknown>).data;
        if (
          inner &&
          (Array.isArray((inner as Record<string, unknown>).choices) || (typeof (inner as Record<string, unknown>).id === 'string') || (inner as Record<string, unknown>).usage)
        ) {
          body = inner;
        }
      }

      const clone: Record<string, unknown> = { ...(body as Record<string, unknown>) };

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
      clone.choices = (clone.choices as unknown[]).map((c: unknown, idx: number) => {
        const choice: Record<string, unknown> = { index: idx, ...(c && typeof c === 'object' && c !== null ? c as Record<string, unknown> : {}) };
        if (!('finish_reason' in choice) && (choice.finish_reason === null || choice.finish_reason === undefined)) {
          choice.finish_reason = 'stop';
        }
        if (kind === 'chat' && choice.message && typeof choice.message === 'object' && choice.message !== null) {
          const message = choice.message as Record<string, unknown>;
          if (!message.role) {
            message.role = 'assistant';
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
   * Bridge pipeline streaming output to protocol-specific Server-Sent Events (SSE).
   */
  private async streamFromPipeline(
    response: unknown,
    requestId: string,
    res: Response,
    model?: string,
    protocol: 'openai' | 'anthropic' = 'openai'
  ) {
    if (protocol === 'anthropic') {
      return this.streamAnthropicFromPipeline(response, requestId, res, model);
    }
    return this.streamOpenAIFromPipeline(response, requestId, res, model);
  }

  /**
   * Bridge pipeline streaming output to OpenAI-compatible Server-Sent Events (SSE).
   */
  private async streamOpenAIFromPipeline(response: unknown, requestId: string, res: Response, model?: string) {
    // Set SSE headers (guard if already sent by pre-heartbeat)
    if (!res.headersSent) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('x-request-id', requestId);
        try { res.setHeader('x-worker-pid', String(process.pid)); } catch { /* ignore */ }
      }

    const HEARTBEAT_INTERVAL_MS = Number(process.env.RCC_SSE_HEARTBEAT_MS ?? 15000);
    const HEARTBEAT_STATUS_TEXT = process.env.RCC_SSE_HEARTBEAT_STATUS_TEXT ?? 'Waiting for upstream response';
    const EMIT_STATUS = process.env.RCC_SSE_HEARTBEAT_STATUS !== '0';
    // Mode: 'chunk' (default) emits OpenAI-compatible ChatCompletionChunk; 'comment' emits SSE comment lines only
    const HEARTBEAT_MODE = (process.env.RCC_SSE_HEARTBEAT_MODE || 'chunk').toLowerCase();
    // Whether to place heartbeat message into reasoning_content (never content) when using 'chunk' mode
    // Default OFF to keep chunks strictly OpenAI-compatible
    const HEARTBEAT_USE_REASONING = process.env.RCC_SSE_HEARTBEAT_USE_REASONING === '1';
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let streamEnded = false;
    let heartbeatCounter = 0;
    const heartbeatStartedAt = Date.now();
    const heartbeatBaselineText = HEARTBEAT_STATUS_TEXT && HEARTBEAT_STATUS_TEXT.trim().length
      ? HEARTBEAT_STATUS_TEXT.trim()
      : 'Waiting for upstream response';

    const sendHeartbeat = () => {
      if (streamEnded) { return; }
      try {
        heartbeatCounter += 1;
        if (HEARTBEAT_MODE === 'comment') {
          // SSE comment – semantically neutral, most OpenAI-compatible clients ignore comments
          res.write(`: ping ${heartbeatCounter} pid=${process.pid} req=${requestId}\n\n`);
          try {
            this.publishDebugEvent('sse_heartbeat_emit', {
              mode: 'comment',
              sequence: heartbeatCounter,
              requestId,
            });
          } catch (_e) { void 0; }
        } else {
          const delta: Record<string, unknown> = {};
          if (EMIT_STATUS && HEARTBEAT_USE_REASONING) {
            const elapsedMs = Date.now() - heartbeatStartedAt;
            const elapsedSeconds = Math.max(1, Math.floor(elapsedMs / 1000));
            const statusText = `${heartbeatBaselineText} (≈${elapsedSeconds}s)`;
            delta.reasoning_content = [{
              type: 'text',
              text: statusText,
              metadata: {
                rccHeartbeat: true,
                sequence: heartbeatCounter,
                workerPid: process.pid,
              },
            }];
          }
          const heartbeatChunk = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model || 'unknown',
            choices: [{ index: 0, delta, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(heartbeatChunk)}\n\n`);
          try {
            this.publishDebugEvent('sse_heartbeat_emit', {
              mode: 'chunk',
              sequence: heartbeatCounter,
              requestId,
              hasReasoning: Boolean(delta && delta.reasoning_content),
            });
          } catch (_e) { void 0; }
        }
      } catch (_e) { /* ignore */ void 0; }
    };

    const startHeartbeat = () => {
      if (HEARTBEAT_INTERVAL_MS <= 0) { return; }
      if (heartbeatTimer) { clearInterval(heartbeatTimer); }
      sendHeartbeat();
      heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    };

    const stopHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const makeInitial = () => ({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: model || 'unknown',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: undefined }],
    });

    try {
      // Try to obtain async iterator from response
      let iterator: AsyncIterator<unknown> | null = null;
      const streamObj = response && ((response as any).data ?? response);
      if (streamObj && typeof streamObj === 'object' && streamObj !== null && typeof (streamObj as any)[Symbol.asyncIterator] === 'function') {
        iterator = (streamObj as any)[Symbol.asyncIterator] || (streamObj as any).iterator;
      } else if (streamObj && typeof streamObj === 'object' && streamObj !== null && typeof (streamObj as any).iterator === 'function') {
        iterator = null; // Simplified
      }

      // Send initial role delta
      res.write(`data: ${JSON.stringify(makeInitial())}\n\n`);
      startHeartbeat();

      const normalizeChunk = (obj: unknown) => {
        try {
          if (!obj || typeof obj !== 'object') {return obj;}
          const objRec = obj as Record<string, unknown>;
          if (!objRec.object) {objRec.object = 'chat.completion.chunk';}
        if (Array.isArray(objRec.choices)) {
          objRec.choices = (objRec.choices as unknown[]).map((ch: unknown) => {
            const c = { ...(ch || {}) } as Record<string, unknown>;
            if (c && typeof c === 'object' && c.delta && typeof c.delta === 'object') {
              const d = { ...((c as Record<string, unknown>).delta as Record<string, unknown>) } as Record<string, unknown>;
              if (d.reasoning_content) {
                const entries = Array.isArray(d.reasoning_content)
                  ? d.reasoning_content
                  : [d.reasoning_content];
                const heartbeatEntries = entries.filter((entry) => {
                  if (!entry || typeof entry !== 'object') { return false; }
                  const meta = entry.metadata || entry.__metadata;
                  return Boolean(meta && meta.rccHeartbeat);
                });
                const visibleEntries = entries.filter((entry) => !heartbeatEntries.includes(entry));
                if (!d.content && visibleEntries.length) {
                  d.content = visibleEntries
                    .map((entry) => (entry && typeof (entry as Record<string, unknown>).text === 'string') ? (entry as Record<string, unknown>).text : '')
                    .join('');
                }
                if (!visibleEntries.length && (d.content === undefined || d.content === null || d.content === '')) {
                  delete d.content;
                }
                if (heartbeatEntries.length && !visibleEntries.length) {
                  d.reasoning_content = heartbeatEntries;
                } else if (!heartbeatEntries.length) {
                  delete d.reasoning_content;
                } else {
                  d.reasoning_content = heartbeatEntries;
                }
              }
              if (typeof d.content === 'string') {
                // Strip <think> private markers from streamed content
                d.content = d.content.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '').replace(/<\/?think\b[^>]*>/gi, '');
              }
              c.delta = d;
            }
            return c;
          });
        }
          return obj;
        } catch { return obj; }
      };

      let emittedToolCalls = false;
      if (iterator) {
        // Relay chunks as-is; assume they are OpenAI chunk objects or strings
        for await (const chunk of (iterator as any)) {
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
          if (payload && typeof payload === 'object' && payload !== null && (payload as Record<string, unknown>).data) {
            payload = (payload as Record<string, unknown>).data;
          }
          // Attempt to normalize to OpenAI chat completion
          const normalized = this.normalizeOpenAIResponse(payload, 'chat');
          // Extract content from normalized structure
          let content = '';
          let toolCalls: unknown[] | null = null;
          let legacyFn: Record<string, unknown> | null = null;
          if (normalized && typeof normalized === 'object' && normalized !== null && Array.isArray((normalized as Record<string, unknown>).choices)) {
            const choicesArray = (normalized as Record<string, unknown>).choices as unknown[];
            if (choicesArray && choicesArray[0] && typeof choicesArray[0] === 'object') {
              const c0 = choicesArray[0] as Record<string, unknown>;
              const msg = (typeof c0.message === 'object' && c0.message !== null) ? (c0.message as Record<string, unknown>) : undefined;
              const maybeContent = typeof msg?.content === 'string' ? (msg!.content as string) : '';
              if (maybeContent && !content) {content = maybeContent;}
              const tc = (msg && Array.isArray((msg as any).tool_calls)) ? ((msg as any).tool_calls as unknown[]) : null;
              if (tc && tc.length) { toolCalls = tc; }
              // Detect legacy single function_call
              const fc = (msg && (msg as any).function_call) ? ((msg as any).function_call as Record<string, unknown>) : null;
              if (!tc && fc) { legacyFn = fc; }
            }
          } else if (typeof normalized === 'string') {
            content = normalized;
          } else if (payload && typeof payload === 'object') {
            // Last resort: stringify payload
            content = JSON.stringify(payload);
          }
          // Coerce JSON if forced/asked
          const fakeReq = { response_format: (process.env.ROUTECODEX_FORCE_JSON==='1') ? { type: 'json_object' } : undefined };
          // const cleaned = this.ensureJsonContentIfRequested(
          //   { choices: [{ index: 0, message: { role: 'assistant', content } }] },
          //   fakeReq,
          //   'chat'
          // );
          const outContent = content; // Simplified for type safety
          const delta: Record<string, unknown> = { };
          const hasTool = Array.isArray(toolCalls) && toolCalls.length > 0;
          if (!hasTool && outContent && String(outContent).length > 0) {
            delta.content = outContent;
          }
          if (hasTool || legacyFn) {
            // Emit tool_calls in a single delta chunk for compatibility (OpenAI spec expects stringified JSON arguments)
            const list = Array.isArray(toolCalls) ? toolCalls : [];
            // If only legacy function_call present, convert to single tool_call
            if ((!list || list.length === 0) && legacyFn) {
              const name = typeof legacyFn.name === 'string' ? (legacyFn.name as string) : 'tool';
              let argsStr = '';
              const rawArgs = (legacyFn as any).arguments;
              if (typeof rawArgs === 'string') { argsStr = rawArgs; }
              else if (rawArgs !== undefined) { try { argsStr = JSON.stringify(rawArgs); } catch { argsStr = String(rawArgs); } }
              toolCalls = [{ id: `call_${Date.now()}_${Math.random().toString(36).slice(2,6)}`, type: 'function', function: { name, arguments: argsStr } }];
            }
            delta.tool_calls = list.map((tc) => {
              const obj = (tc as Record<string, unknown>) || {};
              const fn = (obj.function as Record<string, unknown> | undefined) || {} as Record<string, unknown>;
              const name = typeof fn.name === 'string' ? (fn.name as string) : 'tool';
              let argsStr = '';
              if (typeof fn.arguments === 'string') {
                argsStr = fn.arguments as string;
              } else if (fn.arguments !== undefined) {
                try { argsStr = JSON.stringify(fn.arguments); } catch { argsStr = String(fn.arguments); }
              }
              return {
                id: (obj.id as string) || `call_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
                type: 'function',
                function: { name, arguments: argsStr },
              };
            });
            emittedToolCalls = true;
          }
          const single = normalizeChunk({
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model || 'unknown',
            choices: [{ index: 0, delta, finish_reason: undefined }],
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
        choices: [{ index: 0, delta: {}, finish_reason: emittedToolCalls ? 'tool_calls' : 'stop' }],
      };
      stopHeartbeat();
      res.write(`data: ${JSON.stringify(done)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      streamEnded = true;
    } catch (err) {
      // On error, end stream with a final error message and DONE
      const errorChunk = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model || 'unknown',
        choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
      };
      stopHeartbeat();
      try { res.write(`data: ${JSON.stringify(errorChunk)}\n\n`); } catch (_e) { void 0; }
      try { res.write('data: [DONE]\n\n'); } catch (_e) { void 0; }
      try { res.end(); } catch (_e) { void 0; }
      streamEnded = true;
    }
  }

  /**
   * Bridge pipeline streaming output to Anthropic-compatible SSE sequence with heartbeats.
   */
  private async streamAnthropicFromPipeline(response: unknown, requestId: string, res: Response, model?: string) {
    type AnthropicMessage = {
      id: string;
      type: string;
      role: string;
      content: Array<Record<string, unknown>>;
      model: string;
      stop_reason: string | null;
      stop_sequence?: string | null;
      usage?: Record<string, unknown> | null;
      [key: string]: unknown;
    };
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('x-request-id', requestId);
      try { res.setHeader('x-worker-pid', String(process.pid)); } catch { /* ignore */ }
    }

    const HEARTBEAT_INTERVAL_MS = Number(process.env.RCC_SSE_HEARTBEAT_MS ?? 15000);
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let streamEnded = false;
    let heartbeatCounter = 0;

    const writeEvent = (eventType: string, payload: Record<string, unknown>) => {
      try {
        const data = `data: ${JSON.stringify(payload)}\n\n`;
        if (eventType) {
          res.write(`event: ${eventType}\n${data}`);
        } else {
          res.write(data);
        }
      } catch (_err) {
        /* ignore */
      }
    };

    const sendPing = () => {
      if (streamEnded) { return; }
      heartbeatCounter += 1;
      writeEvent('ping', { type: 'ping', sequence: heartbeatCounter, timestamp: new Date().toISOString() });
    };

    const startHeartbeat = () => {
      if (HEARTBEAT_INTERVAL_MS <= 0) { return; }
      if (heartbeatTimer) { clearInterval(heartbeatTimer); }
      sendPing();
      heartbeatTimer = setInterval(sendPing, HEARTBEAT_INTERVAL_MS);
    };

    const stopHeartbeat = () => {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); }
      heartbeatTimer = null;
    };

    const coerceAnthropicMessage = (payload: unknown): AnthropicMessage => {
      if (!payload || typeof payload !== 'object') {
        return {
          id: `msg_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: String(payload ?? '') }],
          model: model || 'unknown',
          stop_reason: 'end_turn',
          usage: null,
        };
      }
      const message = payload as Record<string, unknown>;
      const ensured = { ...message } as Record<string, unknown>;
      ensured.id = typeof ensured.id === 'string' && ensured.id.length ? ensured.id : `msg_${Date.now()}`;
      ensured.type = typeof ensured.type === 'string' ? ensured.type : 'message';
      ensured.role = typeof ensured.role === 'string' ? ensured.role : 'assistant';
      ensured.model = typeof ensured.model === 'string' ? ensured.model : (model || 'unknown');
      if (!Array.isArray(ensured.content)) {
        const text = typeof ensured.content === 'string' ? ensured.content : '';
        ensured.content = [{ type: 'text', text }];
      }
      if (!('stop_reason' in ensured)) {
        ensured.stop_reason = 'end_turn';
      }
      if (!('usage' in ensured)) {
        ensured.usage = null;
      }
      return ensured as AnthropicMessage;
    };

    try {
      let iterator: AsyncIterableIterator<unknown> | null = null;
      const streamObj = response && ((response as any).data ?? response);
      if (streamObj && typeof streamObj === 'object' && streamObj !== null && typeof (streamObj as any)[Symbol.asyncIterator] === 'function') {
        iterator = (streamObj as any)[Symbol.asyncIterator]();
      }

      // If we have a streaming iterator: convert incrementally using transformer
      if (iterator) {
        const { AnthropicSSETransformer } = await import('./anthropic-sse-transformer.js');
        const transformer = new AnthropicSSETransformer();
        const capture: Array<{ event: string; data: Record<string, unknown> }> = [];
        const doCapture = process.env.RCC_SSE_CAPTURE === '1';
        const cap = (ev: string, payload: Record<string, unknown>) => {
          if (doCapture) capture.push({ event: ev, data: payload });
          writeEvent(ev, payload);
        };

        startHeartbeat();
        for await (const rawChunk of iterator) {
          const evs = transformer.processOpenAIChunk(rawChunk);
          for (const e of evs) cap(e.event, e.data);
        }
        const tail = transformer.finalize();
        for (const e of tail) cap(e.event, e.data);
        stopHeartbeat();
        streamEnded = true;
        try { res.write('data: [DONE]\n\n'); } catch { /* ignore */ }
        try { res.end(); } catch { /* ignore */ }
        if (doCapture) {
          try {
            const baseDir = `${process.env.HOME || ''}/.routecodex/codex-samples/anth-replay`;
            await fs.mkdir(baseDir, { recursive: true });
            await fs.writeFile(`${baseDir}/sse-events-${requestId}.log`, capture.map(e => `${e.event}: ${JSON.stringify(e.data)}`).join('\n'));
          } catch { /* ignore */ }
        }
        return;
      }

      // Non-stream: convert to Anthropic message via llmswitch, then simulate SSE incrementally
      try {
        const { PipelineDebugLogger } = await import('../modules/pipeline/utils/debug-logger.js');
        const { AnthropicOpenAIConverter } = await import('../modules/pipeline/modules/llmswitch/llmswitch-anthropic-openai.js');
        const logger = new (PipelineDebugLogger as any)({} as any, { enableConsoleLogging: false, enableDebugCenter: false });
        const deps = { errorHandlingCenter: {} as any, debugCenter: {} as any, logger } as any;
        const conv = new (AnthropicOpenAIConverter as any)({ type: 'llmswitch-anthropic-openai', config: {} }, deps);
        if (typeof conv.initialize === 'function') { await conv.initialize(); }
        const converted = await conv.transformResponse(streamObj);
        const msg: any = converted && typeof converted === 'object' && 'data' in converted ? (converted as any).data : converted;

        const { AnthropicSSESimulator } = await import('./anthropic-sse-simulator.js');
        const simulator = new AnthropicSSESimulator();
        const events = simulator.buildEvents(msg);

        const capture: Array<{ event: string; data: Record<string, unknown> }> = [];
        const doCapture = process.env.RCC_SSE_CAPTURE === '1';
        startHeartbeat();
        for (const e of events) {
          if (doCapture) capture.push(e);
          writeEvent(e.event, e.data);
        }
        stopHeartbeat();
        streamEnded = true;
        try { res.write('data: [DONE]\n\n'); } catch { /* ignore */ }
        try { res.end(); } catch { /* ignore */ }
        if (doCapture) {
          try {
            const baseDir = `${process.env.HOME || ''}/.routecodex/codex-samples/anth-replay`;
            await fs.mkdir(baseDir, { recursive: true });
            await fs.writeFile(`${baseDir}/sse-events-${requestId}.log`, capture.map(ev => `${ev.event}: ${JSON.stringify(ev.data)}`).join('\n'));
          } catch { /* ignore */ }
        }
      } catch (e) {
        // As a last resort, coerce message and send minimal sequence
        const finalPayload = streamObj;
        const message = coerceAnthropicMessage(finalPayload);
        writeEvent('message_start', { type: 'message_start', message: { id: message.id, type: 'message', role: 'assistant', model: message.model, content: [], stop_reason: null, stop_sequence: null } });
        const text = (() => { try { const c = Array.isArray(message.content) ? message.content : []; const t = c.find((b: any) => b && b.type === 'text'); return (t && t.text) || ''; } catch { return ''; } })();
        if (text) {
          writeEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
          writeEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
          writeEvent('content_block_stop', { type: 'content_block_stop', index: 0 });
        }
        writeEvent('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason ?? null, stop_sequence: null } });
        writeEvent('message_stop', { type: 'message_stop' });
        stopHeartbeat();
        streamEnded = true;
        try { res.write('data: [DONE]\n\n'); } catch { /* ignore */ }
        try { res.end(); } catch { /* ignore */ }
      }
    } catch (error) {
      stopHeartbeat();
      streamEnded = true;
      writeEvent('error', {
        type: 'error',
        error: { message: (error as Error).message || 'Anthropic stream failure', request_id: requestId },
      });
      try { res.write('data: [DONE]\n\n'); } catch { /* ignore */ }
      try { res.end(); } catch { /* ignore */ }
    }
  }

  /**
   * If response_format.type === 'json_object', try to coerce model output to strict JSON string.
   * This helps clients that parse content as JSON and fail on code fences or extra prose.
   */
  private ensureJsonContentIfRequested(body: unknown, request: Record<string, unknown>, kind: 'chat' | 'text') {
    try {
      const expectJson =
        request && typeof request === 'object' && request !== null && 'response_format' in request && request.response_format && typeof request.response_format === 'object' && request.response_format !== null && 'type' in request.response_format && (request.response_format as Record<string, unknown>).type === 'json_object' ||
        process.env.ROUTECODEX_FORCE_JSON === '1';
      if (!expectJson || !body) {return body;}

      const container = body && typeof body === 'object' && body !== null && 'data' in body ? (body as Record<string, unknown>).data : body;
      if (!container || typeof container !== 'object') {return body;}

      const choices = Array.isArray((container as Record<string, unknown>).choices) ? (container as Record<string, unknown>).choices : [];
      const clean = (s: string): string => {
        if (typeof s !== 'string') {return s;}
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

      for (let i = 0; i < (choices as unknown[]).length; i++) {
        const c = (choices as unknown[])[i] || {};
        if (kind === 'chat') {
          if (c && typeof c === 'object' && c !== null && 'message' in c && c.message && typeof c.message === 'object' && c.message !== null && 'content' in c.message && typeof (c.message as Record<string, unknown>).content === 'string') {
            (c.message as Record<string, unknown>).content = clean((c.message as Record<string, unknown>).content as string);
            if (!(c.message as Record<string, unknown>).role) {(c.message as Record<string, unknown>).role = 'assistant';}
            // Remove verbose or non-standard fields that may confuse strict clients
            if ('reasoning_content' in c.message) {
              try { delete (c.message as Record<string, unknown>).reasoning_content; } catch (_e) { void 0; }
            }
          }
        } else {
          if (c && typeof c === 'object' && c !== null && 'text' in c && typeof (c as Record<string, unknown>).text === 'string') {
            (c as Record<string, unknown>).text = clean((c as Record<string, unknown>).text as string);
          }
        }
        (choices as unknown[])[i] = c;
      }

      (container as Record<string, unknown>).choices = choices;
      if (body && typeof body === 'object' && body !== null && 'data' in body) {
        (body as Record<string, unknown>).data = container;
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
  private decideRouteCategory(_req: Request): string {
    if (!this.routePools) {
      return 'default';
    }
    const categories = Object.keys(this.routePools);
    if (categories.includes('default')) {
      return 'default';
    }
    return categories[0] || 'default';
  }

  /**
   * Start a minimal SSE heartbeat immediately, before upstream processing begins.
   * This keeps the client connection alive without depending on provider stream.
   * Returns a stop function to clear the interval.
   */
  private startPreStreamHeartbeat(res: Response, requestId: string, _model?: string): () => void {
    try {
      // Defer initial SSE header write to allow early JSON error mapping
      // Headers will be written when the first pre-heartbeat tick fires
    } catch { /* ignore header errors */ }

    const PRE_HEARTBEAT_MS = Number(process.env.RCC_PRE_SSE_HEARTBEAT_MS ?? 3000);
    const PRE_HEARTBEAT_DELAY_MS = Number(process.env.RCC_PRE_SSE_HEARTBEAT_DELAY_MS ?? 800);
    if (!(PRE_HEARTBEAT_MS > 0)) {
      // Emit a single comment to flush headers and return noop stopper
      try {
        if (!res.headersSent) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('Transfer-Encoding', 'chunked');
          res.setHeader('x-request-id', requestId);
          try { res.setHeader('x-worker-pid', String(process.pid)); } catch { /* ignore */ }
        }
        res.write(`: pre-start ${Date.now()}\n\n`);
      } catch { /* ignore */ }
      return () => {};
    }

    let counter = 0;
    let intervalTimer: NodeJS.Timeout | null = null;
    const delayTimer = setTimeout(() => {
      try {
        if (!res.headersSent) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('Transfer-Encoding', 'chunked');
          res.setHeader('x-request-id', requestId);
          try { res.setHeader('x-worker-pid', String(process.pid)); } catch { /* ignore */ }
        }
        res.write(`: pre-start ${Date.now()}\n\n`);
      } catch { /* ignore */ }
      intervalTimer = setInterval(() => {
        try {
          counter += 1;
          res.write(`: pre-ping ${counter}\n\n`);
        } catch {
          try { if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; } } catch { /* ignore */ }
        }
      }, PRE_HEARTBEAT_MS);
    }, Math.max(0, PRE_HEARTBEAT_DELAY_MS));

    return () => {
      try { if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; } } catch { /* ignore */ }
      try { clearTimeout(delayTimer); } catch { /* ignore */ }
      try {
        if (res && !res.writableEnded) {
          res.write(`: pre-stop ${Date.now()}\n\n`);
        }
      } catch { /* ignore */ }
    };
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
      const res = await this.classifier.classify(input as ConfigClassificationInput);
      const route = res && typeof res === 'object' && res !== null && 'route' in res ? (res as unknown as Record<string, unknown>).route : undefined;
      if (route && typeof route === 'string' && this.routePools && this.routePools[route]) {
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
    } catch (error) {
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
    } catch (error) {
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
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    try {

      // Not implemented without pass-through
      res.status(501).json({
        error: {
          message: 'Embeddings not implemented. Configure pipeline.',
          type: 'not_implemented',
        },
      });
    } catch (error) {
      await this.handleError(error as Error, 'embeddings_handler');

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
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    try {

      // Not implemented without pass-through
      res.status(501).json({
        error: {
          message: 'Moderations not implemented. Configure pipeline.',
          type: 'not_implemented',
        },
      });
    } catch (error) {
      await this.handleError(error as Error, 'moderations_handler');

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
    try {

      // Not implemented without pass-through
      res.status(501).json({
        error: {
          message: 'Image generations not implemented. Configure pipeline.',
          type: 'not_implemented',
        },
      });
    } catch (error) {
      await this.handleError(error as Error, 'image_generations_handler');

      res.status(500).json({
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
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    try {

      // Not implemented without pass-through
      res.status(501).json({
        error: {
          message: 'Audio transcriptions not implemented. Configure pipeline.',
          type: 'not_implemented',
        },
      });
    } catch (error) {
      await this.handleError(error as Error, 'audio_transcriptions_handler');

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
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    try {

      // Not implemented without pass-through
      res.status(501).json({
        error: {
          message: 'Audio translations not implemented. Configure pipeline.',
          type: 'not_implemented',
        },
      });
    } catch (error) {
      await this.handleError(error as Error, 'audio_translations_handler');

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
    _context: RequestContext,
    res: Response
  ): Promise<unknown> {
    return new Promise((resolve, _reject) => {
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

    // Validate messages (allow string | array-of-parts | object for OpenAI-compatible payloads)
    if (request.messages && Array.isArray(request.messages)) {
      for (let i = 0; i < request.messages.length; i++) {
        const message = request.messages[i];
        if (!message.role || !['system', 'user', 'assistant', 'tool'].includes(message.role)) {
          errors.push(`Message ${i} has invalid role: ${message.role}`);
        }

        const c = message.content;
        // If content is missing/null, allow it (normalizer/pipeline will coerce as needed)
        if (c !== undefined && c !== null) {
          const isString = typeof c === 'string';
          const isArray = Array.isArray(c);
          const isObject = typeof c === 'object' && !isArray;
          if (!(isString || isArray || isObject)) {
            errors.push(`Message ${i} has invalid content: must be string/array/object`);
          }
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
  private sanitizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
    const sanitized: Record<string, string> = {};
    const sensitiveHeaders = ['authorization', 'api-key', 'x-api-key', 'cookie'];

    for (const [key, value] of Object.entries(headers)) {
      if (sensitiveHeaders.includes(key.toLowerCase())) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = Array.isArray(value) ? value.join(', ') : String(value);
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
      const errorContext = {
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
