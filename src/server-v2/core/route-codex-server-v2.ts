// @ts-nocheck
/**
 * RouteCodex Server V2 - 渐进式重构版本
 *
 * 核心特性：
 * - 与现有V1服务器完全并行
 * - 集成系统hooks模块
 * - 模块化设计，职责分离
 * - 保持API兼容性
 */

import express, { type Application, type Request, type Response } from 'express';
import { BaseModule, type ModuleInfo } from '../../modules/config-manager/base-module-shim.js';
import { ErrorHandlingCenter } from '../../modules/errorhandling/error-handling-center-shim.js';
import { DebugEventBus } from '../../modules/debugcenter/debug-event-bus-shim.js';
import type { UnknownObject } from '../../types/common-types.js';
import { ServerV2HookIntegration, type ServerV2HookContext } from '../hooks/server-v2-hook-integration.js';
import { ServerRequestLoggingHook } from '../hooks/impl/server-request-logging-hook.js';
import { ServerResponseEnhancementHook } from '../hooks/impl/server-response-enhancement-hook.js';
import { ServerPerformanceMonitoringHook } from '../hooks/impl/server-performance-monitoring-hook.js';
import { UnifiedHookStage } from '../../modules/hooks/types/hook-types.js';
import { handleChatCompletions } from '../../server/handlers/chat-handler.js';
import { handleMessages } from '../../server/handlers/messages-handler.js';
import { handleResponses } from '../../server/handlers/responses-handler.js';
import { handleSubmitToolOutputs } from '../../server/handlers/submit-tool-outputs-handler.js';
import type { HandlerContext } from '../../server/handlers/types.js';

/**
 * V2服务器配置接口
 */
export interface ServerConfigV2 {
  server: {
    port: number;
    host: string;
    timeout?: number;
    useV2?: boolean;  // V2特定配置
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    enableConsole?: boolean;
    enableFile?: boolean;
    filePath?: string;
  };
  providers: Record<string, UnknownObject>;
  v2Config?: {
    enableHooks?: boolean;
    hookStages?: string[];
  };
}

/**
 * V2服务器状态
 */
export interface ServerStatusV2 {
  initialized: boolean;
  running: boolean;
  port: number;
  host: string;
  uptime: number;
  memory: NodeJS.MemoryUsage;
  version: 'v2';
  hooksEnabled: boolean;
}

/**
 * 请求上下文接口
 */
export interface RequestContextV2 {
  requestId: string;
  timestamp: number;
  method: string;
  url: string;
  userAgent?: string;
  ip?: string;
  endpoint: string;
}

/**
 * RouteCodex Server V2
 *
 * 与V1完全并行实现，集成系统hooks
 */
export class RouteCodexServerV2 extends BaseModule {
  private app: Application;
  private server?: unknown;
  private config: ServerConfigV2;
  private errorHandling: ErrorHandlingCenter;
  private debugEventBus: DebugEventBus;
  private _isInitialized: boolean = false;
  private _isRunning: boolean = false;

  // V2特性
  private hooksEnabled: boolean = false;
  private hookIntegration?: ServerV2HookIntegration;
  // Routing and pipeline state (align with V1 HttpServer for parity)
  private pipelineManager: any = null;
  private routePools: Record<string, string[]> = {};
  private routeMeta: Record<string, { providerId: string; modelId: string; keyId: string }> = {} as any;
  private virtualRouter: any = null;
  private classifierConfig: unknown = null;
  private rrIndex: Map<string, number> = new Map();

  constructor(config: ServerConfigV2) {
    const moduleInfo: ModuleInfo = {
      id: 'routecodex-server-v2',
      name: 'RouteCodexServerV2',
      version: '2.0.0',
      description: 'RouteCodex Server V2 with enhanced hooks',
      type: 'server',
    };

    super(moduleInfo);

    this.config = config;
    this.app = express();
    this.errorHandling = new ErrorHandlingCenter();
    this.debugEventBus = DebugEventBus.getInstance();

    // V2特性初始化
    this.hooksEnabled = config.v2Config?.enableHooks ?? false;

    // 初始化Hook集成系统 (如果启用)
    if (this.hooksEnabled) {
      console.log('[RouteCodexServerV2] Initializing Hook integration system...');
      this.initializeHookIntegration();
    }

    console.log(`[RouteCodexServerV2] Initialized with hooks: ${this.hooksEnabled}`);
  }

  /**
   * 初始化服务器
   */
  public async initialize(): Promise<void> {
    try {
      console.log('[RouteCodexServerV2] Starting initialization...');

      // 初始化错误处理
      await this.errorHandling.initialize();

      // 设置调试事件监听
      this.setupDebugLogging();

      // 设置中间件（保持空，实现 parity）
      await this.setupMiddleware();

      // 设置HTTP端点（完全对齐V1行为）
      await this.setupRoutes();

      // 设置错误处理
      this.setupErrorHandling();

      this._isInitialized = true;

      this.logEvent('server-v2', 'initialized', {
        port: this.config.server.port,
        host: this.config.server.host,
        hooksEnabled: this.hooksEnabled,
        middlewareEnabled: this.middlewareEnabled,
        version: '2.0.0'
      });

      console.log('[RouteCodexServerV2] Initialization completed successfully');

    } catch (error) {
      await this.handleError(error as Error, 'initialization');
      throw error;
    }
  }

  /**
   * 启动服务器
   */
  public async start(): Promise<void> {
    if (!this._isInitialized) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.config.server.port, this.config.server.host, () => {
        this._isRunning = true;

        this.logEvent('server-v2', 'started', {
          port: this.config.server.port,
          host: this.config.server.host,
          version: 'v2'
        });

        console.log(`[RouteCodexServerV2] Server started on ${this.config.server.host}:${this.config.server.port}`);
        resolve();
      });

      (this.server as any).on('error', async (error: Error) => {
        await this.handleError(error, 'server_start');
        reject(error);
      });
    });
  }

  /**
   * 停止服务器
   */
  public async stop(): Promise<void> {
    if (this.server) {
      return new Promise(resolve => {
        (this.server as any)?.close(async () => {
          this._isRunning = false;

          this.logEvent('server-v2', 'stopped', {});

          // 清理资源
          await this.errorHandling.destroy();

          console.log('[RouteCodexServerV2] Server stopped');
          resolve();
        });
      });
    }
  }

  /**
   * 获取服务器状态
   */
  public getStatus(): ServerStatusV2 {
    return {
      initialized: this._isInitialized,
      running: this._isRunning,
      port: this.config.server.port,
      host: this.config.server.host,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: 'v2',
      hooksEnabled: this.hooksEnabled
    };
  }

  // Non-standard helper used by index.ts for logging URL
  public getServerConfig(): { host: string; port: number } {
    return { host: this.config.server.host, port: this.config.server.port };
  }

  /**
   * V1兼容接口：检查是否已初始化
   */
  public isInitialized(): boolean {
    return this._isInitialized;
  }

  /**
   * V1兼容接口：检查是否正在运行
   */
  public isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * 设置中间件 (已移除所有中间件)
   */
  private async setupMiddleware(): Promise<void> {
    // 与V1对齐：启用 JSON 解析中间件（不做业务逻辑）
    try {
      const json = (express as any).json || (() => undefined);
      this.app.use(json({ limit: '10mb' }));
      console.log('[RouteCodexServerV2] Middleware: express.json enabled');
    } catch {
      console.warn('[RouteCodexServerV2] Failed to enable express.json; request bodies may be empty');
    }
  }

  /**
   * 设置路由
   */
  private async setupRoutes(): Promise<void> {
    console.log('[RouteCodexServerV2] Setting up routes...');

    // Health (V1 parity)
    this.app.get('/health', (_req: Request, res: Response) => {
      res.status(200).json({ status: 'ok', server: 'routecodex', version: String(process.env.ROUTECODEX_VERSION || 'dev') });
    });

    // Config (minimal parity)
    this.app.get('/config', (_req: Request, res: Response) => {
      res.status(200).json({ httpserver: { host: this.config.server.host, port: this.config.server.port }, merged: false });
    });

    // Shutdown (localhost only)
    this.app.post('/shutdown', (req: Request, res: Response) => {
      try {
        const ip = (req.socket && (req.socket as any).remoteAddress) || '';
        const allowed = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
        if (!allowed) { res.status(403).json({ error: { message: 'forbidden' } }); return; }
        res.status(200).json({ ok: true });
        setTimeout(() => { try { process.kill(process.pid, 'SIGTERM'); } catch {} }, 50);
      } catch {
        try { res.status(200).json({ ok: true }); } catch {}
        setTimeout(() => { try { process.kill(process.pid, 'SIGTERM'); } catch {} }, 50);
      }
    });

    // Debug pipelines
    this.app.get('/debug/pipelines', (_req: Request, res: Response) => {
      try {
        const mgr: any = this.getPipelineManager();
        const ids = Array.isArray(mgr?.getPipelineIds?.()) ? mgr.getPipelineIds() : [];
        let status: any = null;
        try { status = typeof mgr?.getStatus === 'function' ? mgr.getStatus() : null; } catch { status = null; }
        res.status(200).json({ ids, routePools: this.routePools, routeMeta: this.routeMeta, status });
      } catch (e: any) {
        res.status(500).json({ error: { message: e?.message || String(e) } });
      }
    });

    // Core API endpoints — reuse V1 handlers for parity, with optional V2 hook snapshots
    const withHookSnapshots = <H extends (req: Request, res: Response) => Promise<void>>(endpoint: string, handler: H) => {
      return async (req: Request, res: Response) => {
        const rid = (req as any).__requestId || this.generateRequestId();
        (req as any).__requestId = rid;
        const hctx = this.createHookContext(rid, endpoint, req.body);
        // Patch res.json to capture response body
        const originalJson = res.json.bind(res);
        (res as any).json = (body: any) => {
          if (this.hooksEnabled && this.hookIntegration) {
            this.executeHooksWithSnapshot('server-response', body, hctx).catch(()=>{});
            this.executeHooksWithSnapshot('server-final', body, hctx).catch(()=>{});
          }
          return originalJson(body);
        };
        // entry + pre-process snapshots
        if (this.hooksEnabled && this.hookIntegration) {
          await this.executeHooksWithSnapshot('server-entry', req.body, hctx).catch(()=>{});
          await this.executeHooksWithSnapshot('server-pre-process', req.body, hctx).catch(()=>{});
        }
        try {
          await handler(req, res);
        } catch (err) {
          if (this.hooksEnabled && this.hookIntegration) {
            await this.executeHooksWithSnapshot('server-error', { error: String((err as any)?.message || err) } as any, hctx).catch(()=>{});
          }
          throw err;
        }
      };
    };

    this.app.post('/v1/chat/completions', withHookSnapshots('/v1/chat/completions', async (req, res) => {
      await handleChatCompletions(req, res, this.buildHandlerContext());
    }));
    this.app.post('/v1/messages', withHookSnapshots('/v1/messages', async (req, res) => {
      await handleMessages(req, res, this.buildHandlerContext());
    }));
    this.app.post('/v1/responses', withHookSnapshots('/v1/responses', async (req, res) => {
      await handleResponses(req, res, this.buildHandlerContext());
    }));
    this.app.post('/v1/responses/:id/submit_tool_outputs', withHookSnapshots('/v1/responses', async (req, res) => {
      await handleSubmitToolOutputs(req, res, this.buildHandlerContext());
    }));

    // 404处理器
    this.app.use('*', (req: Request, res: Response) => {
      res.status(404).json({
        error: {
          message: 'Not Found',
          type: 'not_found_error',
          code: 'not_found',
        },
      });
    });

    console.log('[RouteCodexServerV2] Routes setup completed');
  }

  /**
   * V2专用Chat Completions处理器
   */
  private async handleChatCompletionsV2(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = (req as any).__requestId || this.generateRequestId();

    const context: RequestContextV2 = {
      requestId,
      timestamp: startTime,
      method: req.method,
      url: req.url,
      userAgent: req.get('user-agent'),
      ip: req.ip,
      endpoint: '/v2/chat/completions'
    };

    this.logEvent('api-v2', 'chat_completions_request', {
      requestId,
      model: req.body.model,
      messageCount: req.body.messages?.length || 0,
      streaming: req.body.stream || false,
      tools: !!req.body.tools
    });

    try {
      // 创建Hook上下文
      const hookContext = this.createHookContext(requestId, '/v2/chat/completions', req.body);

      // 执行入口Hook
      const entryResult = await this.executeHooksWithSnapshot('server-entry', req.body, hookContext);

      // 执行预处理Hook
      const preProcessResult = await this.executeHooksWithSnapshot('server-pre-process', entryResult.data, hookContext);

      // 通过Pipeline系统处理请求（已弃用：当前端点复用V1处理器）
      let response: any;

      try {
        console.log('[RouteCodexServerV2] Processing request through Pipeline Manager');

        // 获取Pipeline Manager（按照V1方式）
        const pipelineManager = this.getPipelineManager();
        if (!pipelineManager) {
          throw new Error('Pipeline Manager not available');
        }

        // 构建PipelineRequest（按照V1方式）
        const pipelineRequest = {
          model: req.body.model || 'gpt-3.5-turbo',
          messages: req.body.messages || [],
          stream: req.body.stream || false,
          tools: req.body.tools,
          temperature: req.body.temperature,
          max_tokens: req.body.max_tokens,
          ...req.body
        };

        // 调用Pipeline处理（按照V1方式）
        const pipelineResponse = await pipelineManager.processRequest(pipelineRequest);

        response = pipelineResponse && typeof pipelineResponse === 'object' && 'data' in pipelineResponse
          ? (pipelineResponse as Record<string, unknown>).data
          : pipelineResponse;

        // 添加V2增强标识
        response.serverV2Enhanced = true;
        response.processingTime = Date.now() - startTime;

        console.log('[RouteCodexServerV2] Pipeline processing successful:', {
          requestId,
          processingTime: `${response.processingTime}ms`
        });

      } catch (error) {
        console.error('[RouteCodexServerV2] Pipeline processing failed:', error);
        throw error;
      }

      // 执行后处理Hook
      const postProcessResult = await this.executeHooksWithSnapshot('server-post-process', response, hookContext);

      // 执行响应Hook
      const responseResult = await this.executeHooksWithSnapshot('server-response', postProcessResult.data, hookContext);

      // 执行最终Hook
      const finalResult = await this.executeHooksWithSnapshot('server-final', responseResult.data, hookContext);

      res.json(finalResult.data);

      this.logEvent('api-v2', 'chat_completions_success', {
        requestId,
        duration: Date.now() - startTime,
        model: response.model,
        hooksExecuted: this.hooksEnabled
      });

    } catch (error) {
      await this.handleError(error as Error, 'chat_completions_v2');

      res.status(500).json({
        error: {
          message: 'Internal Server Error',
          type: 'internal_error',
          code: 'internal_error'
        }
      });
    }
  }

  /**
   * 处理模型列表 (V1兼容)
   */
  private async handleModels(req: Request, res: Response): Promise<void> {
    try {
      this.logEvent('api-v2', 'models_request', {});

      // 从配置中获取模型列表
      const models = [];
      for (const [providerId, providerConfig] of Object.entries(this.config.providers)) {
        if (providerConfig.enabled && providerConfig.models) {
          for (const [modelId] of Object.keys(providerConfig.models)) {
            models.push({
              id: modelId,
              object: 'model',
              created: Math.floor(Date.now() / 1000),
              owned_by: providerId,
            });
          }
        }
      }

      res.json({
        object: 'list',
        data: models,
      });
    } catch (error) {
      await this.handleError(error as Error, 'models_handler_v2');
      throw error;
    }
  }

  /**
   * 设置错误处理
   */
  private setupErrorHandling(): void {
    this.app.use((error: UnknownObject, req: Request, res: Response) => {
      this.handleError(error as unknown as Error, 'request_handler').catch(() => {
        // 忽略处理器错误，直接发送响应
      });

      const errorStatus = (error as any).status || 500;
      res.status(errorStatus).json({
        error: {
          message: (error as any).message || 'Internal Server Error',
          type: (error as any).type || 'internal_error',
          code: (error as any).code || 'internal_error',
        },
      });
    });
  }

  /**
   * 设置调试日志
   */
  private setupDebugLogging(): void {
    this.debugEventBus.subscribe('*', (event: UnknownObject) => {
      if (this.config.logging.level === 'debug') {
        const timestamp = new Date(event.timestamp as any).toISOString();
        const eventData = event.data as Record<string, unknown>;
        const category = (eventData?.category as string) || 'general';
        const action = (eventData?.action as string) || 'unknown';

        const logMessage = `[${timestamp}] [DEBUG-V2] ${event.operationId}: ${JSON.stringify(
          {
            category,
            action,
            moduleId: event.moduleId,
            data: event.data,
          },
          null,
          2
        )}\n`;

        console.log(`[DEBUG-V2] ${event.operationId}:`, {
          category,
          action,
          timestamp,
          moduleId: event.moduleId,
          data: event.data,
        });
      }
    });
  }

  /**
   * 记录事件到调试中心
   */
  private logEvent(category: string, action: string, data: UnknownObject): void {
    try {
      this.debugEventBus.publish({
        sessionId: `session_v2_${Date.now()}`,
        moduleId: this.getModuleInfo().id,
        operationId: `${category}_${action}_v2`,
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          category,
          action,
          version: 'v2',
          ...data,
        },
      });
    } catch (error) {
      console.error('[RouteCodexServerV2] Failed to log event:', error);
    }
  }

  /**
   * 处理错误
   */
  private async handleError(error: Error, context: string): Promise<void> {
    try {
      await this.errorHandling.handleError({
        error: error.message,
        source: `${this.getModuleInfo().id}.${context}`,
        severity: 'medium',
        timestamp: Date.now(),
        moduleId: this.getModuleInfo().id,
        context: {
          stack: error.stack,
          name: error.name,
          version: 'v2'
        },
      });
    } catch (handlerError) {
      console.error('[RouteCodexServerV2] Failed to handle error:', handlerError);
      console.error('[RouteCodexServerV2] Original error:', error);
    }
  }

  /**
   * 初始化Hook集成系统 (暂时禁用)
   */
  private initializeHookIntegration(): void {
    console.log('[RouteCodexServerV2] Initializing Hook Integration system...');
    if (typeof ServerV2HookIntegration !== 'function') {
      throw new Error('ServerV2HookIntegration is not available. 请检查编译产物 dist/server-v2/hooks/server-v2-hook-integration.js 是否存在');
    }
    this.hookIntegration = new ServerV2HookIntegration({
      enabled: true,
      snapshot: {
        enabled: true,
        level: 'normal',
        phases: ['server-entry', 'server-pre-process', 'server-post-process', 'server-response', 'server-final']
      },
      hooks: {
        enabled: true,
        timeout: 5000,
        parallel: false,
        retryAttempts: 2
      }
    });

    this.hookIntegration.registerHook(new ServerRequestLoggingHook());
    this.hookIntegration.registerHook(new ServerResponseEnhancementHook());
    this.hookIntegration.registerHook(new ServerPerformanceMonitoringHook());

    console.log('[RouteCodexServerV2] Hook Integration initialized with 3 hooks');
  }

  
  /**
   * 获取Pipeline Manager（按照V1方式）
   */
  protected getPipelineManager(): any {
    try {
      // 按照V1方式从ServiceContainer获取PipelineManager
      const resolved = (this as any).serviceContainer?.tryResolve('PipelineManager');
      if (resolved) {
        console.log('[RouteCodexServerV2] Found Pipeline Manager via ServiceContainer');
        return resolved;
      }

      // 尝试从全局变量获取
      if ((globalThis as any).pipelineManager) {
        console.log('[RouteCodexServerV2] Found Pipeline Manager in global scope');
        return (globalThis as any).pipelineManager;
      }

      console.warn('[RouteCodexServerV2] Pipeline Manager not found');
      return null;

    } catch (error) {
      console.error('[RouteCodexServerV2] Error getting Pipeline Manager:', error);
      return null;
    }
  }

  /**
   * 创建Hook上下文
   */
  private createHookContext(requestId: string, endpoint: string, originalRequest?: UnknownObject): ServerV2HookContext {
    return {
      executionId: `exec_${requestId}_${Date.now()}`,
      stage: UnifiedHookStage.PIPELINE_PREPROCESSING,
      startTime: Date.now(),
      requestId,
      moduleId: 'routecodex-server-v2',
      serverVersion: 'v2',
      endpoint,
      originalRequest,
      metadata: {
        startTime: Date.now()
      }
    };
  }

  /**
   * 执行Hook并记录快照
   */
  private async executeHooksWithSnapshot(
    phase: 'server-entry' | 'server-pre-process' | 'server-post-process' | 'server-response' | 'server-final',
    data: UnknownObject,
    context: ServerV2HookContext
  ): Promise<{ data: UnknownObject; executionTime: number }> {
    if (!this.hookIntegration) {
      return { data, executionTime: 0 };
    }

    try {
      const result = await this.hookIntegration.executeHooksWithSnapshot(phase, data, context);
      return {
        data: result.data,
        executionTime: result.executionTime
      };
    } catch (error) {
      console.error(`[RouteCodexServerV2] Hook execution failed for phase ${phase}:`, error);
      return { data, executionTime: 0 };
    }
  }

  /**
   * 生成请求ID
   */
  private generateRequestId(): string {
    return `req-v2-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 获取模块信息
   */
  public getModuleInfo(): ModuleInfo {
    return {
      id: 'routecodex-server-v2',
      name: 'RouteCodexServerV2',
      version: '2.0.0',
      description: 'RouteCodex Server V2 with enhanced hooks and middleware',
      type: 'server',
    };
  }

  // --- V1 parity helpers and attach methods ---
  public async initializeWithMergedConfig(mergedConfig: any): Promise<void> {
    // align snapshots toggle like V1
    try {
      const snapsCfg = (mergedConfig as any)?.snapshots
        || (mergedConfig as any)?.modules?.httpserver?.config?.snapshots
        || (mergedConfig as any)?.debug?.snapshots
        || {};
      const env = String(process.env.ROUTECODEX_SNAPSHOTS || process.env.RCC_SNAPSHOTS || '').trim().toLowerCase();
      const enabled = snapsCfg?.enabled === true || env === '1' || env === 'true' || env === 'yes';
      try { (globalThis as any).rccSnapshotsEnabled = enabled; } catch { /* ignore */ }
    } catch { /* ignore */ }
  }

  public attachPipelineManager(manager: unknown): void {
    (globalThis as any).pipelineManager = manager;
    this.pipelineManager = manager;
  }

  public attachRoutePools(routePools: Record<string, string[]>): void {
    (globalThis as any).routePools = routePools;
    this.routePools = routePools || {};
    this.ensureVirtualRouter();
    try {
      const mgr: any = this.pipelineManager as any;
      if (mgr && typeof mgr.attachRoutePools === 'function') {
        mgr.attachRoutePools(this.routePools);
      }
    } catch { /* ignore */ }
  }

  public attachRouteMeta(routeMeta: Record<string, { providerId: string; modelId: string; keyId: string }>): void {
    (globalThis as any).routeMeta = routeMeta;
    this.routeMeta = routeMeta || ({} as any);
  }

  public attachRoutingClassifierConfig(config: unknown): void {
    (globalThis as any).routingClassifierConfig = config;
    this.classifierConfig = config;
    this.ensureVirtualRouter();
  }

  private buildHandlerContext(): HandlerContext {
    return {
      pipelineManager: this.pipelineManager,
      routePools: this.routePools,
      selectPipelineId: async (payload: any, entryEndpoint: string) => {
        const pid = await this.pickPipelineIdViaVirtualRouter(payload as any, entryEndpoint);
        if (pid) return pid;
        const fb = this.pickPipelineId();
        if (!fb) { throw new Error('No pipeline available'); }
        return fb;
      },
    } as HandlerContext;
  }

  private async pickPipelineIdViaVirtualRouter(payload: UnknownObject, entryEndpoint: string): Promise<string | null> {
    try {
      if (!this.virtualRouter) return null;
      try { (payload as any).endpoint = entryEndpoint; } catch { /* ignore */ }
      const routed = await this.virtualRouter.routeRequest(payload, 'default');
      const pid = (routed && (routed as any).routing && (routed as any).routing.pipelineId) ? String((routed as any).routing.pipelineId) : null;
      return pid;
    } catch { return null; }
  }

  private ensureVirtualRouter(): void {
    try {
      if (!this.classifierConfig || !this.routePools || Object.keys(this.routePools).length === 0) { return; }
      if (!this.virtualRouter) {
        try { const mod = require('../../modules/virtual-router/virtual-router-module.js'); this.virtualRouter = new mod.VirtualRouterModule(); } catch { this.virtualRouter = null; }
      }
      if (this.virtualRouter && typeof this.virtualRouter.initialize === 'function') {
        this.virtualRouter.initialize({ classificationConfig: this.classifierConfig, routePools: this.routePools }).catch(()=>{});
      }
    } catch { /* ignore */ }
  }

  private pickPipelineId(): string | null {
    try {
      const pools = this.routePools || {};
      const poolNames = Object.keys(pools);
      if (poolNames.length === 0) return null;
      const routeName = pools['default'] ? 'default' : poolNames[0];
      const targets = pools[routeName] || [];
      if (!Array.isArray(targets) || targets.length === 0) return null;
      const idx = this.rrIndex.get(routeName) ?? 0;
      const pick = targets[idx % targets.length];
      this.rrIndex.set(routeName, (idx + 1) % Math.max(1, targets.length));
      return typeof pick === 'string' ? pick : null;
    } catch { return null; }
  }
}
// @ts-nocheck
