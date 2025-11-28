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

import express, { type Application } from 'express';
import { ErrorHandlingCenter } from '../../../modules/errorhandling/error-handling-center-shim.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { HandlerContext, PipelineExecutionInput, PipelineExecutionResult } from '../../handlers/types.js';
import { ProviderFactory } from '../../../modules/pipeline/modules/provider/v2/core/provider-factory.js';
import type { ModuleDependencies, PipelineDebugLogger } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { DebugCenter } from '../../../modules/pipeline/types/external-types.js';
import { attachProviderRuntimeMetadata } from '../../../modules/pipeline/modules/provider/v2/core/provider-runtime-metadata.js';
import { AuthFileResolver } from '../../../config/auth-file-resolver.js';
import type { ProviderRuntimeProfile } from '../../../modules/pipeline/modules/provider/v2/api/provider-types.js';
import { emitProviderError } from '../../../modules/pipeline/modules/provider/v2/utils/provider-error-reporter.js';
import { isStageLoggingEnabled, logPipelineStage } from '../../utils/stage-logger.js';
import { registerDefaultMiddleware } from './middleware.js';
import { registerHttpRoutes } from './routes.js';
import { mapProviderProtocol, normalizeProviderType, asRecord } from './provider-utils.js';
import { resolveRepoRoot, loadLlmswitchModule } from './llmswitch-loader.js';
import type { ProviderHandle, ProviderProtocol, RequestContextV2, ServerConfigV2, ServerStatusV2, SuperPipeline, SuperPipelineCtor, VirtualRouterArtifacts } from './types.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - llmswitch-core dist does not ship ambient types
import { ProviderResponseConverter, type ProviderResponseType } from '../../../../sharedmodule/llmswitch-core/dist/v2/conversion/conversion-v3/response/provider-response-converter.js';

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
  private responseConverter = new ProviderResponseConverter();
  private authResolver = new AuthFileResolver();
  private userConfig: UnknownObject = {};
  private moduleDependencies: ModuleDependencies | null = null;
  private superPipelineCtor: SuperPipelineCtor | null = null;
  private readonly stageLoggingEnabled: boolean;
  private readonly repoRoot: string;

  constructor(config: ServerConfigV2) {
    this.config = config;
    this.app = express();
    this.errorHandling = new ErrorHandlingCenter();
    this.stageLoggingEnabled = isStageLoggingEnabled();
    this.repoRoot = resolveRepoRoot(import.meta.url);

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

  private async ensureSuperPipelineCtor(): Promise<SuperPipelineCtor> {
    if (this.superPipelineCtor) {
      return this.superPipelineCtor;
    }
    const mod = await loadLlmswitchModule<any>(this.repoRoot, 'v2/conversion/conversion-v3/pipelines/super-pipeline.js');
    if (!mod?.SuperPipeline) {
      throw new Error('Unable to load SuperPipeline implementation from llmswitch-core');
    }
    this.superPipelineCtor = mod.SuperPipeline as SuperPipelineCtor;
    return this.superPipelineCtor;
  }

  private async bootstrapVirtualRouter(input: UnknownObject): Promise<VirtualRouterArtifacts> {
    const mod = await loadLlmswitchModule<any>(this.repoRoot, 'v2/router/virtual-router/bootstrap.js');
    const fn = mod?.bootstrapVirtualRouterConfig;
    if (typeof fn !== 'function') {
      throw new Error('llmswitch-core missing bootstrapVirtualRouterConfig');
    }
    return fn(input) as VirtualRouterArtifacts;
  }

  /**
   * 初始化服务器
   */
  public async initialize(): Promise<void> {
    try {
      console.log('[RouteCodexHttpServer] Starting initialization...');

      // 初始化错误处理
      await this.errorHandling.initialize();

      registerDefaultMiddleware(this.app);
      registerHttpRoutes({
        app: this.app,
        config: this.config,
        buildHandlerContext: () => this.buildHandlerContext(),
        getSuperPipelineReady: () => Boolean(this.superPipeline),
        handleError: (error, context) => this.handleError(error, context)
      });

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
    this.userConfig = asRecord(userConfig);
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
    const providerType = normalizeProviderType(runtime.providerType);
    const instance = ProviderFactory.createProviderFromRuntime(runtime, this.getModuleDependencies());
    await instance.initialize();
    const providerId = runtime.providerId || runtimeKey.split('.')[0];
    return {
      runtimeKey,
      providerId,
      providerType,
      providerProtocol: mapProviderProtocol(providerType),
      runtime,
      instance
    };
  }

  private async materializeRuntimeProfile(runtime: ProviderRuntimeProfile): Promise<ProviderRuntimeProfile> {
    const auth = await this.resolveRuntimeAuth(runtime);
    const baseUrl = this.normalizeRuntimeBaseUrl(runtime);
    const providerType = normalizeProviderType(runtime.providerType);
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
    const originalRequestSnapshot = this.cloneRequestPayload(input.body);
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
      const normalized = this.normalizeProviderResponse(providerResponse);
      return await this.convertProviderResponseIfNeeded({
        entryEndpoint: input.entryEndpoint,
        providerType: handle.providerType,
        requestId: input.requestId,
        wantsStream: Boolean(input.metadata?.inboundStream ?? input.metadata?.stream),
        originalRequest: originalRequestSnapshot,
        response: normalized
      });
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
    const userMeta = asRecord(input.metadata);
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

  private async convertProviderResponseIfNeeded(options: {
    entryEndpoint?: string;
    providerType?: string;
    requestId: string;
    wantsStream: boolean;
    originalRequest?: Record<string, unknown> | undefined;
    response: PipelineExecutionResult;
  }): Promise<PipelineExecutionResult> {
    const entry = options.entryEndpoint || '';
    if (!entry.includes('/v1/messages')) {
      return options.response;
    }
    const body = options.response.body;
    if (!body || typeof body !== 'object') {
      return options.response;
    }
    try {
      const converted = await this.responseConverter.convert({
        entryEndpoint: entry,
        providerType: (normalizeProviderType(options.providerType) as ProviderResponseType) ?? 'openai',
        providerResponse: body as Record<string, unknown>,
        requestId: options.requestId,
        wantsStream: options.wantsStream,
        originalRequest: options.originalRequest
      });
      return {
        ...options.response,
        body: converted
      };
    } catch (error) {
      console.error('[RouteCodexHttpServer] Failed to convert provider response via llmswitch-core', error);
      return options.response;
    }
  }

  private cloneRequestPayload(payload: unknown): Record<string, unknown> | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    try {
      return JSON.parse(JSON.stringify(payload));
    } catch {
      return undefined;
    }
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
