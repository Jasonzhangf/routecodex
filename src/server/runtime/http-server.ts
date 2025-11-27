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
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { ErrorHandlingCenter } from '../../modules/errorhandling/error-handling-center-shim.js';
import type { UnknownObject } from '../../types/common-types.js';
import { handleChatCompletions } from '../../server/handlers/chat-handler.js';
import { handleMessages } from '../../server/handlers/messages-handler.js';
import { handleResponses } from '../../server/handlers/responses-handler.js';
import type { HandlerContext, PipelineExecutionInput, PipelineExecutionResult } from '../../server/handlers/types.js';
import { ProviderFactory } from '../../modules/pipeline/modules/provider/v2/core/provider-factory.js';
import type { ModuleDependencies, PipelineDebugLogger } from '../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { DebugCenter } from '../../modules/pipeline/types/external-types.js';
import { attachProviderRuntimeMetadata } from '../../modules/pipeline/modules/provider/v2/core/provider-runtime-metadata.js';
import { AuthFileResolver } from '../../config/auth-file-resolver.js';
import type { IProviderV2, ProviderRuntimeProfile } from '../../modules/pipeline/modules/provider/v2/api/provider-types.js';
import { emitProviderError } from '../../modules/pipeline/modules/provider/v2/utils/provider-error-reporter.js';
import { isStageLoggingEnabled, logPipelineStage } from '../../server/utils/stage-logger.js';
type SuperPipelineCtor = new (config: { virtualRouter: unknown }) => {
  execute(request: PipelineExecutionInput & { payload: unknown }): Promise<PipelineExecutionResult & {
    providerPayload?: Record<string, unknown>;
    target?: { providerKey: string; runtimeKey?: string; providerType: string; outboundProfile: string; compatibilityProfile?: string; defaultModel?: string; };
    routingDecision?: { routeName?: string };
  }>;
  updateVirtualRouterConfig(config: unknown): void;
  getProviderRuntimeMap(): Record<string, ProviderRuntimeProfile>;
};

interface VirtualRouterArtifacts {
  config: unknown;
  targetRuntime?: Record<string, ProviderRuntimeProfile>;
}

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

type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat';

interface ProviderHandle {
  runtimeKey: string;
  providerId: string;
  providerType: string;
  providerProtocol: ProviderProtocol;
  runtime: ProviderRuntimeProfile;
  instance: IProviderV2;
}

/**
 * RouteCodex Server V2
 *
 * 与V1完全并行实现，集成系统hooks
 */
export class RouteCodexHttpServer {
  private app: Application;
  private server?: unknown;
  private config: ServerConfigV2;
  private errorHandling: ErrorHandlingCenter;
  private _isInitialized: boolean = false;
  private _isRunning: boolean = false;

  // Runtime state
  private superPipeline: SuperPipeline | null = null;
  private providerHandles: Map<string, ProviderHandle> = new Map();
  private providerKeyToRuntimeKey: Map<string, string> = new Map();
  private pipelineLogger: PipelineDebugLogger = createNoopPipelineLogger();
  private authResolver = new AuthFileResolver();
  private userConfig: UnknownObject = {};
  private moduleDependencies: ModuleDependencies | null = null;
  private superPipelineCtor: SuperPipelineCtor | null = null;
  private readonly stageLoggingEnabled: boolean;

  constructor(config: ServerConfigV2) {
    this.config = config;
    this.app = express();
    this.errorHandling = new ErrorHandlingCenter();
    this.stageLoggingEnabled = isStageLoggingEnabled();

    console.log('[RouteCodexHttpServer] Initialized');
  }

  private resolveVirtualRouterInput(userConfig: UnknownObject): UnknownObject {
    if (userConfig?.virtualrouter && typeof userConfig.virtualrouter === 'object') {
      return userConfig.virtualrouter as UnknownObject;
    }
    return userConfig;
  }

  private getModuleDependencies(): ModuleDependencies {
    if (!this.moduleDependencies) {
      this.moduleDependencies = {
        errorHandlingCenter: this.errorHandling as any,
        debugCenter: this.createDebugCenterShim(),
        logger: this.pipelineLogger
      };
    }
    return this.moduleDependencies;
  }

  private createDebugCenterShim(): DebugCenter {
    return {
      logDebug: () => {},
      logError: () => {},
      logModule: () => {},
      processDebugEvent: () => {},
      getLogs: () => []
    };
  }

  private logStage(stage: string, requestId: string, details?: Record<string, unknown>): void {
    if (!this.stageLoggingEnabled) {
      return;
    }
    logPipelineStage(stage, requestId, details);
  }

  private mapProviderModule(providerType: string): string {
    switch (this.normalizeProviderType(providerType)) {
      case 'responses':
        return 'responses-http-provider';
      case 'anthropic':
        return 'anthropic-http-provider';
      case 'gemini':
        return 'gemini-http-provider';
      default:
        return 'openai-http-provider';
    }
  }

  private normalizeProviderType(input?: string): string {
    const value = (input || '').toLowerCase();
    if (value.includes('anthropic') || value.includes('claude')) return 'anthropic';
    if (value.includes('responses')) return 'responses';
    if (value.includes('gemini')) return 'gemini';
    return 'openai';
  }

  private mapProviderProtocol(providerType?: string): ProviderProtocol {
    const normalized = this.normalizeProviderType(providerType);
    switch (normalized) {
      case 'responses':
        return 'openai-responses';
      case 'anthropic':
        return 'anthropic-messages';
      case 'gemini':
        return 'gemini-chat';
      default:
        return 'openai-chat';
    }
  }

  private defaultEndpointForProvider(providerType?: string): string {
    switch (this.normalizeProviderType(providerType)) {
      case 'responses':
        return '/v1/responses';
      case 'anthropic':
        return '/v1/messages';
      case 'gemini':
        return '/v1beta/models';
      default:
        return '/v1/chat/completions';
    }
  }

  private normalizeAuthType(input: unknown): 'apikey' | 'oauth' {
    const value = typeof input === 'string' ? input.toLowerCase() : '';
    if (value === 'oauth' || value === 'iflow-oauth' || value === 'qwen-oauth') {
      return 'oauth';
    }
    return 'apikey';
  }

  private async resolveSecretValue(raw?: string): Promise<string> {
    if (!raw) {
      throw new Error('Secret reference is required but missing');
    }
    const trimmed = raw.trim();
    const envMatch = trimmed.match(/^\$\{([A-Z0-9_]+)\}$/i);
    if (envMatch) {
      const envValue = process.env[envMatch[1]];
      if (!envValue) {
        throw new Error(`Environment variable ${envMatch[1]} is not defined`);
      }
      return envValue;
    }
    if (/^[A-Z][A-Z0-9_]+$/.test(trimmed)) {
      const envValue = process.env[trimmed];
      if (!envValue) {
        throw new Error(`Environment variable ${trimmed} is not defined`);
      }
      return envValue;
    }
    if (trimmed.startsWith('authfile-')) {
      return await this.authResolver.resolveKey(trimmed);
    }
    return trimmed;
  }

  private extractFirstString(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      const candidate = value.find((item) => typeof item === 'string' && item.trim());
      return typeof candidate === 'string' ? candidate.trim() : undefined;
    }
    return undefined;
  }

  private asRecord<T = UnknownObject>(value: unknown): T {
    return value && typeof value === 'object' ? (value as T) : ({} as T);
  }

  private async ensureSuperPipelineCtor(): Promise<SuperPipelineCtor> {
    if (this.superPipelineCtor) {
      return this.superPipelineCtor;
    }
    const mod = await this.importLlmswitchModule<any>('v2/conversion/conversion-v3/pipelines/super-pipeline.js');
    if (!mod?.SuperPipeline) {
      throw new Error('Unable to load SuperPipeline implementation from llmswitch-core');
    }
    this.superPipelineCtor = mod.SuperPipeline as SuperPipelineCtor;
    return this.superPipelineCtor;
  }

  private async bootstrapVirtualRouter(input: UnknownObject): Promise<VirtualRouterArtifacts> {
    const mod = await this.importLlmswitchModule<any>('v2/router/virtual-router/bootstrap.js');
    const fn = mod?.bootstrapVirtualRouterConfig;
    if (typeof fn !== 'function') {
      throw new Error('llmswitch-core missing bootstrapVirtualRouterConfig');
    }
    return fn(input) as VirtualRouterArtifacts;
  }

  private async importLlmswitchModule<T = any>(subpath: string): Promise<T> {
    const baseDir = this.resolveRepoRoot();
    const target = path.join(baseDir, 'sharedmodule', 'llmswitch-core', 'dist', subpath);
    const url = pathToFileURL(target).href;
    return (await import(url)) as T;
  }

  private resolveRepoRoot(): string {
    try {
      const current = fileURLToPath(import.meta.url);
      return path.resolve(path.dirname(current), '../../..');
    } catch {
      return process.cwd();
    }
  }

  /**
   * 初始化服务器
   */
  public async initialize(): Promise<void> {
    try {
      console.log('[RouteCodexHttpServer] Starting initialization...');

      // 初始化错误处理
      await this.errorHandling.initialize();

      // 设置中间件（保持空，实现 parity）
      await this.setupMiddleware();

      // 设置HTTP端点（完全对齐V1行为）
      await this.setupRoutes();

      this._isInitialized = true;

      console.log('[RouteCodexHttpServer] Initialization completed successfully');

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

        console.log(`[RouteCodexHttpServer] Server started on ${this.config.server.host}:${this.config.server.port}`);
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

          try {
            await this.disposeProviders();
          } catch { /* ignore */ }
          this.superPipeline = null;
          await this.errorHandling.destroy();

          console.log('[RouteCodexHttpServer] Server stopped');
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
      version: 'v2'
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
      console.log('[RouteCodexHttpServer] Middleware: express.json enabled');
    } catch {
      console.warn('[RouteCodexHttpServer] Failed to enable express.json; request bodies may be empty');
    }
  }

  /**
   * 设置路由
   */
  private async setupRoutes(): Promise<void> {
    console.log('[RouteCodexHttpServer] Setting up routes...');

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

    // Debug runtime
    this.app.get('/debug/runtime', (_req: Request, res: Response) => {
      try {
        res.status(200).json({ superPipelineReady: !!this.superPipeline });
      } catch (e: any) {
        res.status(500).json({ error: { message: e?.message || String(e) } });
      }
    });

    // Core API endpoints — HTTP 层仅负责协议转发，其余交给 SuperPipeline
    this.app.post('/v1/chat/completions', async (req, res) => {
      await handleChatCompletions(req, res, this.buildHandlerContext());
    });
    this.app.post('/v1/messages', async (req, res) => {
      await handleMessages(req, res, this.buildHandlerContext());
    });
    this.app.post('/v1/responses', async (req, res) => {
      await handleResponses(req, res, this.buildHandlerContext());
    });
    this.app.post('/v1/responses/:id/submit_tool_outputs', async (_req, res) => {
      res.status(501).json({ error: { message: 'submit_tool_outputs is not supported in virtual-router mode' } });
    });

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

    this.app.use((error: UnknownObject, _req: Request, res: Response) => {
      this.handleError(error as Error, 'request_handler').catch(() => undefined);
      const status = (error as any)?.status || 500;
      res.status(status).json({
        error: {
          message: (error as any)?.message || 'Internal Server Error',
          type: (error as any)?.type || 'internal_error',
          code: (error as any)?.code || 'internal_error'
        }
      });
    });

    console.log('[RouteCodexHttpServer] Routes setup completed');
  }

  /**
   * 处理错误
   */
  private async handleError(error: Error, context: string): Promise<void> {
    try {
      await this.errorHandling.handleError({
        error: error.message,
        source: `routecodex-server-v2.${context}`,
        severity: 'medium',
        timestamp: Date.now(),
        moduleId: 'routecodex-server-v2',
        context: {
          stack: error.stack,
          name: error.name,
          version: 'v2'
        },
      });
    } catch (handlerError) {
      console.error('[RouteCodexHttpServer] Failed to handle error:', handlerError);
      console.error('[RouteCodexHttpServer] Original error:', error);
    }
  }

  // --- V1 parity helpers and attach methods ---
  public async initializeWithUserConfig(userConfig: any): Promise<void> {
    await this.setupRuntime(userConfig);
  }

  public async reloadRuntime(userConfig: any): Promise<void> {
    await this.setupRuntime(userConfig);
  }

  private async setupRuntime(userConfig: any): Promise<void> {
    this.userConfig = this.asRecord(userConfig);
    const routerInput = this.resolveVirtualRouterInput(this.userConfig);
    const bootstrapArtifacts = await this.bootstrapVirtualRouter(routerInput);
    const superPipelineCtor = await this.ensureSuperPipelineCtor();
    if (!this.superPipeline) {
      this.superPipeline = new superPipelineCtor({ virtualRouter: bootstrapArtifacts });
    } else {
      this.superPipeline.updateVirtualRouterConfig(bootstrapArtifacts);
    }
    await this.initializeProviderRuntimes();
  }

  private buildHandlerContext(): HandlerContext {
    return {
      executePipeline: this.executePipeline.bind(this),
      errorHandling: this.errorHandling
    };
  }

  private async initializeProviderRuntimes(): Promise<void> {
    if (!this.superPipeline) return;
    const runtimeMap = this.superPipeline.getProviderRuntimeMap();
    await this.disposeProviders();
    this.providerKeyToRuntimeKey.clear();

    for (const [providerKey, runtime] of Object.entries(runtimeMap)) {
      if (!runtime) continue;
      const runtimeKey = runtime.runtimeKey || providerKey;
      if (!this.providerHandles.has(runtimeKey)) {
        const resolvedRuntime = await this.materializeRuntimeProfile(runtime);
        const handle = await this.createProviderHandle(runtimeKey, resolvedRuntime);
        this.providerHandles.set(runtimeKey, handle);
      }
      this.providerKeyToRuntimeKey.set(providerKey, runtimeKey);
    }
  }

  private async createProviderHandle(
    runtimeKey: string,
    runtime: ProviderRuntimeProfile
  ): Promise<ProviderHandle> {
    const providerType = this.normalizeProviderType(runtime.providerType);
    const instance = ProviderFactory.createProviderFromRuntime(runtime, this.getModuleDependencies());
    await instance.initialize();
    const providerId = runtime.providerId || runtimeKey.split('.')[0];
    return {
      runtimeKey,
      providerId,
      providerType,
      providerProtocol: this.mapProviderProtocol(providerType),
      runtime,
      instance
    };
  }

  private async materializeRuntimeProfile(runtime: ProviderRuntimeProfile): Promise<ProviderRuntimeProfile> {
    const auth = await this.resolveRuntimeAuth(runtime);
    const baseUrl = this.normalizeRuntimeBaseUrl(runtime);
    const providerType = this.normalizeProviderType(runtime.providerType);
    return {
      ...runtime,
      ...(baseUrl ? { baseUrl } : {}),
      providerType,
      auth
    };
  }

  private normalizeRuntimeBaseUrl(runtime: ProviderRuntimeProfile): string | undefined {
    const candidates = [runtime.baseUrl, runtime.endpoint];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }
    return undefined;
  }

  private async resolveRuntimeAuth(runtime: ProviderRuntimeProfile): Promise<ProviderRuntimeProfile['auth']> {
    const auth = runtime.auth || { type: 'apikey' };
    const authType = this.normalizeAuthType(auth.type);

    if (authType === 'apikey') {
      const value = await this.resolveApiKeyValue(runtime, auth);
      return { ...auth, type: 'apikey', value };
    }

    const clientId = auth.clientId || auth.client_id;
    const tokenUrl = auth.tokenUrl || auth.token_url;
    if (!clientId || !tokenUrl) {
      throw new Error(`Provider runtime "${runtime.runtimeKey || runtime.providerId}" missing OAuth client configuration`);
    }
    const tokenFile =
      (typeof auth.tokenFile === 'string' && auth.tokenFile.trim())
        ? auth.tokenFile.trim()
        : auth.secretRef
          ? await this.resolveSecretValue(auth.secretRef)
          : undefined;

    return {
      ...auth,
      type: 'oauth',
      clientId,
      tokenUrl,
      tokenFile
    };
  }

  private async resolveApiKeyValue(runtime: ProviderRuntimeProfile, auth: ProviderRuntimeProfile['auth']): Promise<string> {
    const inline = typeof auth?.value === 'string' ? auth.value.trim() : '';
    if (inline) {
      return inline;
    }

    const resolved =
      typeof auth?.secretRef === 'string' && auth.secretRef.trim()
        ? await this.resolveSecretValue(auth.secretRef.trim())
        : undefined;
    if (resolved) {
      return resolved;
    }

    throw new Error(`Provider runtime "${runtime.runtimeKey || runtime.providerId}" missing API key`);
  }

  private async disposeProviders(): Promise<void> {
    const handles = Array.from(this.providerHandles.values());
    await Promise.all(
      handles.map(async (handle) => {
        try {
          await handle.instance.cleanup();
        } catch {
          // ignore cleanup errors
        }
      })
    );
    this.providerHandles.clear();
  }

  private async executePipeline(input: PipelineExecutionInput): Promise<PipelineExecutionResult> {
    if (!this.superPipeline) {
      throw new Error('Super pipeline runtime is not initialized');
    }
    this.logStage('request.received', input.requestId, {
      endpoint: input.entryEndpoint,
      stream: input.metadata?.stream === true
    });
    const metadata = this.buildRequestMetadata(input);
    this.logStage('super.start', input.requestId, { endpoint: input.entryEndpoint, stream: metadata.stream });
    const result = await this.superPipeline.execute({
      endpoint: input.entryEndpoint,
      id: input.requestId,
      payload: input.body,
      metadata
    });
    this.logStage('super.completed', input.requestId, {
      route: result.routingDecision?.routeName,
      target: result.target?.providerKey
    });

    const providerPayload = result.providerPayload;
    const target = result.target;
    if (!providerPayload || !target?.providerKey) {
      throw Object.assign(new Error('Virtual router did not produce a provider target'), {
        code: 'ERR_NO_PROVIDER_TARGET',
        requestId: input.requestId
      });
    }

    const runtimeKey = target.runtimeKey || this.providerKeyToRuntimeKey.get(target.providerKey);
    if (!runtimeKey) {
      throw Object.assign(new Error(`Runtime for provider ${target.providerKey} not initialized`), {
        code: 'ERR_RUNTIME_NOT_FOUND',
        requestId: input.requestId
      });
    }

    const handle = this.providerHandles.get(runtimeKey);
    if (!handle) {
      throw Object.assign(new Error(`Provider runtime ${runtimeKey} not found`), {
        code: 'ERR_PROVIDER_NOT_FOUND',
        requestId: input.requestId
      });
    }

    const providerProtocol =
      (target.outboundProfile as ProviderProtocol) ||
      handle.providerProtocol;

    (providerPayload as any).providerType = handle.providerType;

    this.logStage('provider.prepare', input.requestId, {
      providerKey: target.providerKey,
      runtimeKey,
      protocol: providerProtocol
    });

    attachProviderRuntimeMetadata(providerPayload, {
      requestId: input.requestId,
      providerId: handle.providerId,
      providerKey: target.providerKey,
      providerType: handle.providerType,
      providerProtocol,
      pipelineId: target.providerKey,
      routeName: result.routingDecision?.routeName,
      runtimeKey,
      target
    });

    this.logStage('provider.send.start', input.requestId, {
      providerKey: target.providerKey,
      runtimeKey,
      protocol: providerProtocol
    });

    try {
      const providerResponse = await handle.instance.processIncoming(providerPayload);
      const responseStatus = typeof (providerResponse as any)?.status === 'number'
        ? (providerResponse as any).status
        : undefined;
      this.logStage('provider.send.completed', input.requestId, {
        providerKey: target.providerKey,
        status: responseStatus
      });
      return this.normalizeProviderResponse(providerResponse);
    } catch (error) {
      this.logStage('provider.send.error', input.requestId, {
        providerKey: target.providerKey,
        message: error instanceof Error ? error.message : String(error ?? 'Unknown error')
      });
      emitProviderError({
        error,
        stage: 'provider.send',
        runtime: {
          requestId: input.requestId,
          providerKey: target.providerKey,
          providerId: handle.providerId,
          providerType: handle.providerType,
          providerProtocol,
          routeName: result.routingDecision?.routeName,
          pipelineId: target.providerKey,
          runtimeKey,
          target
        },
        dependencies: this.getModuleDependencies()
      });
      throw error;
    }
  }

  private buildRequestMetadata(input: PipelineExecutionInput): Record<string, unknown> {
    const userMeta = this.asRecord(input.metadata);
    const routeHint = this.extractRouteHint(input) ?? userMeta.routeHint;
    const processMode = (userMeta.processMode as string) || 'chat';
    return {
      ...userMeta,
      entryEndpoint: input.entryEndpoint,
      processMode,
      direction: 'request',
      stage: 'inbound',
      routeHint,
      stream: userMeta.stream === true
    };
  }

  private extractRouteHint(input: PipelineExecutionInput): string | undefined {
    const header = input.headers['x-route-hint'];
    if (typeof header === 'string' && header.trim()) {
      return header.trim();
    }
    if (Array.isArray(header) && header[0]) {
      return String(header[0]);
    }
    return undefined;
  }

  private normalizeProviderResponse(response: any): PipelineExecutionResult {
    const status = typeof response?.status === 'number' ? response.status : undefined;
    const headers = this.normalizeProviderResponseHeaders(response?.headers);
    const body = response?.data ?? response;
    return { status, headers, body };
  }

  private normalizeProviderResponseHeaders(headers: unknown): Record<string, string> | undefined {
    if (!headers || typeof headers !== 'object') return undefined;
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof value === 'string') {
        normalized[key.toLowerCase()] = value;
      }
    }
    return Object.keys(normalized).length ? normalized : undefined;
  }
}

function createNoopPipelineLogger(): PipelineDebugLogger {
  const noop = () => {};
  const emptyLogs = () => ({ general: [], transformations: [], provider: [] }) as any;
  const emptyList = () => [] as any;
  const emptyStats = () => ({
    totalLogs: 0,
    logsByLevel: {},
    logsByCategory: {},
    logsByPipeline: {},
    transformationCount: 0,
    providerRequestCount: 0
  });
  return {
    logModule: noop,
    logError: noop,
    logDebug: noop,
    logPipeline: noop,
    logRequest: noop,
    logResponse: noop,
    logTransformation: noop,
    logProviderRequest: noop,
    getRequestLogs: emptyLogs,
    getPipelineLogs: emptyLogs,
    getRecentLogs: emptyList,
    getTransformationLogs: emptyList,
    getProviderLogs: emptyList,
    getStatistics: emptyStats,
    clearLogs: noop,
    exportLogs: () => ([]),
    log: noop
  };
}
