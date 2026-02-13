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
import type { Socket } from 'node:net';
import { ErrorHandlingCenter } from 'rcc-errorhandling';
import type { UnknownObject } from '../../../types/common-types.js';
import type { HandlerContext, PipelineExecutionInput, PipelineExecutionResult } from '../../handlers/types.js';
import type { ModuleDependencies, PipelineDebugLogger } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import { PipelineDebugLogger as PipelineDebugLoggerImpl } from '../../../modules/pipeline/utils/debug-logger.js';
import type {
  DebugLogEntry,
  TransformationLogEntry,
  ProviderRequestLogEntry
} from '../../../modules/pipeline/utils/debug-logger.js';
import type { DebugCenter } from '../../../modules/pipeline/types/external-types.js';
import { AuthFileResolver } from '../../../config/auth-file-resolver.js';
import type { ProviderRuntimeProfile } from '../../../providers/core/api/provider-types.js';
import type { ProviderProfile, ProviderProfileCollection } from '../../../providers/profile/provider-profile.js';
import { isStageLoggingEnabled } from '../../utils/stage-logger.js';
import { registerApiKeyAuthMiddleware, registerDefaultMiddleware } from './middleware.js';
import { registerOAuthPortalRoute } from './routes.js';
import { resolveRepoRoot } from './llmswitch-loader.js';
import type {
  HubPipeline,
  HubPipelineCtor,
  ProviderHandle,
  ServerConfigV2,
  ServerStatusV2,
  VirtualRouterArtifacts
} from './types.js';
import { createServerColoredLogger } from './colored-logger.js';
import { QuietErrorHandlingCenter } from '../../../error-handling/quiet-error-handling-center.js';
import { ManagerDaemon } from '../../../manager/index.js';
import { ensureServerScopedSessionDir } from './session-dir.js';
import { canonicalizeServerId } from './server-id.js';
import { StatsManager } from './stats-manager.js';
import { resolveHubShadowCompareConfig } from './hub-shadow-compare.js';
import { resolveLlmsEngineShadowConfig } from '../../../utils/llms-engine-shadow.js';
import { createRequestExecutor, type RequestExecutor } from './request-executor.js';
import {
  resolveVirtualRouterInput,
  getModuleDependencies,
  registerDaemonAdminUiRoute,
  getErrorHandlingShim,
  createDebugCenterShim,
  updateProviderProfiles,
  ensureProviderProfilesFromUserConfig,
  tryBuildProfiles,
  findProviderProfile,
  applyProviderProfileOverrides,
  canonicalizeRuntimeProvider,
  logStage,
  extractProviderModel,
  buildProviderLabel,
  normalizeAuthType,
  resolveSecretValue,
  isSafeSecretReference,
  bootstrapVirtualRouter,
  ensureHubPipelineCtor,
  ensureHubPipelineEngineShadow,
  isPipelineReady,
  waitForRuntimeReady,
  isQuotaRoutingEnabled,
  shouldStartManagerDaemon,
  initializeRouteErrorHub
} from './http-server-bootstrap.js';
import {
  shouldEnableClockDaemonInjectLoop,
  resolveRawClockConfig,
  stopClockDaemonInjectLoop,
  startClockDaemonInjectLoop,
  tickClockDaemonInjectLoop
} from './http-server-clock-daemon.js';
import { setupRuntime } from './http-server-runtime-setup.js';
import {
  initializeProviderRuntimes,
  createProviderHandle,
  materializeRuntimeProfile,
  normalizeRuntimeBaseUrl,
  resolveRuntimeAuth,
  resolveApiKeyValue,
  isLocalBaseUrl,
  disposeProviders
} from './http-server-runtime-providers.js';
import {
  initializeHttpServer,
  restartRuntimeFromDisk,
  startHttpServer,
  stopHttpServer,
  getHttpServerStatus,
  getHttpServerConfig,
  isHttpServerInitialized,
  isHttpServerRunning,
  handleHttpServerError,
  initializeWithUserConfig,
  reloadHttpServerRuntime,
  buildHttpHandlerContext
} from './http-server-lifecycle.js';
import { executePipelineViaLegacyOverride } from './http-server-legacy-pipeline.js';
import type { RouteErrorHub } from '../../../error-handling/route-error-hub.js';

export class RouteCodexHttpServer {
  private app: Application;
  private server?: Server;
  private activeSockets: Set<Socket> = new Set();
  private config: ServerConfigV2;
  private errorHandling: ErrorHandlingCenter;
  private _isInitialized: boolean = false;
  private _isRunning: boolean = false;

  private hubPipeline: HubPipeline | null = null;
  private providerHandles: Map<string, ProviderHandle> = new Map();
  private providerKeyToRuntimeKey: Map<string, string> = new Map();
  private providerRuntimeInitErrors: Map<string, Error> = new Map();
  private runtimeKeyCredentialSkipped: Set<string> = new Set();
  private startupExcludedProviderKeys: Set<string> = new Set();
  private pipelineLogger: PipelineDebugLogger = createNoopPipelineLogger();
  private authResolver = new AuthFileResolver();
  private userConfig: UnknownObject = {};
  private runtimeReadyPromise: Promise<void>;
  private runtimeReadyResolve: (() => void) | null = null;
  private runtimeReadyReject: ((error: Error) => void) | null = null;
  private runtimeReadyResolved = false;
  private runtimeReadyError: Error | null = null;
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
  private restartChain: Promise<void> = Promise.resolve();
  private readonly hubShadowCompareConfig = resolveHubShadowCompareConfig();
  private readonly llmsEngineShadowConfig = resolveLlmsEngineShadowConfig();
  private hubPolicyMode: string | null = null;
  private hubPipelineEngineShadow: HubPipeline | null = null;
  private hubPipelineConfigForShadow: Record<string, unknown> | null = null;
  private clockDaemonInjectTimer: NodeJS.Timeout | null = null;
  private clockDaemonInjectTickInFlight = false;
  private lastClockDaemonInjectErrorAtMs = 0;
  private readonly clockDaemonInjectSkipLogByKey: Map<string, number> = new Map();
  private lastClockDaemonCleanupAtMs = 0;
  private readonly requestExecutor: RequestExecutor;

  constructor(config: ServerConfigV2) {
    this.config = config;
    this.app = express();
    this.errorHandling = new QuietErrorHandlingCenter();
    this.stageLoggingEnabled = isStageLoggingEnabled();
    this.repoRoot = resolveRepoRoot(import.meta.url);
    ensureServerScopedSessionDir(canonicalizeServerId(this.config.server.host, this.config.server.port));

    try {
      this.pipelineLogger = new PipelineDebugLoggerImpl({ colored: this.coloredLogger }, { enableConsoleLogging: true });
    } catch (error) {
      console.warn('[RouteCodexHttpServer] Failed to initialize PipelineDebugLogger; falling back to noop logger.', error);
      this.pipelineLogger = createNoopPipelineLogger();
    }

    this.runtimeReadyPromise = new Promise<void>((resolve, reject) => {
      this.runtimeReadyResolve = resolve;
      this.runtimeReadyReject = reject;
    });

    this.requestExecutor = createRequestExecutor({
      runtimeManager: {
        resolveRuntimeKey: (providerKey?: string, fallback?: string): string | undefined => {
          if (providerKey && this.providerKeyToRuntimeKey.has(providerKey)) {
            return this.providerKeyToRuntimeKey.get(providerKey);
          }
          return fallback;
        },
        getHandleByRuntimeKey: (runtimeKey?: string): ProviderHandle | undefined => {
          if (!runtimeKey) {
            return undefined;
          }
          return this.providerHandles.get(runtimeKey);
        }
      },
      getHubPipeline: () => this.hubPipeline,
      getModuleDependencies: () => this.getModuleDependencies(),
      logStage: (stage: string, requestId: string, details?: Record<string, unknown>) => {
        this.logStage(stage, requestId, details);
      },
      stats: this.stats
    });

    registerApiKeyAuthMiddleware(this.app, this.config);
    registerDefaultMiddleware(this.app);
    registerOAuthPortalRoute(this.app);
    this.registerDaemonAdminUiRoute();
    console.log('[RouteCodexHttpServer] OAuth Portal route registered (early initialization)');
    console.log('[RouteCodexHttpServer] Initialized (pipeline=hub)');
  }

  private resolveVirtualRouterInput(userConfig: UnknownObject): UnknownObject {
    return resolveVirtualRouterInput(this, userConfig);
  }

  private getModuleDependencies(): ModuleDependencies {
    return getModuleDependencies(this);
  }

  private registerDaemonAdminUiRoute(): void {
    registerDaemonAdminUiRoute(this);
  }

  private getErrorHandlingShim(): ModuleDependencies['errorHandlingCenter'] {
    return getErrorHandlingShim(this);
  }

  private createDebugCenterShim(): DebugCenter {
    return createDebugCenterShim();
  }

  private updateProviderProfiles(collection?: ProviderProfileCollection, rawConfig?: UnknownObject): void {
    updateProviderProfiles(this, collection, rawConfig);
  }

  private ensureProviderProfilesFromUserConfig(): void {
    ensureProviderProfilesFromUserConfig(this);
  }

  private tryBuildProfiles(config: UnknownObject | undefined): ProviderProfileCollection | null {
    return tryBuildProfiles(config);
  }

  private findProviderProfile(runtime: ProviderRuntimeProfile): ProviderProfile | undefined {
    return findProviderProfile(this, runtime);
  }

  private applyProviderProfileOverrides(runtime: ProviderRuntimeProfile): ProviderRuntimeProfile {
    return applyProviderProfileOverrides(this, runtime);
  }

  private canonicalizeRuntimeProvider(runtime: ProviderRuntimeProfile): ProviderRuntimeProfile {
    return canonicalizeRuntimeProvider(runtime);
  }

  private logStage(stage: string, requestId: string, details?: Record<string, unknown>): void {
    logStage(this, stage, requestId, details);
  }

  private extractProviderModel(payload?: Record<string, unknown>): string | undefined {
    return extractProviderModel(this, payload);
  }

  private buildProviderLabel(providerKey?: string, model?: string): string | undefined {
    return buildProviderLabel(this, providerKey, model);
  }

  private normalizeAuthType(input: unknown): 'apikey' | 'oauth' {
    return normalizeAuthType(this, input);
  }

  private async resolveSecretValue(raw?: string): Promise<string> {
    return await resolveSecretValue(this, raw);
  }

  private isSafeSecretReference(value: string): boolean {
    return isSafeSecretReference(this, value);
  }

  private async bootstrapVirtualRouter(input: UnknownObject): Promise<VirtualRouterArtifacts> {
    return await bootstrapVirtualRouter(this, input);
  }

  private async ensureHubPipelineCtor(): Promise<HubPipelineCtor> {
    return await ensureHubPipelineCtor(this);
  }

  private async ensureHubPipelineEngineShadow(): Promise<HubPipeline> {
    return await ensureHubPipelineEngineShadow(this);
  }

  private isPipelineReady(): boolean {
    return isPipelineReady(this);
  }

  private async waitForRuntimeReady(): Promise<void> {
    await waitForRuntimeReady(this);
  }

  private isQuotaRoutingEnabled(): boolean {
    return isQuotaRoutingEnabled(this);
  }

  private shouldStartManagerDaemon(): boolean {
    return shouldStartManagerDaemon(this);
  }

  private shouldEnableClockDaemonInjectLoop(): boolean {
    return shouldEnableClockDaemonInjectLoop();
  }

  private resolveRawClockConfig(): unknown {
    return resolveRawClockConfig(this);
  }

  private stopClockDaemonInjectLoop(): void {
    stopClockDaemonInjectLoop(this);
  }

  private startClockDaemonInjectLoop(): void {
    startClockDaemonInjectLoop(this);
  }

  private async tickClockDaemonInjectLoop(): Promise<void> {
    await tickClockDaemonInjectLoop(this);
  }

  public async initialize(): Promise<void> {
    await initializeHttpServer(this);
  }

  private async restartRuntimeFromDisk(): Promise<{ reloadedAt: number; configPath: string; warnings?: string[] }> {
    return await restartRuntimeFromDisk(this);
  }

  public async start(): Promise<void> {
    await startHttpServer(this);
  }

  public async stop(): Promise<void> {
    await stopHttpServer(this);
  }

  public getStatus(): ServerStatusV2 {
    return getHttpServerStatus(this);
  }

  public getServerConfig(): { host: string; port: number } {
    return getHttpServerConfig(this);
  }

  public isInitialized(): boolean {
    return isHttpServerInitialized(this);
  }

  public isRunning(): boolean {
    return isHttpServerRunning(this);
  }

  private async handleError(error: Error, context: string): Promise<void> {
    await handleHttpServerError(this, error, context);
  }

  public async initializeWithUserConfig(
    userConfig: UnknownObject,
    context?: { providerProfiles?: ProviderProfileCollection }
  ): Promise<void> {
    await initializeWithUserConfig(this, userConfig, context);
  }

  public async reloadRuntime(
    userConfig: UnknownObject,
    context?: { providerProfiles?: ProviderProfileCollection }
  ): Promise<void> {
    await reloadHttpServerRuntime(this, userConfig, context);
  }

  private async setupRuntime(userConfig: UnknownObject): Promise<void> {
    await setupRuntime(this, userConfig);
  }

  private buildHandlerContext(): HandlerContext {
    return buildHttpHandlerContext(this);
  }

  private async initializeProviderRuntimes(artifacts?: VirtualRouterArtifacts): Promise<void> {
    await initializeProviderRuntimes(this, artifacts);
  }

  private async createProviderHandle(runtimeKey: string, runtime: ProviderRuntimeProfile): Promise<ProviderHandle> {
    return await createProviderHandle(this, runtimeKey, runtime);
  }

  private async materializeRuntimeProfile(runtime: ProviderRuntimeProfile): Promise<ProviderRuntimeProfile> {
    return await materializeRuntimeProfile(this, runtime);
  }

  private normalizeRuntimeBaseUrl(runtime: ProviderRuntimeProfile): string | undefined {
    return normalizeRuntimeBaseUrl(this, runtime);
  }

  private async resolveRuntimeAuth(runtime: ProviderRuntimeProfile): Promise<ProviderRuntimeProfile['auth']> {
    return await resolveRuntimeAuth(this, runtime);
  }

  private async resolveApiKeyValue(runtime: ProviderRuntimeProfile, auth: ProviderRuntimeProfile['auth']): Promise<string> {
    return await resolveApiKeyValue(this, runtime, auth);
  }

  private isLocalBaseUrl(value: string): boolean {
    return isLocalBaseUrl(this, value);
  }

  private async disposeProviders(): Promise<void> {
    await disposeProviders(this);
  }

  private async executePipeline(input: PipelineExecutionInput): Promise<PipelineExecutionResult> {
    const legacyRunHubPipeline = (this as unknown as { runHubPipeline?: unknown }).runHubPipeline;
    if (
      Object.prototype.hasOwnProperty.call(this as object, 'runHubPipeline') &&
      typeof legacyRunHubPipeline === 'function'
    ) {
      return await executePipelineViaLegacyOverride(
        this,
        input,
        legacyRunHubPipeline as (i: PipelineExecutionInput, m: Record<string, unknown>) => Promise<any>
      );
    }
    return await this.requestExecutor.execute(input);
  }

  private async initializeRouteErrorHub(): Promise<void> {
    await initializeRouteErrorHub(this);
  }
}

function createNoopPipelineLogger(): PipelineDebugLogger {
  const noop = () => {};
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
    exportLogs: () => [],
    log: noop
  };
}
