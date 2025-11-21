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
import { ErrorHandlerRegistry } from '../../../utils/error-handler-registry.js';
import { DebugEventBus } from '../../debugcenter/debug-event-bus-shim.js';
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
  // Round-robin state per route pool; fallback rr for legacy
  private rrCounter = 0;
  private rrIndexByRoute: Map<string, number> = new Map();

  // 429 error handling properties
  private key429Tracker: Key429Tracker;
  private pipelineHealthManager: PipelineHealthManager;
  // Dynamic route-pool state (in-memory): routePools and per-pipeline 429/cooldown/ban
  private routePools: Record<string, string[]> = {};
  private pipeline429State: Map<string, { step: number; consecutive: number; firstAt: number; lastAt: number; cooldownUntil?: number; bannedToday?: boolean; bannedReason?: string }> = new Map();
  // Model-level 429 state (cross-route/cross-pool): keyed by providerId::modelId
  private model429State: Map<string, { step: number; consecutive: number; lastAt: number; cooldownUntil: number }> = new Map();
  // 聚合器熔断状态（与 429 独立）：按“上游端点维度”记录 openai_error/bad_response_status_code 错误次数与冷却窗口，
  // 并在冷却期间对请求进行排队与合并。
  private meltdownState: Map<string, { consecutive: number; step: number; cooldownUntil: number; draining: boolean; queue: Array<{ request: PipelineRequest; resolve: (res: PipelineResponse) => void; reject: (err: unknown) => void }> }> = new Map();

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

      // Initialize round-robin baseline order
      try {
        this.rrCounter = 0;
      } catch { /* ignore */ }

    } catch (error) {
      this.logger.logPipeline('manager', 'initialization-error', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  // Inject assembled routePools from server so we can restrict 429 switching within the same pool
  public attachRoutePools(pools: Record<string, string[]>): void {
    this.routePools = pools || {};
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

    // Fail fast if the target model is currently in 429 cooldown (model-level熔断，跨route/pool去重)
    try {
      const modelKey = this.getModelKeyForRoute(routeRequest);
      if (this.isModelCoolingDown(modelKey)) {
        const retryAfterMs = this.getModelRetryAfterMs(modelKey);
        const e: any = new Error('Upstream model cooling down due to previous 429s');
        e.statusCode = 429;
        e.code = 'HTTP_429_MODEL_COOLDOWN';
        if (retryAfterMs > 0) {
          e.retryAfterMs = retryAfterMs;
        }
        e.context = {
          providerId: routeRequest.providerId,
          modelId: routeRequest.modelId,
          modelKey
        };
        throw e;
      }
    } catch { /* 如果模式键推导失败，不影响正常路由 */ }

    // If no explicit pipelineId, perform per-route-pool round-robin selection
    const directId = (routeRequest as any).pipelineId as string | undefined;
    if (!directId) {
      // Determine route pool name (default if not provided)
      const routeName = String((routeRequest as any)?.routeName || (routeRequest as any)?.metadata?.routeName || 'default');
      const poolIds: string[] = Array.isArray((this.routePools as any)?.[routeName]) ? (this.routePools as any)[routeName] : [];
      let candidates: BasePipeline[] = [];
      if (poolIds.length) {
        const now = Date.now();
        candidates = poolIds
          .map(id => this.pipelines.get(id))
          .filter((p): p is BasePipeline => !!p)
          .filter(p => {
            const st = this.pipeline429State.get(p.pipelineId);
            const inCooldown = st && st.cooldownUntil !== undefined && now < (st.cooldownUntil || 0);
          const banned = st && st.bannedToday === true;
          // 移除健康 gating：仅按429冷却/当日拉黑过滤
          return !inCooldown && !banned;
        });
      }
      // 不再在此处执行“跨池 fallback”；路由池选择由虚拟路由器统一决策，
      // 若该池内所有流水线均不可用，则直接报错。
      if (!candidates.length) {
        throw new Error(`No pipelines available for round-robin selection (route=${routeName})`);
      }
      const cur = this.rrIndexByRoute.get(routeName) || 0;
      const idx = cur % candidates.length;
      const chosen = candidates[idx];
      this.rrIndexByRoute.set(routeName, (cur + 1) % Math.max(1, candidates.length));
      this.logger.logPipeline('manager', 'pipeline-selected-rr', {
        chosen: chosen.pipelineId,
        total: candidates.length,
        rrIndex: idx,
        routeName,
        providerId: routeRequest.providerId,
        modelId: routeRequest.modelId
      });
      return chosen;
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
    const requestContext = {
      requestId,
      providerId: request.route.providerId,
      modelId: request.route.modelId,
      startTime,
      managerEnhanced: this.isEnhanced
    };

    try {
      // 熔断入口：若该上游端点处于 meltdown 冷却期或正在 drain 队列，则将请求加入队列，由“队长”统一在冷却结束后发起单次上游调用。
      try {
        const meltdownKey = this.buildMeltdownKeyFromRequest(request);
        if (meltdownKey) {
          const state = this.meltdownState.get(meltdownKey);
          const now = Date.now();
          const inCooldown = !!state && state.cooldownUntil > now;
          const draining = !!state && state.draining;
          if (inCooldown || draining) {
            return await this.enqueueDuringMeltdown(meltdownKey, request);
          }
        }
      } catch {
        // 熔断键推导失败时，不影响正常请求
      }

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

      // Process request through selected pipeline
      const response = await this.processRequestWithPipeline(pipeline, request);

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
   * Build a stable model key for a route-level request (providerId + modelId).
   * 用于跨 route/pool 的 429 熔断去重。
   */
  private getModelKeyForRoute(routeRequest: RouteRequest): string {
    const providerId = String(routeRequest.providerId || 'unknown');
    const modelId = String(routeRequest.modelId || 'unknown');
    return `${providerId}::${modelId}`;
  }

  /**
   * Build model key for an in-flight pipeline + request pair.
   * 目前与 getModelKeyForRoute 保持一致，后续如有需要可从 pipeline.config 提取实际上游模型。
   */
  private getModelKeyForRequest(_pipeline: BasePipeline, request: PipelineRequest): string {
    return this.getModelKeyForRoute({
      providerId: request.route.providerId,
      modelId: request.route.modelId,
      requestId: request.route.requestId
    } as RouteRequest);
  }

  /**
   * 检查某个模型是否处于 429 冷却期
   */
  private isModelCoolingDown(modelKey: string): boolean {
    const st = this.model429State.get(modelKey);
    if (!st) return false;
    return st.cooldownUntil > Date.now();
  }

  /**
   * 返回模型剩余冷却时间（毫秒）
   */
  private getModelRetryAfterMs(modelKey: string): number {
    const st = this.model429State.get(modelKey);
    if (!st) return 0;
    const remaining = st.cooldownUntil - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  /**
   * 记录一次 429 错误并更新模型退避节奏，返回本次推荐的 retryAfterMs。
   * 退避节奏：30s, 60s, 120s（单模型维度），不在当前请求内等待。
   */
  private updateModel429State(modelKey: string): number {
    const now = Date.now();
    const existing = this.model429State.get(modelKey);
    const schedule = this.getBackoffSchedule();

    if (!existing) {
      const delay = schedule[0] ?? 30000;
      this.model429State.set(modelKey, {
        step: 1,
        consecutive: 1,
        lastAt: now,
        cooldownUntil: now + delay
      });
      return delay;
    }

    const step = Math.min((existing.step || 0) + 1, 3);
    const delay = schedule[Math.max(0, Math.min(step - 1, schedule.length - 1))] ?? 30000;
    const next = {
      step,
      consecutive: (existing.consecutive || 0) + 1,
      lastAt: now,
      cooldownUntil: now + delay
    };
    this.model429State.set(modelKey, next);
    return delay;
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
        healthManager: this.pipelineHealthManager.getDebugInfo()
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
   * Process request with specific pipeline and retry tracking
   */
  private async processRequestWithPipeline(
    pipeline: BasePipeline,
    request: PipelineRequest
  ): Promise<PipelineResponse> {
    try {
      const response = await pipeline.processRequest(request);

      // On success, record success and clear 429 consecutive state for this pipeline
      this.pipelineHealthManager.recordSuccess(pipeline.pipelineId);
      try { this.reset429State(pipeline.pipelineId); } catch { /* ignore */ }
      // 成功响应会清理端点级熔断状态（视为“恢复正常”）
      try {
        const meltdownKey = this.buildMeltdownKeyFromRequest(request);
        if (meltdownKey && this.meltdownState.has(meltdownKey)) {
          this.meltdownState.delete(meltdownKey);
        }
      } catch { /* ignore */ }

      return response;
    } catch (error) {
      // Check if it's a 429 error (robust detection)
      const errorObj = error as Record<string, unknown>;
      const status = (errorObj['statusCode'] as any) || (errorObj['status'] as any) || (errorObj as any)?.response?.status;
      // Collect common code fields (flattened and nested) and evaluate strictly
      const codeCandidatesRaw: any[] = [
        (errorObj as any)?.code,
        (errorObj as any)?.error?.code,
        (errorObj as any)?.errors?.code,
        (errorObj as any)?.response?.data?.error?.code,
        (errorObj as any)?.response?.data?.errors?.code,
      ].filter((v) => v !== undefined && v !== null);
      const codeMatchStrict = (() => {
        const known = new Set([
          '429', 'HTTP_429', 'TOO_MANY_REQUESTS', 'RATE_LIMITED', 'RATE_LIMIT', 'REQUEST_LIMIT_EXCEEDED', 'RATE_LIMIT_EXCEEDED'
        ]);
        for (const v of codeCandidatesRaw) {
          if (typeof v === 'number' && v === 429) return true;
          const s = String(v).trim();
          if (/^\d+$/.test(s) && Number(s) === 429) return true;
          const u = s.toUpperCase();
          if (known.has(u)) return true;
        }
        return false;
      })();
      const looks429 = (() => {
        if (status === 429) return true;
        if (codeMatchStrict) return true;
        // Contains check on code fields only (no text fallback)
        for (const v of codeCandidatesRaw) {
          try { if (String(v).includes('429')) return true; } catch { /* ignore */ }
        }
        return false;
      })();
      // 429：沿用原有模型级退避与熔断逻辑（HTTP 429 模型熔断）。
      if (looks429) {
        try {
          const modelKey = this.getModelKeyForRequest(pipeline, request);
          const retryAfterMs = this.updateModel429State(modelKey);
          const msg = error instanceof Error ? error.message : String(error);
          this.pipelineHealthManager.recordError(pipeline.pipelineId, `${msg} (cooldown ${retryAfterMs}ms)`);
        } catch { /* ignore cooldown bookkeeping errors */ }
      }

      // 聚合器错误（openai_error / bad_response_status_code）：
      // 按“上游端点维度”（meltdownKey）做熔断计数，3 次连续错误后进入 5s/10s/30s 冷却。
      try {
        const meltdownKey = this.buildMeltdownKeyFromRequest(request, error);
        if (meltdownKey) {
          const msg = typeof (error as any)?.message === 'string'
            ? (error as any).message
            : String((error as any)?.message ?? '');
          const codeStrs = codeCandidatesRaw.map(v => String(v || '').toLowerCase());
          const hasMeltdownCode = codeStrs.some(s => s.includes('bad_response_status_code'));
          const isMeltdownError = /openai_error/i.test(msg) || hasMeltdownCode;
          if (isMeltdownError) {
            const { consecutive, step, cooldownUntil } = this.updateMeltdownState(meltdownKey);
            const now = Date.now();
            const cooldownInfo = cooldownUntil > now ? ` (endpoint cooldown ${cooldownUntil - now}ms)` : '';
            const logMsg = error instanceof Error ? error.message : String(error);
            this.pipelineHealthManager.recordError(pipeline.pipelineId, `${logMsg}${cooldownInfo}`);
          }
        }
      } catch { /* ignore meltdown bookkeeping errors */ }

      // For non-429 errors（或已标记冷却的429/熔断），handle special cases (401/403) → ban today; otherwise record error
      const errorMessage = error instanceof Error ? error.message : String(error);
      try {
        const status = (error as any)?.statusCode || (error as any)?.status || (error as any)?.response?.status;
        if (status === 401 || status === 403) {
          this.markPipelineBannedToday(pipeline.pipelineId, 'auth_invalid');
        }
      } catch { /* ignore */ }
      this.pipelineHealthManager.recordError(pipeline.pipelineId, errorMessage);
      throw error;
    }
  }

  /**
   * 针对聚合器错误更新 meltdown 状态：返回最新的计数与冷却窗口。
   */
  private updateMeltdownState(meltdownKey: string): { consecutive: number; step: number; cooldownUntil: number } {
    const now = Date.now();
    const existing = this.meltdownState.get(meltdownKey) || {
      consecutive: 0,
      step: 0,
      cooldownUntil: 0,
      draining: false,
      queue: [] as Array<{ request: PipelineRequest; resolve: (res: PipelineResponse) => void; reject: (err: unknown) => void }>
    };

    const consecutive = (existing.consecutive || 0) + 1;
    let step = existing.step || 0;
    let cooldownUntil = existing.cooldownUntil || 0;

    if (consecutive >= 3) {
      const schedule = this.getBackoffSchedule();
      step = Math.min(step + 1, 3);
      const idx = Math.max(0, Math.min(step - 1, schedule.length - 1));
      const delay = schedule[idx] ?? 5000;
      cooldownUntil = now + delay;
    }

    const next = {
      consecutive,
      step,
      cooldownUntil,
      draining: existing.draining === true,
      queue: existing.queue || []
    };
    this.meltdownState.set(meltdownKey, next);
    return { consecutive, step, cooldownUntil };
  }

  /**
   * 构建 meltdownKey：优先使用错误对象上的标记，其次退回到 providerId + entryEndpoint。
   */
  private buildMeltdownKeyFromRequest(request: PipelineRequest, error?: unknown): string | null {
    try {
      const errAny = error as any;
      if (errAny && typeof errAny.meltdownKey === 'string' && errAny.meltdownKey.trim()) {
        return String(errAny.meltdownKey).trim();
      }
    } catch {
      // ignore
    }

    try {
      const providerId = String(request.route.providerId || 'unknown').toLowerCase();
      const ep = String(((request as any)?.metadata?.entryEndpoint) || '').toLowerCase();
      if (!ep) return null;
      return `${providerId}::${ep}`;
    } catch {
      return null;
    }
  }

  /**
   * 冷却期请求排队 + 合并：仅在 meltdown 冷却或 drain 中调用。
   * 所有排队请求会共享同一次上游调用结果（leader）。
   */
  private async enqueueDuringMeltdown(meltdownKey: string, request: PipelineRequest): Promise<PipelineResponse> {
    return await new Promise<PipelineResponse>((resolve, reject) => {
      const now = Date.now();
      const existing = this.meltdownState.get(meltdownKey) || {
        consecutive: 0,
        step: 0,
        cooldownUntil: now,
        draining: false,
        queue: [] as Array<{ request: PipelineRequest; resolve: (res: PipelineResponse) => void; reject: (err: unknown) => void }>
      };

      const queue = existing.queue || [];
      queue.push({ request, resolve, reject });

      const next = {
        consecutive: existing.consecutive,
        step: existing.step,
        cooldownUntil: existing.cooldownUntil,
        draining: existing.draining,
        queue
      };
      this.meltdownState.set(meltdownKey, next);

      // 若当前没有 drain 协程，则当前请求成为“队长”，负责在冷却结束后触发一次上游调用并广播结果。
      if (!next.draining) {
        next.draining = true;
        this.meltdownState.set(meltdownKey, next);
        // 异步启动 drain，不阻塞当前 Promise 构造
        void this.drainMeltdownQueue(meltdownKey);
      }
    });
  }

  /**
   * 在冷却结束后 drain meltdown 队列：仅向上游发起一次请求，并将结果广播给所有排队请求。
   */
  private async drainMeltdownQueue(meltdownKey: string): Promise<void> {
    let state = this.meltdownState.get(meltdownKey);
    if (!state) {
      return;
    }

    // 等待冷却窗口结束
    const now = Date.now();
    const waitMs = Math.max(0, state.cooldownUntil - now);
    if (waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    // 再次读取最新 state，获取队列快照
    state = this.meltdownState.get(meltdownKey);
    if (!state || !state.queue || state.queue.length === 0) {
      // 无请求需要处理，标记为非 draining
      if (state) {
        this.meltdownState.set(meltdownKey, { ...state, draining: false });
      }
      return;
    }

    const queue = state.queue;
    const leader = queue.shift()!;
    const followers = queue.splice(0);

    // 清空队列，但保留 meltdown 计数与 cooldown，draining 标记在 finally 中重置。
    this.meltdownState.set(meltdownKey, {
      consecutive: state.consecutive,
      step: state.step,
      cooldownUntil: state.cooldownUntil,
      draining: true,
      queue: []
    });

    let leaderResponse: PipelineResponse | null = null;
    let leaderError: unknown = null;

    try {
      const pipeline = this.selectPipeline({
        providerId: leader.request.route.providerId,
        modelId: leader.request.route.modelId,
        requestId: leader.request.route.requestId
      } as any);

      leaderResponse = await this.processRequestWithPipeline(pipeline, leader.request);

      // 成功：视为端点恢复，清理 meltdown 状态
      this.meltdownState.delete(meltdownKey);
    } catch (error) {
      leaderError = error;
      // 失败：更新 meltdown 状态以进入下一轮冷却
      try {
        this.updateMeltdownState(meltdownKey);
      } catch {
        // ignore meltdown bookkeeping errors
      }
    } finally {
      const latest = this.meltdownState.get(meltdownKey);
      if (latest) {
        this.meltdownState.set(meltdownKey, {
          ...latest,
          draining: false,
          queue: latest.queue || []
        });
      }
    }

    if (leaderResponse) {
      leader.resolve(leaderResponse);
      for (const follower of followers) {
        try {
          follower.resolve(leaderResponse);
        } catch {
          // ignore individual resolution errors
        }
      }
    } else {
      leader.reject(leaderError);
      for (const follower of followers) {
        try {
          follower.reject(leaderError);
        } catch {
          // ignore
        }
      }
    }
  }

  // 429 dynamic state helpers
  private apply429StepForPipeline(pipelineId: string): void {
    const now = Date.now();
    const cur = this.pipeline429State.get(pipelineId) || { step: 0, consecutive: 0, firstAt: now, lastAt: now };
    const consecutive = (cur.consecutive || 0) + 1;
    const firstAt = cur.firstAt || now;
    const step = Math.min((cur.step || 0) + 1, 3);
    const schedule = this.getBackoffSchedule();
    const delay = schedule[Math.max(0, Math.min(step - 1, schedule.length - 1))] || 30000;
    const cooldownUntil = now + delay;
    const windowMs = now - firstAt;
    const banDisabled = this.is429BanDisabled();
    const bannedToday = banDisabled ? false : ((windowMs > 120000) ? true : (cur.bannedToday === true));
    const next = { step, consecutive, firstAt, lastAt: now, cooldownUntil, bannedToday, bannedReason: bannedToday ? 'quota_exhausted_today' : undefined };
    this.pipeline429State.set(pipelineId, next as any);
  }

  private reset429State(pipelineId: string): void {
    const cur = this.pipeline429State.get(pipelineId);
    if (!cur) return;
    this.pipeline429State.set(pipelineId, { step: 0, consecutive: 0, firstAt: 0, lastAt: 0 });
  }

  private markPipelineBannedToday(pipelineId: string, reason: string): void {
    if (this.is429BanDisabled()) { return; }
    const now = Date.now();
    const cur = this.pipeline429State.get(pipelineId) || { step: 0, consecutive: 0, firstAt: now, lastAt: now };
    this.pipeline429State.set(pipelineId, { ...cur, bannedToday: true, bannedReason: reason, cooldownUntil: undefined });
  }

  private getBackoffSchedule(): number[] {
    const cfgSchedule = ((this.config?.settings as any)?.rateLimit?.backoffMs as number[] | undefined) || [];
    let schedule = Array.isArray(cfgSchedule) ? cfgSchedule.filter(v => Number.isFinite(v) && v > 0) : [];
    if (!schedule.length) {
      // 默认冷却节奏：5s, 10s, 30s（可通过环境变量覆盖）
      const s1 = Number(process.env.RCC_429_BACKOFF_MS_1 || process.env.ROUTECODEX_429_BACKOFF_MS_1 || 5000);
      const s2 = Number(process.env.RCC_429_BACKOFF_MS_2 || process.env.ROUTECODEX_429_BACKOFF_MS_2 || 10000);
      const s3 = Number(process.env.RCC_429_BACKOFF_MS_3 || process.env.ROUTECODEX_429_BACKOFF_MS_3 || 30000);
      schedule = [s1, s2, s3].filter(v => Number.isFinite(v) && v > 0);
    }
    return schedule;
  }

  private is429BanDisabled(): boolean {
    const v = String(process.env.RCC_429_DISABLE_BAN || process.env.ROUTECODEX_429_DISABLE_BAN || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
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
    // Provider V2: HTTP-only families（按协议族拆分）
    this.registry.registerModule('openai-http-provider', this.createOpenAIProviderModule);
    this.registry.registerModule('responses-http-provider', this.createOpenAIProviderModule);
    this.registry.registerModule('anthropic-http-provider', this.createOpenAIProviderModule);
    // Family aliases → 归一到 V2 Provider 工厂（兼容现有 pipeline_assembler 输出）
    this.registry.registerModule('openai', this.createOpenAIProviderModule);
    this.registry.registerModule('responses', this.createOpenAIProviderModule);
    this.registry.registerModule('anthropic', this.createOpenAIProviderModule);
    // Family-specific compatibility modules
    this.registry.registerModule("iflow-compatibility", this.createIFlowCompatibilityModule);

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

  private createOpenAIProviderModule = async (config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
    const { ProviderFactory } = await import('../modules/provider/v2/core/provider-factory.js');
    const v2Config = this.toV2ProviderConfig(config);
    const validation = ProviderFactory.validateConfig(v2Config);
    if (!validation.isValid) {
      throw new Error(`Invalid V2 provider configuration: ${validation.errors.join(', ')}`);
    }
    return ProviderFactory.createProvider(v2Config, dependencies);
  };

  /**
   * 将组装后的 ModuleConfig 直接转换为 V2 OpenAIStandardConfig（不再走 V1 兼容路径）。
   * 严格要求 provider.config.providerType 存在；不做推测与回退。
   */
  private toV2ProviderConfig(config: ModuleConfig): import('../modules/provider/v2/api/provider-config.js').OpenAIStandardConfig {
    const cfg = (config?.config || {}) as Record<string, unknown>;
    const moduleType = typeof config.type === 'string' ? config.type.trim() : 'openai-standard';

    // 新的 HTTP Provider 模块类型（按协议族拆分），其余路径仍走 openai-standard 统一实现
    const v2Type: import('../modules/provider/v2/api/provider-config.js').OpenAIStandardConfig['type'] =
      moduleType === 'openai-http-provider' ||
      moduleType === 'responses-http-provider' ||
      moduleType === 'anthropic-http-provider'
        ? (moduleType as any)
        : 'openai-standard';

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
    const authCapabilities = (cfg['authCapabilities'] as { required?: string[]; optional?: string[] }) || undefined;
    const model = typeof cfg['model'] === 'string' ? (cfg['model'] as string) : undefined;
    const defaultModel = typeof cfg['defaultModel'] === 'string' ? (cfg['defaultModel'] as string) : undefined;

    const overrides: Record<string, unknown> = {};
    if (endpoint) overrides['endpoint'] = endpoint;
    if (typeof timeout === 'number') overrides['timeout'] = timeout;
    if (typeof maxRetries === 'number') overrides['maxRetries'] = maxRetries;
    if (headers && Object.keys(headers).length) overrides['headers'] = headers;
    if (defaultModel) overrides['defaultModel'] = defaultModel;

    const extensions = (cfg['extensions'] as Record<string, unknown>) || undefined;

    const v2: any = {
      type: v2Type,
      config: {
        providerType,
        auth,
        ...(baseUrl ? { baseUrl } : {}),
        ...(model ? { model } : {}),
        ...(Object.keys(overrides).length ? { overrides } : {}),
        ...(authCapabilities ? { authCapabilities } : {}),
        ...(extensions ? { extensions } : {})
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
