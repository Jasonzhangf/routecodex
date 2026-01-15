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
import type { Server } from 'http';
import { ErrorHandlingCenter } from 'rcc-errorhandling';
import type { UnknownObject } from '../../../types/common-types.js';
import type { HandlerContext, PipelineExecutionInput, PipelineExecutionResult } from '../../handlers/types.js';
import { ProviderFactory } from '../../../providers/core/runtime/provider-factory.js';
import type { ModuleDependencies, PipelineDebugLogger } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import { PipelineDebugLogger as PipelineDebugLoggerImpl } from '../../../modules/pipeline/utils/debug-logger.js';
import type { DebugCenter } from '../../../modules/pipeline/types/external-types.js';
import type {
  DebugLogEntry,
  TransformationLogEntry,
  ProviderRequestLogEntry
} from '../../../modules/pipeline/utils/debug-logger.js';
import { attachProviderRuntimeMetadata } from '../../../providers/core/runtime/provider-runtime-metadata.js';
import { extractAnthropicToolAliasMap } from './anthropic-tool-alias.js';
import { AuthFileResolver } from '../../../config/auth-file-resolver.js';
import type { ProviderRuntimeProfile } from '../../../providers/core/api/provider-types.js';
import type { ProviderProfile, ProviderProfileCollection } from '../../../providers/profile/provider-profile.js';
import { buildProviderProfiles } from '../../../providers/profile/provider-profile-loader.js';
import { isStageLoggingEnabled, logPipelineStage } from '../../utils/stage-logger.js';
import { registerApiKeyAuthMiddleware, registerDefaultMiddleware } from './middleware.js';
import { registerHttpRoutes, registerOAuthPortalRoute } from './routes.js';
import { mapProviderProtocol, normalizeProviderType, resolveProviderIdentity, asRecord } from './provider-utils.js';
import { resolveRepoRoot } from './llmswitch-loader.js';
import { enhanceProviderRequestId } from '../../utils/request-id-manager.js';
import {
  convertProviderResponse as bridgeConvertProviderResponse,
  createSnapshotRecorder as bridgeCreateSnapshotRecorder,
  rebindResponsesConversationRequestId,
  bootstrapVirtualRouterConfig,
  getHubPipelineCtor
} from '../../../modules/llmswitch/bridge.js';
import {
  initializeRouteErrorHub,
  reportRouteError,
  type RouteErrorHub,
  type RouteErrorPayload
} from '../../../error-handling/route-error-hub.js';
import type {
  HubPipeline,
  HubPipelineCtor,
  ProviderHandle,
  ProviderProtocol,
  ServerConfigV2,
  ServerStatusV2,
  VirtualRouterArtifacts
} from './types.js';
import { writeClientSnapshot } from '../../../providers/core/utils/snapshot-writer.js';
import { createServerColoredLogger } from './colored-logger.js';
import { formatValueForConsole } from '../../../utils/logger.js';
import { QuietErrorHandlingCenter } from '../../../error-handling/quiet-error-handling-center.js';
import { hasVirtualRouterSeriesCooldown } from './executor-provider.js';
import { ManagerDaemon } from '../../../manager/index.js';
import { HealthManagerModule } from '../../../manager/modules/health/index.js';
import { RoutingStateManagerModule } from '../../../manager/modules/routing/index.js';
import { TokenManagerModule } from '../../../manager/modules/token/index.js';
import type { ProviderQuotaDaemonModule } from '../../../manager/modules/quota/index.js';
import { StatsManager, type UsageMetrics } from './stats-manager.js';
type LegacyAuthFields = ProviderRuntimeProfile['auth'] & {
  token_file?: unknown;
  token_url?: unknown;
  device_code_url?: unknown;
  client_id?: unknown;
  client_secret?: unknown;
  authorization_url?: unknown;
  authUrl?: unknown;
  user_info_url?: unknown;
  refresh_url?: unknown;
  scope?: unknown;
};

/**
 * RouteCodex Server V2
 *
 * 与V1完全并行实现，集成系统hooks
 */
export class RouteCodexHttpServer {
  private app: Application;
  private server?: Server;
  private config: ServerConfigV2;
  private errorHandling: ErrorHandlingCenter;
  private _isInitialized: boolean = false;
  private _isRunning: boolean = false;

  // Runtime state
  private hubPipeline: HubPipeline | null = null;
  private providerHandles: Map<string, ProviderHandle> = new Map();
  private providerKeyToRuntimeKey: Map<string, string> = new Map();
  private pipelineLogger: PipelineDebugLogger = createNoopPipelineLogger();
  private authResolver = new AuthFileResolver();
  private userConfig: UnknownObject = {};
  private moduleDependencies: ModuleDependencies | null = null;
  private hubPipelineCtor: HubPipelineCtor | null = null;
  private readonly stageLoggingEnabled: boolean;
  private readonly repoRoot: string;
  private currentRouterArtifacts: VirtualRouterArtifacts | null = null;
  private providerProfileIndex: Map<string, ProviderProfile> = new Map();
  private errorHandlingShim: ModuleDependencies['errorHandlingCenter'] | null = null;
  private routeErrorHub: RouteErrorHub | null = null;
  private readonly coloredLogger = createServerColoredLogger();
  private managerDaemon: ManagerDaemon | null = null;
  private readonly stats = new StatsManager();

  constructor(config: ServerConfigV2) {
    this.config = config;
    this.app = express();
    this.errorHandling = new QuietErrorHandlingCenter();
    this.stageLoggingEnabled = isStageLoggingEnabled();
    this.repoRoot = resolveRepoRoot(import.meta.url);
    const envFlag = (process.env.ROUTECODEX_USE_HUB_PIPELINE || '').trim().toLowerCase();
    if (config.pipeline?.useHubPipeline === false || envFlag === '0' || envFlag === 'false') {
      console.warn('[RouteCodexHttpServer] Super pipeline has been removed; falling back to Hub pipeline.');
    }

    try {
      this.pipelineLogger = new PipelineDebugLoggerImpl({ colored: this.coloredLogger }, { enableConsoleLogging: true });
    } catch (error) {
      console.warn('[RouteCodexHttpServer] Failed to initialize PipelineDebugLogger; falling back to noop logger.', error);
      this.pipelineLogger = createNoopPipelineLogger();
    }

    // Register critical routes early (before provider initialization)
    // This ensures OAuth Portal is available when providers check token validity
    registerApiKeyAuthMiddleware(this.app, this.config);
    registerDefaultMiddleware(this.app);
    registerOAuthPortalRoute(this.app);
    this.registerDaemonAdminUiRoute();
    console.log('[RouteCodexHttpServer] OAuth Portal route registered (early initialization)');

    console.log('[RouteCodexHttpServer] Initialized (pipeline=hub)');
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
        errorHandlingCenter: this.getErrorHandlingShim(),
        debugCenter: this.createDebugCenterShim(),
        logger: this.pipelineLogger
      };
    }
    return this.moduleDependencies!;
  }

  /**
   * Register Daemon Admin UI route.
   * Serves docs/daemon-admin-ui.html as a static page; localhost-only.
   */
  private registerDaemonAdminUiRoute(): void {
    this.app.get('/daemon/admin', async (req, res) => {
      try {
        const ip = req.socket?.remoteAddress || '';
        const allowed = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
        if (!allowed) {
          res.status(403).json({ error: { message: 'forbidden', code: 'forbidden' } });
          return;
        }
        const filePath = new URL('../../../../docs/daemon-admin-ui.html', import.meta.url);
        const fs = await import('node:fs/promises');
        const html = await fs.readFile(filePath, 'utf8');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({
          error: {
            message: `Daemon admin UI not available: ${message}`
          }
        });
      }
    });
  }

  private getErrorHandlingShim(): ModuleDependencies['errorHandlingCenter'] {
    if (!this.errorHandlingShim) {
      this.errorHandlingShim = {
        handleError: async (errorPayload, contextPayload) => {
          const sanitizedError = formatErrorForErrorCenter(errorPayload) as string | Error | Record<string, unknown>;
          const sanitizedContext = formatErrorForErrorCenter(contextPayload) as Record<string, unknown> | undefined;
          await this.errorHandling.handleError({
            error: sanitizedError,
            source: 'pipeline',
            severity: 'medium',
            timestamp: Date.now(),
            context: sanitizedContext
          });
        },
        createContext: () => ({}),
        getStatistics: () => ({})
      };
    }
    return this.errorHandlingShim;
  }

  private createDebugCenterShim(): DebugCenter {
    return {
      logDebug: () => { },
      logError: () => { },
      logModule: () => { },
      processDebugEvent: () => { },
      getLogs: () => []
    };
  }

  private updateProviderProfiles(collection?: ProviderProfileCollection, rawConfig?: UnknownObject): void {
    this.providerProfileIndex.clear();
    const source = collection ?? this.tryBuildProfiles(rawConfig);
    if (!source) { return; }
    for (const profile of source.profiles) {
      if (profile && typeof profile.id === 'string' && profile.id.trim()) {
        this.providerProfileIndex.set(profile.id.trim(), profile);
      }
    }
  }

  private ensureProviderProfilesFromUserConfig(): void {
    if (this.providerProfileIndex.size > 0) {
      return;
    }
    const fallback = this.tryBuildProfiles(this.userConfig);
    if (!fallback) { return; }
    for (const profile of fallback.profiles) {
      if (profile && typeof profile.id === 'string' && profile.id.trim()) {
        this.providerProfileIndex.set(profile.id.trim(), profile);
      }
    }
  }

  private tryBuildProfiles(config: UnknownObject | undefined): ProviderProfileCollection | null {
    if (!config) { return null; }
    try {
      return buildProviderProfiles(config);
    } catch {
      return null;
    }
  }

  private findProviderProfile(runtime: ProviderRuntimeProfile): ProviderProfile | undefined {
    const candidates = new Set<string>();
    const pushCandidate = (value?: string) => {
      if (typeof value === 'string' && value.trim()) {
        candidates.add(value.trim());
      }
    };
    pushCandidate(runtime.providerId);
    if (runtime.providerKey && runtime.providerKey.includes('.')) {
      pushCandidate(runtime.providerKey.split('.')[0]);
    }
    if (runtime.runtimeKey && runtime.runtimeKey.includes('.')) {
      pushCandidate(runtime.runtimeKey.split('.')[0]);
    }
    for (const candidate of candidates) {
      const profile = this.providerProfileIndex.get(candidate);
      if (profile) { return profile; }
    }
    return undefined;
  }

  private applyProviderProfileOverrides(runtime: ProviderRuntimeProfile): ProviderRuntimeProfile {
    const profile = this.findProviderProfile(runtime);
    if (!profile) {
      return this.canonicalizeRuntimeProvider(runtime);
    }
    const patched: ProviderRuntimeProfile = { ...runtime };
    const originalFamily = patched.providerFamily || patched.providerType;
    patched.providerFamily = originalFamily;
    patched.providerType = profile.protocol as ProviderRuntimeProfile['providerType'];
    if (profile.moduleType && profile.moduleType.trim()) {
      patched.providerModule = profile.moduleType.trim();
    }
    if (!patched.baseUrl && profile.transport.baseUrl) {
      patched.baseUrl = profile.transport.baseUrl;
    }
    if (!patched.endpoint && profile.transport.endpoint) {
      patched.endpoint = profile.transport.endpoint;
    }
    if (!patched.headers && profile.transport.headers) {
      patched.headers = profile.transport.headers;
    }
    if (!patched.compatibilityProfile && profile.compatibilityProfile) {
      patched.compatibilityProfile = profile.compatibilityProfile;
    }
    if (!patched.defaultModel && profile.metadata?.defaultModel) {
      patched.defaultModel = profile.metadata.defaultModel;
    }

    return this.canonicalizeRuntimeProvider(patched);
  }

  private canonicalizeRuntimeProvider(runtime: ProviderRuntimeProfile): ProviderRuntimeProfile {
    const { providerType, providerFamily } = resolveProviderIdentity(runtime.providerType, runtime.providerFamily);
    return {
      ...runtime,
      providerType: providerType as ProviderRuntimeProfile['providerType'],
      providerFamily
    };
  }

  private logStage(stage: string, requestId: string, details?: Record<string, unknown>): void {
    if (!this.stageLoggingEnabled) {
      return;
    }
    logPipelineStage(stage, requestId, details);
  }

  private extractProviderModel(payload?: Record<string, unknown>): string | undefined {
    if (!payload) {
      return undefined;
    }
    const source =
      payload.data && typeof payload.data === 'object'
        ? (payload.data as Record<string, unknown>)
        : payload;
    const raw = (source as Record<string, unknown>).model;
    if (typeof raw === 'string' && raw.trim()) {
      return raw.trim();
    }
    return undefined;
  }

  private buildProviderLabel(providerKey?: string, model?: string): string | undefined {
    const key = typeof providerKey === 'string' && providerKey.trim() ? providerKey.trim() : undefined;
    const modelId = typeof model === 'string' && model.trim() ? model.trim() : undefined;
    if (!key && !modelId) {
      return undefined;
    }
    if (key && modelId) {
      return `${key}.${modelId}`;
    }
    return key || modelId;
  }

  private normalizeAuthType(input: unknown): 'apikey' | 'oauth' {
    const value = typeof input === 'string' ? input.toLowerCase() : '';
    if (value.includes('oauth')) {
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

  private async bootstrapVirtualRouter(input: UnknownObject): Promise<VirtualRouterArtifacts> {
    const artifacts = (await bootstrapVirtualRouterConfig(
      input as Record<string, unknown>
    )) as unknown as VirtualRouterArtifacts;
    return artifacts;
  }

  private async ensureHubPipelineCtor(): Promise<HubPipelineCtor> {
    if (this.hubPipelineCtor) {
      return this.hubPipelineCtor;
    }
    const ctorFactory = await getHubPipelineCtor();
    this.hubPipelineCtor = ctorFactory as unknown as HubPipelineCtor;
    return this.hubPipelineCtor;
  }

  private isPipelineReady(): boolean {
    return Boolean(this.hubPipeline);
  }

  /**
   * 初始化服务器
   */
  public async initialize(): Promise<void> {
    try {
      console.log('[RouteCodexHttpServer] Starting initialization...');

      // 初始化错误处理
      await this.errorHandling.initialize();
      await this.initializeRouteErrorHub();
      // 初始化 ManagerDaemon 骨架（当前模块为占位实现，不改变行为）
      if (!this.managerDaemon) {
        const serverId = `${this.config.server.host}:${this.config.server.port}`;
        const daemon = new ManagerDaemon({ serverId });
        daemon.registerModule(new TokenManagerModule());
        daemon.registerModule(new RoutingStateManagerModule());
        daemon.registerModule(new HealthManagerModule());
        // Quota manager（当前仅用于 antigravity/gemini-cli 等需要配额信息的 Provider）
        try {
          const mod = (await import('../../../manager/modules/quota/index.js')) as {
            QuotaManagerModule?: new () => import('../../../manager/modules/quota/index.js').QuotaManagerModule;
            ProviderQuotaDaemonModule?: new () => import('../../../manager/modules/quota/index.js').ProviderQuotaDaemonModule;
          };
          if (typeof mod.QuotaManagerModule === 'function') {
            daemon.registerModule(new mod.QuotaManagerModule());
          }
          if (typeof mod.ProviderQuotaDaemonModule === 'function') {
            daemon.registerModule(new mod.ProviderQuotaDaemonModule());
          }
        } catch {
          // 可选模块，缺失时忽略
        }
        await daemon.start();
        this.managerDaemon = daemon;
      }

      // registerDefaultMiddleware and registerOAuthPortalRoute already called in constructor
      // Register remaining HTTP routes
      registerHttpRoutes({
        app: this.app,
        config: this.config,
        buildHandlerContext: () => this.buildHandlerContext(),
        getPipelineReady: () => this.isPipelineReady(),
        handleError: (error, context) => this.handleError(error, context),
        getHealthSnapshot: () => {
          const healthModule = this.managerDaemon?.getModule('health') as HealthManagerModule | undefined;
          return healthModule?.getCurrentSnapshot() ?? null;
        },
        getRoutingState: (sessionId: string) => {
          const routingModule = this.managerDaemon?.getModule('routing') as RoutingStateManagerModule | undefined;
          const store = routingModule?.getRoutingStateStore();
          if (!store) {
            return null;
          }
          const key = sessionId && sessionId.trim() ? `session:${sessionId.trim()}` : '';
          return key ? store.loadSync(key) : null;
        },
        getManagerDaemon: () => this.managerDaemon,
        getVirtualRouterArtifacts: () => this.currentRouterArtifacts,
        getServerId: () => `${this.config.server.host}:${this.config.server.port}`
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

      this.server.on('error', async (error: Error) => {
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
        this.server?.close(async () => {
          this._isRunning = false;

          try {
            await this.disposeProviders();
          } catch { /* ignore */ }
          try {
            if (this.managerDaemon) {
              await this.managerDaemon.stop();
              this.managerDaemon = null;
            }
          } catch {
            // ignore manager shutdown failures
          }
          await this.errorHandling.destroy();

          try {
            const uptimeMs = Math.round(process.uptime() * 1000);
            const snapshot = this.stats.logSummary(uptimeMs);
            await this.stats.persistSnapshot(snapshot, { reason: 'server_shutdown' });
            await this.stats.logHistoricalSummary();
          } catch {
            // stats logging must never block shutdown
          }

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
    const payload: RouteErrorPayload = {
      code: `SERVER_${context.toUpperCase()}`,
      message: error.message || 'RouteCodex server error',
      source: `routecodex-server-v2.${context}`,
      scope: 'server',
      severity: 'medium',
      details: {
        name: error.name,
        stack: error.stack,
        version: 'v2'
      },
      originalError: error
    };
    try {
      await reportRouteError(payload);
    } catch (handlerError) {
      console.error(
        '[RouteCodexHttpServer] Failed to report error via RouteErrorHub:',
        formatValueForConsole(handlerError)
      );
      console.error('[RouteCodexHttpServer] Original error:', formatValueForConsole(error));
    }
  }

  // --- V1 parity helpers and attach methods ---
  public async initializeWithUserConfig(
    userConfig: UnknownObject,
    context?: { providerProfiles?: ProviderProfileCollection }
  ): Promise<void> {
    this.updateProviderProfiles(context?.providerProfiles, userConfig);
    await this.setupRuntime(userConfig);
  }

  public async reloadRuntime(
    userConfig: UnknownObject,
    context?: { providerProfiles?: ProviderProfileCollection }
  ): Promise<void> {
    this.updateProviderProfiles(context?.providerProfiles, userConfig);
    await this.setupRuntime(userConfig);
  }

  private async setupRuntime(userConfig: UnknownObject): Promise<void> {
    this.userConfig = asRecord(userConfig);
    this.ensureProviderProfilesFromUserConfig();
    const routerInput = this.resolveVirtualRouterInput(this.userConfig);
    const bootstrapArtifacts = await this.bootstrapVirtualRouter(routerInput);
    this.currentRouterArtifacts = bootstrapArtifacts;
    const hubCtor = await this.ensureHubPipelineCtor();
    const hubConfig: { virtualRouter: unknown; [key: string]: unknown } = {
      virtualRouter: bootstrapArtifacts.config
    };
    const healthModule = this.managerDaemon?.getModule('health') as HealthManagerModule | undefined;
    const healthStore = healthModule?.getHealthStore();
    if (healthStore) {
      hubConfig.healthStore = healthStore;
    }
    const routingModule = this.managerDaemon?.getModule('routing') as RoutingStateManagerModule | undefined;
    const routingStateStore = routingModule?.getRoutingStateStore();
    if (routingStateStore) {
      hubConfig.routingStateStore = routingStateStore;
    }
    const quotaModule = this.managerDaemon?.getModule('provider-quota') as ProviderQuotaDaemonModule | undefined;
    const quotaFlagRaw = String(process.env.ROUTECODEX_QUOTA_ENABLED || '').trim().toLowerCase();
    const quotaEnabled = quotaFlagRaw === '1' || quotaFlagRaw === 'true';
    if (quotaEnabled && quotaModule && typeof quotaModule.getQuotaView === 'function') {
      hubConfig.quotaView = quotaModule.getQuotaView();
    }
    if (!this.hubPipeline) {
      this.hubPipeline = new hubCtor(hubConfig);
    } else {
      this.hubPipeline.updateVirtualRouterConfig(bootstrapArtifacts.config);
    }
    await this.initializeProviderRuntimes(bootstrapArtifacts);
  }

  private buildHandlerContext(): HandlerContext {
    return {
      executePipeline: this.executePipeline.bind(this),
      errorHandling: this.errorHandling
    };
  }

  private async initializeProviderRuntimes(artifacts?: VirtualRouterArtifacts): Promise<void> {
    const runtimeMap = artifacts?.targetRuntime ?? this.currentRouterArtifacts?.targetRuntime ?? undefined;
    if (!runtimeMap) {
      return;
    }
    await this.disposeProviders();
    this.providerKeyToRuntimeKey.clear();

    for (const [providerKey, runtime] of Object.entries(runtimeMap)) {
      if (!runtime) { continue; }
      const runtimeKey = runtime.runtimeKey || providerKey;
      if (!this.providerHandles.has(runtimeKey)) {
        const resolvedRuntime = await this.materializeRuntimeProfile(runtime);
        const patchedRuntime = this.applyProviderProfileOverrides(resolvedRuntime);
        const handle = await this.createProviderHandle(runtimeKey, patchedRuntime);
        this.providerHandles.set(runtimeKey, handle);
      }
      this.providerKeyToRuntimeKey.set(providerKey, runtimeKey);
    }
  }

  private async createProviderHandle(
    runtimeKey: string,
    runtime: ProviderRuntimeProfile
  ): Promise<ProviderHandle> {
    const protocolType = normalizeProviderType(runtime.providerType);
    const providerFamily = runtime.providerFamily || protocolType;
    const providerProtocol =
      (typeof runtime.outboundProfile === 'string' && runtime.outboundProfile.trim()
        ? (runtime.outboundProfile.trim() as ProviderProtocol)
        : undefined) ?? mapProviderProtocol(protocolType);
    const instance = ProviderFactory.createProviderFromRuntime(runtime, this.getModuleDependencies());
    await instance.initialize();
    const providerId = runtime.providerId || runtimeKey.split('.')[0];
    return {
      runtimeKey,
      providerId,
      providerType: protocolType,
      providerFamily,
      providerProtocol,
      runtime,
      instance
    };
  }

  private async materializeRuntimeProfile(runtime: ProviderRuntimeProfile): Promise<ProviderRuntimeProfile> {
    const auth = await this.resolveRuntimeAuth(runtime);
    const baseUrl = this.normalizeRuntimeBaseUrl(runtime);
    const identity = resolveProviderIdentity(runtime.providerType, runtime.providerFamily);
    return {
      ...runtime,
      ...(baseUrl ? { baseUrl } : {}),
      providerType: identity.providerType as ProviderRuntimeProfile['providerType'],
      providerFamily: identity.providerFamily,
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
    const authRecord = auth as LegacyAuthFields;
    const authType = this.normalizeAuthType(auth.type);
    const rawType = typeof auth.rawType === 'string' ? auth.rawType.trim().toLowerCase() : '';
    const pickString = (...candidates: unknown[]): string | undefined => {
      for (const candidate of candidates) {
        if (typeof candidate === 'string') {
          const trimmed = candidate.trim();
          if (trimmed) {
            return trimmed;
          }
        }
      }
      return undefined;
    };
    const pickStringArray = (value: unknown): string[] | undefined => {
      if (!value) { return undefined; }
      if (Array.isArray(value)) {
        const normalized = value
          .map((item) => pickString(item))
          .filter((item): item is string => typeof item === 'string');
        return normalized.length ? normalized : undefined;
      }
      if (typeof value === 'string' && value.trim()) {
        const normalized = value
          .split(/[,\s]+/)
          .map((item) => item.trim())
          .filter(Boolean);
        return normalized.length ? normalized : undefined;
      }
      return undefined;
    };

    if (authType === 'apikey') {
      if (rawType === 'iflow-cookie') {
        return { ...auth, type: 'apikey', rawType: auth.rawType ?? 'iflow-cookie' };
      }
      const value = await this.resolveApiKeyValue(runtime, auth);
      return { ...auth, type: 'apikey', value };
    }

    const resolved: ProviderRuntimeProfile['auth'] = {
      type: 'oauth',
      secretRef: auth.secretRef,
      value: auth.value,
      oauthProviderId: auth.oauthProviderId,
      rawType: auth.rawType,
      tokenFile: pickString(authRecord.tokenFile, authRecord.token_file),
      tokenUrl: pickString(authRecord.tokenUrl, authRecord.token_url),
      deviceCodeUrl: pickString(authRecord.deviceCodeUrl, authRecord.device_code_url),
      clientId: pickString(authRecord.clientId, authRecord.client_id),
      clientSecret: pickString(authRecord.clientSecret, authRecord.client_secret),
      authorizationUrl: pickString(authRecord.authorizationUrl, authRecord.authorization_url, authRecord.authUrl),
      userInfoUrl: pickString(authRecord.userInfoUrl, authRecord.user_info_url),
      refreshUrl: pickString(authRecord.refreshUrl, authRecord.refresh_url),
      scopes: pickStringArray(authRecord.scopes ?? authRecord.scope)
    };

    let tokenFile = resolved.tokenFile;
    if (!tokenFile && typeof auth.secretRef === 'string' && auth.secretRef.trim()) {
      tokenFile = await this.resolveSecretValue(auth.secretRef.trim());
    }
    resolved.tokenFile = tokenFile;

    return resolved;
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
    if (!this.isPipelineReady()) {
      throw new Error('Hub pipeline runtime is not initialized');
    }
    this.stats.recordRequestStart(input.requestId);
    const initialMetadata = this.buildRequestMetadata(input);
    const providerRequestId = input.requestId;
    const clientRequestId = typeof initialMetadata.clientRequestId === 'string' && initialMetadata.clientRequestId.trim()
      ? initialMetadata.clientRequestId.trim()
      : providerRequestId;

    this.logStage('request.received', providerRequestId, {
      endpoint: input.entryEndpoint,
      stream: initialMetadata.stream === true
    });
    try {
      const headerUa =
        (typeof input.headers?.['user-agent'] === 'string' && input.headers['user-agent']) ||
        (typeof input.headers?.['User-Agent'] === 'string' && input.headers['User-Agent']);
      const headerOriginator =
        (typeof input.headers?.['originator'] === 'string' && input.headers['originator']) ||
        (typeof input.headers?.['Originator'] === 'string' && input.headers['Originator']);
      await writeClientSnapshot({
        entryEndpoint: input.entryEndpoint,
        requestId: input.requestId,
        headers: asRecord(input.headers),
        body: input.body,
        metadata: {
          ...initialMetadata,
          userAgent: headerUa,
          clientOriginator: headerOriginator
        }
      });
    } catch {
      // snapshot failure should not block request path
    }
    const pipelineLabel = 'hub';
    let iterationMetadata = initialMetadata;
    let followupTriggered = false;
    // Provider 级别不再在单个 HTTP 请求内执行重复尝试，
    // 429/配额/熔断逻辑统一交由 llmswitch-core VirtualRouter 处理。
    const maxAttempts = 1;
    let attempt = 0;
    const originalBodySnapshot = this.cloneRequestPayload(input.body);
    const excludedProviderKeys = new Set<string>();

    while (true) {
      attempt += 1;
      // 每次尝试前重置请求 body，避免上一轮 HubPipeline 的就地改写导致
      // 第二轮出现 ChatEnvelopeValidationError(messages_missing) 之类的问题。
      if (originalBodySnapshot && typeof originalBodySnapshot === 'object') {
        const cloned =
          this.cloneRequestPayload(originalBodySnapshot) ??
          ({ ...(originalBodySnapshot as Record<string, unknown>) } as Record<string, unknown>);
        input.body = cloned;
      }

      // 为本轮构建独立的 metadata 视图，并注入当前已排除的 providerKey 集合，
      // 让 VirtualRouter 在同一 HTTP 请求内跳过已经 429 过的 key。
      const metadataForIteration: typeof iterationMetadata = {
        ...iterationMetadata,
        excludedProviderKeys: Array.from(excludedProviderKeys)
      };

      this.logStage(`${pipelineLabel}.start`, providerRequestId, {
        endpoint: input.entryEndpoint,
        stream: metadataForIteration.stream
      });
      const originalRequestSnapshot = this.cloneRequestPayload(input.body);
      const pipelineResult = await this.runHubPipeline(input, metadataForIteration);
      const pipelineMetadata = pipelineResult.metadata ?? {};
      const mergedMetadata = { ...metadataForIteration, ...pipelineMetadata };
      this.logStage(`${pipelineLabel}.completed`, providerRequestId, {
        route: pipelineResult.routingDecision?.routeName,
        target: pipelineResult.target?.providerKey
      });

      const providerPayload = pipelineResult.providerPayload;
      const target = pipelineResult.target;
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

      const metadataModel =
        mergedMetadata?.target && typeof mergedMetadata.target === 'object'
          ? (mergedMetadata.target as Record<string, unknown>).clientModelId
          : undefined;
      const rawModel =
        this.extractProviderModel(providerPayload) ||
        (typeof metadataModel === 'string' ? metadataModel : undefined);
      const providerIdToken = target.providerKey || handle.providerId || runtimeKey;
      if (!providerIdToken) {
        throw Object.assign(new Error('Provider identifier missing for request'), {
          code: 'ERR_PROVIDER_ID_MISSING',
          requestId: providerRequestId
        });
      }
      const enhancedRequestId = enhanceProviderRequestId(providerRequestId, {
        entryEndpoint: input.entryEndpoint,
        providerId: providerIdToken,
        model: rawModel
      });
      if (providerProtocol === 'openai-responses') {
        try {
          await rebindResponsesConversationRequestId(pipelineResult.requestId, enhancedRequestId);
        } catch {
          /* ignore rebind failures */
        }
      }
      if (enhancedRequestId !== input.requestId) {
        input.requestId = enhancedRequestId;
      }
      mergedMetadata.clientRequestId = clientRequestId;
      const providerModel = rawModel;
      const providerLabel = this.buildProviderLabel(target.providerKey, providerModel);

      this.logStage('provider.prepare', input.requestId, {
        providerKey: target.providerKey,
        runtimeKey,
        protocol: providerProtocol,
        providerType: handle.providerType,
        providerFamily: handle.providerFamily,
        model: providerModel,
        providerLabel
      });

      attachProviderRuntimeMetadata(providerPayload, {
        requestId: input.requestId,
        providerId: handle.providerId,
        providerKey: target.providerKey,
        providerType: handle.providerType,
        providerFamily: handle.providerFamily,
        providerProtocol,
        pipelineId: target.providerKey,
        routeName: pipelineResult.routingDecision?.routeName,
        runtimeKey,
        target,
        metadata: mergedMetadata
      });

      this.stats.bindProvider(input.requestId, {
        providerKey: target.providerKey,
        providerType: handle.providerType,
        model: providerModel
      });

      this.logStage('provider.send.start', input.requestId, {
        providerKey: target.providerKey,
        runtimeKey,
        protocol: providerProtocol,
        providerType: handle.providerType,
        providerFamily: handle.providerFamily,
        model: providerModel,
        providerLabel
      });

      try {
        const providerResponse = await handle.instance.processIncoming(providerPayload);
        const responseStatus = this.extractResponseStatus(providerResponse);
        this.logStage('provider.send.completed', input.requestId, {
          providerKey: target.providerKey,
          status: responseStatus,
          providerType: handle.providerType,
          providerFamily: handle.providerFamily,
          model: providerModel,
          providerLabel
        });
        const wantsStreamBase = Boolean(input.metadata?.inboundStream ?? input.metadata?.stream);
        const normalized = this.normalizeProviderResponse(providerResponse);
        const converted = await this.convertProviderResponseIfNeeded({
          entryEndpoint: input.entryEndpoint,
          providerType: handle.providerType,
          requestId: input.requestId,
          wantsStream: wantsStreamBase,
          originalRequest: originalRequestSnapshot,
          processMode: pipelineResult.processMode,
          response: normalized,
          pipelineMetadata: mergedMetadata
        });

        const usage = this.extractUsageFromResult(converted, mergedMetadata);
        const quotaModule = this.managerDaemon?.getModule('provider-quota') as ProviderQuotaDaemonModule | undefined;
        if (quotaModule) {
          const totalTokens =
            typeof usage?.total_tokens === 'number' && Number.isFinite(usage.total_tokens)
              ? Math.max(0, usage.total_tokens)
              : Math.max(
                0,
                (typeof usage?.prompt_tokens === 'number' && Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0) +
                  (typeof usage?.completion_tokens === 'number' && Number.isFinite(usage.completion_tokens)
                    ? usage.completion_tokens
                    : 0)
              );
          try {
            quotaModule.recordProviderUsage({ providerKey: target.providerKey, requestedTokens: totalTokens });
          } catch {
            // best-effort
          }
          try {
            // 用于“成功清零连续错误计数”；tokens 已由 usage 事件统计，避免重复累计。
            quotaModule.recordProviderSuccess({ providerKey: target.providerKey, usedTokens: 0 });
          } catch {
            // best-effort
          }
        }
        this.stats.recordCompletion(input.requestId, { usage, error: false });

        return converted;
      } catch (error) {
        this.logStage('provider.send.error', input.requestId, {
          providerKey: target.providerKey,
          message: error instanceof Error ? error.message : String(error ?? 'Unknown error'),
          providerType: handle.providerType,
          providerFamily: handle.providerFamily,
          model: providerModel,
          providerLabel
        });
        const quotaModule = this.managerDaemon?.getModule('provider-quota') as ProviderQuotaDaemonModule | undefined;
        if (quotaModule) {
          try {
            quotaModule.recordProviderUsage({ providerKey: target.providerKey, requestedTokens: 0 });
          } catch {
            // best-effort
          }
        }
        this.stats.recordCompletion(input.requestId, { error: true });
        throw error;
      }
    }
  }

  private async runHubPipeline(
    input: PipelineExecutionInput,
    metadata: Record<string, unknown>
  ): Promise<{
    requestId: string;
    providerPayload: Record<string, unknown>;
    target: {
      providerKey: string;
      providerType: string;
      outboundProfile: string;
      runtimeKey?: string;
      processMode?: string;
    };
    routingDecision?: { routeName?: string };
    processMode: string;
    metadata: Record<string, unknown>;
  }> {
    if (!this.hubPipeline) {
      throw new Error('Hub pipeline runtime is not initialized');
    }
    const payload = asRecord(input.body);
    const pipelineInput: PipelineExecutionInput & { payload: Record<string, unknown> } = {
      ...input,
      metadata: {
        ...metadata,
        logger: this.coloredLogger
      },
      payload
    };
    const result = await this.hubPipeline.execute(pipelineInput);
    if (!result.providerPayload || !result.target?.providerKey) {
      throw Object.assign(new Error('Virtual router did not produce a provider target'), {
        code: 'ERR_NO_PROVIDER_TARGET',
        requestId: input.requestId
      });
    }
    const processMode = (result.metadata?.processMode as string | undefined) ?? 'chat';
    const resultRecord = result as unknown as Record<string, unknown>;
    const derivedRequestId =
      typeof resultRecord.requestId === 'string'
        ? (resultRecord.requestId as string)
        : input.requestId;
    return {
      requestId: derivedRequestId,
      providerPayload: result.providerPayload,
      target: result.target,
      routingDecision: result.routingDecision ?? undefined,
      processMode,
      metadata: result.metadata ?? {}
    };
  }

  private buildRequestMetadata(input: PipelineExecutionInput): Record<string, unknown> {
    const userMeta = asRecord(input.metadata);
    const headers = asRecord(input.headers);
    const inboundUserAgent = this.extractHeaderValue(headers, 'user-agent');
    const inboundOriginator = this.extractHeaderValue(headers, 'originator');
    const resolvedUserAgent =
      typeof userMeta.userAgent === 'string' && userMeta.userAgent.trim()
        ? userMeta.userAgent.trim()
        : inboundUserAgent;
    const resolvedOriginator =
      typeof userMeta.clientOriginator === 'string' && userMeta.clientOriginator.trim()
        ? userMeta.clientOriginator.trim()
        : inboundOriginator;
    const routeHint = this.extractRouteHint(input) ?? userMeta.routeHint;
    const processMode = (userMeta.processMode as string) || 'chat';
    const metadata: Record<string, unknown> = {
      ...userMeta,
      entryEndpoint: input.entryEndpoint,
      processMode,
      direction: 'request',
      stage: 'inbound',
      routeHint,
      stream: userMeta.stream === true,
      ...(resolvedUserAgent ? { userAgent: resolvedUserAgent } : {}),
      ...(resolvedOriginator ? { clientOriginator: resolvedOriginator } : {})
    };

    // 将原始客户端请求头快照到 metadata.clientHeaders，便于 llmswitch-core
    // 的 extractSessionIdentifiersFromMetadata 从中解析 session_id / conversation_id。
    if (!metadata.clientHeaders && headers && Object.keys(headers).length) {
      const clientHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(headers)) {
        if (typeof value === 'string') {
          const trimmed = value.trim();
          if (trimmed) {
            clientHeaders[key] = trimmed;
          }
        } else if (Array.isArray(value) && value.length) {
          const first = String(value[0]).trim();
          if (first) {
            clientHeaders[key] = first;
          }
        }
      }
      if (Object.keys(clientHeaders).length) {
        (metadata as Record<string, unknown>).clientHeaders = clientHeaders;
      }
    }

    // 在 Host 入口统一解析会话标识，后续 HubPipeline / servertool 等模块仅依赖
    // sessionId / conversationId 字段，不再重复解析 clientHeaders。
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { extractSessionIdentifiersFromMetadata } =
        require('../../../../sharedmodule/llmswitch-core/dist/conversion/hub/pipeline/session-identifiers.js') as {
          extractSessionIdentifiersFromMetadata: (meta: Record<string, unknown> | undefined) => {
            sessionId?: string;
            conversationId?: string;
          };
        };
      const identifiers = extractSessionIdentifiersFromMetadata(metadata);
      if (identifiers.sessionId) {
        metadata.sessionId = identifiers.sessionId;
      }
      if (identifiers.conversationId) {
        metadata.conversationId = identifiers.conversationId;
      }
    } catch {
      // best-effort：解析失败时不影响主流程
    }

    return metadata;
  }

  private extractHeaderValue(
    headers: Record<string, unknown> | undefined,
    name: string
  ): string | undefined {
    if (!headers) {
      return undefined;
    }
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== target) {
        continue;
      }
      if (typeof value === 'string') {
        return value.trim() || undefined;
      }
      if (Array.isArray(value) && value.length) {
        return String(value[0]).trim() || undefined;
      }
      return undefined;
    }
    return undefined;
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

  private extractResponseStatus(response: unknown): number | undefined {
    if (!response || typeof response !== 'object') {
      return undefined;
    }
    const candidate = (response as { status?: unknown }).status;
    return typeof candidate === 'number' ? candidate : undefined;
  }

  private normalizeProviderResponse(response: unknown): PipelineExecutionResult {
    const status = this.extractResponseStatus(response);
    const headers = this.normalizeProviderResponseHeaders(
      response && typeof response === 'object' ? (response as Record<string, unknown>).headers : undefined
    );
    const body =
      response && typeof response === 'object' && 'data' in (response as Record<string, unknown>)
        ? (response as Record<string, unknown>).data
        : response;
    return { status, headers, body };
  }

  private normalizeProviderResponseHeaders(headers: unknown): Record<string, string> | undefined {
    if (!headers || typeof headers !== 'object') { return undefined; }
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof value === 'string') {
        normalized[key.toLowerCase()] = value;
      }
    }
    return Object.keys(normalized).length ? normalized : undefined;
  }

  private extractUsageFromResult(
    result: PipelineExecutionResult,
    metadata?: Record<string, unknown>
  ): UsageMetrics | undefined {
    const candidates: unknown[] = [];
    if (metadata && typeof metadata === 'object') {
      const bag = metadata as Record<string, unknown>;
      if (bag.usage) {
        candidates.push(bag.usage);
      }
    }
    if (result.body && typeof result.body === 'object') {
      const body = result.body as Record<string, unknown>;
      if (body.usage) {
        candidates.push(body.usage);
      }
      if (body.response && typeof body.response === 'object') {
        const responseNode = body.response as Record<string, unknown>;
        if (responseNode.usage) {
          candidates.push(responseNode.usage);
        }
      }
    }
    for (const candidate of candidates) {
      const normalized = this.normalizeUsage(candidate);
      if (normalized) {
        return normalized;
      }
    }
    return undefined;
  }

  private normalizeUsage(value: unknown): UsageMetrics | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const prompt =
      typeof record.prompt_tokens === 'number'
        ? record.prompt_tokens
        : typeof record.input_tokens === 'number'
          ? record.input_tokens
          : undefined;
    const completion =
      typeof record.completion_tokens === 'number'
        ? record.completion_tokens
        : typeof record.output_tokens === 'number'
          ? record.output_tokens
          : undefined;
    let total =
      typeof record.total_tokens === 'number'
        ? record.total_tokens
        : undefined;
    if (total === undefined && prompt !== undefined && completion !== undefined) {
      total = prompt + completion;
    }
    if (prompt === undefined && completion === undefined && total === undefined) {
      return undefined;
    }
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: total
    };
  }

  private async convertProviderResponseIfNeeded(options: {
    entryEndpoint?: string;
    providerType?: string;
    requestId: string;
    wantsStream: boolean;
    originalRequest?: Record<string, unknown> | undefined;
    processMode?: string;
    response: PipelineExecutionResult;
    pipelineMetadata?: Record<string, unknown>;
  }): Promise<PipelineExecutionResult> {
    const body = options.response.body;
    if (body && typeof body === 'object') {
      const wrapperError = this.extractSseWrapperError(body as Record<string, unknown>);
      if (wrapperError) {
        const error = new Error(`[RouteCodexHttpServer] Upstream SSE terminated: ${wrapperError}`) as Error & { code?: string };
        error.code = 'SSE_DECODE_ERROR';
        throw error;
      }
    }
    if (options.processMode === 'passthrough') {
      return options.response;
    }
    const entry = (options.entryEndpoint || '').toLowerCase();
    const needsAnthropicConversion = entry.includes('/v1/messages');
    const needsResponsesConversion = entry.includes('/v1/responses');
    const needsChatConversion = entry.includes('/v1/chat/completions');
    if (!needsAnthropicConversion && !needsResponsesConversion && !needsChatConversion) {
      return options.response;
    }
    if (!body || typeof body !== 'object') {
      return options.response;
    }
    try {
      const providerProtocol = mapProviderProtocol(options.providerType);
      const metadataBag = asRecord(options.pipelineMetadata);
      const aliasMap = extractAnthropicToolAliasMap(metadataBag);
      const originalModelId = this.extractClientModelId(metadataBag, options.originalRequest);

      // 以 HubPipeline metadata 为基础构建 AdapterContext，确保诸如
      // capturedChatRequest / webSearch / routeHint 等字段在响应侧可见，
      // 便于 llmswitch-core 内部实现 servertool/web_search 的第三跳。
      const baseContext: Record<string, unknown> = {
        ...(metadataBag ?? {})
      };
      // 将 HubPipeline metadata.routeName 映射为 AdapterContext.routeId，
      // 便于 llmswitch-core 在第三跳中使用 routeHint 复用首次路由决策。
      if (typeof (metadataBag as Record<string, unknown> | undefined)?.routeName === 'string') {
        baseContext.routeId = (metadataBag as Record<string, unknown>).routeName as string;
      }
      baseContext.requestId = options.requestId;
      baseContext.entryEndpoint = options.entryEndpoint || entry;
      baseContext.providerProtocol = providerProtocol;
      baseContext.originalModelId = originalModelId;
      const adapterContext = baseContext;
      // 将 serverToolFollowup 等标记从 pipelineMetadata 透传到 AdapterContext，
      // 便于 convertProviderResponse 正确识别内部二跳请求并跳过 servertool。
      if (metadataBag && Object.prototype.hasOwnProperty.call(metadataBag, 'serverToolFollowup')) {
        (adapterContext as Record<string, unknown>).serverToolFollowup = (metadataBag as Record<string, unknown>)
          .serverToolFollowup as unknown;
      }
      const compatProfile =
        metadataBag &&
          typeof metadataBag === 'object' &&
          metadataBag.target &&
          typeof metadataBag.target === 'object' &&
          typeof (metadataBag.target as Record<string, unknown>).compatibilityProfile === 'string'
          ? ((metadataBag.target as Record<string, unknown>).compatibilityProfile as string)
          : undefined;
      if (compatProfile && compatProfile.trim()) {
        adapterContext.compatibilityProfile = compatProfile.trim();
      }
      if (aliasMap) {
        adapterContext.anthropicToolNameMap = aliasMap;
      }
      if (metadataBag && typeof metadataBag === 'object') {
        const webSearchConfig = (metadataBag as Record<string, unknown>).webSearch;
        if (webSearchConfig && typeof webSearchConfig === 'object') {
          adapterContext.webSearch = webSearchConfig;
        }
        if ((metadataBag as Record<string, unknown>).forceWebSearch === true) {
          adapterContext.forceWebSearch = true;
        }
        if ((metadataBag as Record<string, unknown>).forceVision === true) {
          adapterContext.forceVision = true;
        }
      }
      const stageRecorder = await bridgeCreateSnapshotRecorder(
        adapterContext,
        typeof (adapterContext as Record<string, unknown>).entryEndpoint === 'string'
          ? ((adapterContext as Record<string, unknown>).entryEndpoint as string)
          : options.entryEndpoint || entry
      );
      const providerInvoker = async (invokeOptions: {
        providerKey: string;
        providerType?: string;
        modelId?: string;
        providerProtocol: string;
        payload: Record<string, unknown>;
        entryEndpoint: string;
        requestId: string;
      }): Promise<{ providerResponse: Record<string, unknown> }> => {
        const runtimeKey =
          this.providerKeyToRuntimeKey.get(invokeOptions.providerKey) || invokeOptions.providerKey;
        const handle = this.providerHandles.get(runtimeKey);
        if (!handle) {
          throw new Error(`Provider runtime ${runtimeKey} not found`);
        }
        const providerResponse = await handle.instance.processIncoming(invokeOptions.payload);
        const normalized = this.normalizeProviderResponse(providerResponse);
        const bodyPayload =
          normalized.body && typeof normalized.body === 'object'
            ? (normalized.body as Record<string, unknown>)
            : (normalized as unknown as Record<string, unknown>);
        return { providerResponse: bodyPayload };
      };
      const reenterPipeline = async (reenterOpts: {
        entryEndpoint: string;
        requestId: string;
        body: Record<string, unknown>;
        metadata?: Record<string, unknown>;
      }): Promise<{ body?: Record<string, unknown>; __sse_responses?: unknown; format?: string }> => {
        const nestedEntry = reenterOpts.entryEndpoint || options.entryEndpoint || entry;
        const nestedExtra = asRecord(reenterOpts.metadata) ?? {};
        const nestedEntryLower = nestedEntry.toLowerCase();

        // 基于首次 HubPipeline metadata + 调用方注入的 metadata 构建新的请求 metadata。
        // 不在 Host 层编码 servertool/web_search 等语义，由 llmswitch-core 负责。
        const nestedMetadata: Record<string, unknown> = {
          ...(metadataBag ?? {}),
          ...nestedExtra,
          entryEndpoint: nestedEntry,
          direction: 'request',
          stage: 'inbound'
        };

        // 针对 reenterPipeline 的入口端点，纠正 providerProtocol，避免沿用外层协议。
        if (nestedEntryLower.includes('/v1/chat/completions')) {
          nestedMetadata.providerProtocol = 'openai-chat';
        } else if (nestedEntryLower.includes('/v1/responses')) {
          nestedMetadata.providerProtocol = 'openai-responses';
        } else if (nestedEntryLower.includes('/v1/messages')) {
          nestedMetadata.providerProtocol = 'anthropic-messages';
        }
        const followupProtocol =
          typeof (nestedExtra as Record<string, unknown>).serverToolFollowupProtocol === 'string'
            ? ((nestedExtra as Record<string, unknown>).serverToolFollowupProtocol as string)
            : undefined;
        if (followupProtocol) {
          nestedMetadata.providerProtocol = followupProtocol;
        }

        const nestedInput: PipelineExecutionInput = {
          entryEndpoint: nestedEntry,
          method: 'POST',
          requestId: reenterOpts.requestId,
          headers: {},
          query: {},
          body: reenterOpts.body,
          metadata: nestedMetadata
        };

        const nestedResult = await this.executePipeline(nestedInput);
        const nestedBody =
          nestedResult.body && typeof nestedResult.body === 'object'
            ? (nestedResult.body as Record<string, unknown>)
            : undefined;
        return { body: nestedBody };
      };
      const converted = await bridgeConvertProviderResponse({
        providerProtocol,
        providerResponse: body as Record<string, unknown>,
        context: adapterContext,
        entryEndpoint: options.entryEndpoint || entry,
        wantsStream: options.wantsStream,
        providerInvoker,
        stageRecorder,
        reenterPipeline
      });
      if (converted.__sse_responses) {
        return {
          ...options.response,
          body: { __sse_responses: converted.__sse_responses }
        };
      }
      return {
        ...options.response,
        body: converted.body ?? body
      };
    } catch (error) {
      const err = error as Error | unknown;
      const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
      const errRecord = err as Record<string, unknown>;
      const errCode = typeof errRecord.code === 'string' ? errRecord.code : undefined;
      const errName = typeof errRecord.name === 'string' ? errRecord.name : undefined;
      const isSseDecodeError =
        errCode === 'SSE_DECODE_ERROR' ||
        (errName === 'ProviderProtocolError' && message.toLowerCase().includes('sse'));
      const isServerToolFollowupError = errCode === 'SERVERTOOL_FOLLOWUP_FAILED';
      if (isSseDecodeError || isServerToolFollowupError) {
        console.error('[RouteCodexHttpServer] Fatal conversion error, bubbling as HTTP error', error);
        throw error;
      }
      console.error('[RouteCodexHttpServer] Failed to convert provider response via llmswitch-core', error);
      return options.response;
    }
  }

  private extractSseWrapperError(payload: Record<string, unknown> | undefined): string | undefined {
    return this.findSseWrapperError(payload, 2);
  }

  private findSseWrapperError(
    record: Record<string, unknown> | undefined,
    depth: number
  ): string | undefined {
    if (!record || typeof record !== 'object' || depth < 0) {
      return undefined;
    }
    const mode = record.mode;
    const errVal = record.error;
    if (mode === 'sse' && typeof errVal === 'string' && errVal.trim()) {
      return errVal.trim();
    }
    const nestedKeys = ['body', 'data', 'payload', 'response'];
    for (const key of nestedKeys) {
      const nested = record[key];
      if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
        continue;
      }
      const found = this.findSseWrapperError(nested as Record<string, unknown>, depth - 1);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  private extractClientModelId(
    metadata: Record<string, unknown>,
    originalRequest?: Record<string, unknown>
  ): string | undefined {
    const candidates = [
      metadata.clientModelId,
      metadata.originalModelId,
      (metadata.target && typeof metadata.target === 'object'
        ? (metadata.target as Record<string, unknown>).clientModelId
        : undefined),
      originalRequest && typeof originalRequest === 'object'
        ? (originalRequest as Record<string, unknown>).model
        : undefined,
      originalRequest && typeof originalRequest === 'object'
        ? (originalRequest as Record<string, unknown>).originalModelId
        : undefined
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }
    return undefined;
  }

  private cloneRequestPayload(payload: unknown): Record<string, unknown> | undefined {
    if (!payload || typeof payload !== 'object') { return undefined; }
    try {
      return JSON.parse(JSON.stringify(payload));
    } catch {
      return undefined;
    }
  }

  private async initializeRouteErrorHub(): Promise<void> {
    try {
      this.routeErrorHub = initializeRouteErrorHub({ errorHandlingCenter: this.errorHandling });
      await this.routeErrorHub.initialize();
    } catch (error) {
      console.error('[RouteCodexHttpServer] Failed to initialize RouteErrorHub', error);
    }
  }

}

function createNoopPipelineLogger(): PipelineDebugLogger {
  const noop = () => { };
  const emptyLogs = (): {
    general: DebugLogEntry[];
    transformations: TransformationLogEntry[];
    provider: ProviderRequestLogEntry[];
  } => ({
    general: [],
    transformations: [],
    provider: []
  });
  const emptyList = <T>(): T[] => [];
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
    getRecentLogs: () => emptyList<DebugLogEntry>(),
    getTransformationLogs: () => emptyList<TransformationLogEntry>(),
    getProviderLogs: () => emptyList<ProviderRequestLogEntry>(),
    getStatistics: emptyStats,
    clearLogs: noop,
    exportLogs: () => ([]),
    log: noop
  };
}
import { formatErrorForErrorCenter } from '../../../utils/error-center-payload.js';
