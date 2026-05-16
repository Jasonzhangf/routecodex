/**
 * RouteCodex Server V2 - 渐进式重构版本
 *
 * 核心特性：
 * - 与现有V1服务器完全并行
 * - 集成系统hooks模块
 * - 模块化设计，职责分离
 * - 保持API兼容性
 */

import express, { type Application, type Request } from 'express';
import type { Server } from 'http';
import type { Socket } from 'node:net';
import { ErrorHandlingCenter } from 'rcc-errorhandling';
import type { UnknownObject } from '../../../types/common-types.js';
import type { HandlerContext, PipelineExecutionInput, PipelineExecutionResult } from '../../handlers/types.js';
import type { ModuleDependencies, PipelineDebugLogger } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import { PipelineDebugLogger as PipelineDebugLoggerImpl } from '../../../modules/pipeline/utils/debug-logger.js';
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
import { cleanupSessionStorageOnStartup } from './session-storage-cleanup.js';
import { isTmuxSessionAlive } from './tmux-session-probe.js';
import { shouldLogStageEvent, extractProviderKeysForRoutingGroup } from './http-server-bootstrap.js';
import { canonicalizeServerId } from './server-id.js';
import { StatsManager } from './stats-manager.js';
import { PortRegistry } from './port-registry.js';
import type { PortConfig } from './port-config-types.js';
import { normalizePortsConfig, validatePortConfigs } from './port-config-validator.js';
import {
  detectInboundProtocolFromRequest,
  executeProviderDirectPipeline,
} from './provider-direct-pipeline.js';
import { resolveHubShadowCompareConfig } from './hub-shadow-compare.js';
import { resolveLlmsEngineShadowConfig } from '../../../utils/llms-engine-shadow.js';
import { createRequestExecutor, type RequestExecutor } from './request-executor.js';
import { RequestActivityTracker } from './request-activity-tracker.js';
import { getSessionExecutionStateTracker } from './session-execution-state.js';
import { startSessionReaper, stopSessionReaper } from './session-client-reaper.js';
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
  initializeRouteErrorHub,
} from './http-server-bootstrap.js';
import {
  shouldEnableSessionDaemonInjectLoop,
  resolveRawSessionConfig,
  stopSessionDaemonInjectLoop,
  startSessionDaemonInjectLoop,
  tickSessionDaemonInjectLoop
} from './http-server-session-daemon.js';
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
import type { RouteErrorHub } from '../../../error-handling/route-error-hub.js';
import { attachProviderRuntimeMetadata } from '../../../providers/core/runtime/provider-runtime-metadata.js';
import { normalizeProviderResponse } from './executor/provider-response-utils.js';
import { convertProviderResponseIfNeeded } from './executor/provider-response-converter.js';
import { extractUsageFromResult } from './executor/usage-aggregator.js';
import { deriveFinishReason } from '../../utils/finish-reason.js';
import { mapProviderProtocol } from './provider-utils.js';

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
  private pipelineLogger!: PipelineDebugLogger;
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
  private sessionDaemonInjectTimer: NodeJS.Timeout | null = null;
  private sessionDaemonInjectTickInFlight = false;
  private lastSessionDaemonInjectErrorAtMs = 0;
  private readonly sessionDaemonInjectSkipLogByKey: Map<string, number> = new Map();
  private readonly sessionDaemonCleanupLogByKey: Map<string, number> = new Map();
  private lastSessionDaemonCleanupAtMs = 0;
  private readonly requestActivityTracker = new RequestActivityTracker();
  private readonly portRegistry = new PortRegistry();
  private readonly requestExecutor: RequestExecutor;

  constructor(config: ServerConfigV2) {
    this.config = config;
    this.app = express();
    (this.app.locals as Record<string, unknown>).routecodexServer = this;
    this.errorHandling = new QuietErrorHandlingCenter();
    this.stageLoggingEnabled = isStageLoggingEnabled();
    this.repoRoot = resolveRepoRoot(import.meta.url);
    ensureServerScopedSessionDir(canonicalizeServerId(this.config.server.host, this.config.server.port));
    const sessionCleanup = cleanupSessionStorageOnStartup({ isTmuxSessionAlive });
    if (
      sessionCleanup.removedLegacyScopeFiles > 0 ||
      sessionCleanup.removedDeadTmuxStateFiles > 0 ||
      sessionCleanup.removedHeartbeatStateFiles > 0 ||
      sessionCleanup.removedClockStateFiles > 0 ||
      sessionCleanup.prunedRegistryDirs > 0 ||
      sessionCleanup.removedRegistryDirs > 0
    ) {
      console.log('[session-storage-cleanup] startup cleanup', sessionCleanup);
    }

    try {
      this.pipelineLogger = new PipelineDebugLoggerImpl({ colored: this.coloredLogger }, { enableConsoleLogging: true });
    } catch (error) {
      throw new Error(
        `[RouteCodexHttpServer] Failed to initialize PipelineDebugLogger: ${error instanceof Error ? error.message : String(error)}`
      );
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
          const direct = this.providerHandles.get(runtimeKey);
          if (direct) {
            return direct;
          }
          const runtimeKeyParts = runtimeKey.split('.');
          if (runtimeKeyParts.length === 2) {
            const aliasScopedPrefix = `${runtimeKeyParts[0]}.${runtimeKeyParts[1]}.`;
            for (const [candidateKey, handle] of this.providerHandles.entries()) {
              if (candidateKey.startsWith(aliasScopedPrefix)) {
                return handle;
              }
            }
          }
          return undefined;
        }
      },
      getHubPipeline: () => this.hubPipeline,
      getModuleDependencies: () => this.getModuleDependencies(),
      logStage: (stage: string, requestId: string, details?: Record<string, unknown>) => {
        this.logStage(stage, requestId, details);
      },
      shouldLogStageEvent: (stage: string) => shouldLogStageEvent(this, stage),
      stats: this.stats,
      onRequestStart: ({ requestId, metadata }) => {
        this.requestActivityTracker.start(requestId, metadata);
        getSessionExecutionStateTracker().recordRequestStart(requestId, metadata);
      },
      onRequestEnd: async ({ requestId }) => {
        this.requestActivityTracker.end(requestId);
        await this.tickSessionDaemonInjectLoop();
      }
    });

    registerApiKeyAuthMiddleware(this.app, this.config);
    registerDefaultMiddleware(this.app, this.config);
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
    return createDebugCenterShim(this);
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

  private shouldEnableSessionDaemonInjectLoop(): boolean {
    return shouldEnableSessionDaemonInjectLoop();
  }

  private resolveRawSessionConfig(): unknown {
    return resolveRawSessionConfig(this);
  }

  private stopSessionDaemonInjectLoop(): void {
    stopSessionDaemonInjectLoop(this);
  }

  private startSessionDaemonInjectLoop(): void {
    startSessionDaemonInjectLoop(this);
  }

  private async tickSessionDaemonInjectLoop(): Promise<void> {
    await tickSessionDaemonInjectLoop(this);
  }

  public async initialize(): Promise<void> {
    await initializeHttpServer(this);
  }

  private async restartRuntimeFromDisk(): Promise<{ reloadedAt: number; configPath: string; warnings?: string[] }> {
    return await restartRuntimeFromDisk(this);
  }

  /**
   * Get the port registry for multi-port management.
   */
  public getPortRegistry(): PortRegistry {
    return this.portRegistry;
  }

  /**
   * Get port configurations from the server config.
   */
  public getPortConfigs(): PortConfig[] {
    const rootRecord =
      this.userConfig && typeof this.userConfig === 'object'
        ? (this.userConfig as Record<string, unknown>)
        : {};
    const rawHttpserver =
      rootRecord.httpserver && typeof rootRecord.httpserver === 'object'
        ? (rootRecord.httpserver as Record<string, unknown>)
        : {};
    if (Array.isArray(rawHttpserver.ports) && rawHttpserver.ports.length > 0) {
      return normalizePortsConfig(rawHttpserver);
    }
    return normalizePortsConfig({
      ...rawHttpserver,
      port: this.config.server.port,
      host: this.config.server.host,
      apikey: this.config.server.apikey,
    });
  }

  public getPortConfigForLocalPort(localPort?: number): PortConfig | undefined {
    if (typeof localPort !== 'number' || !Number.isFinite(localPort)) {
      return undefined;
    }
    return this.portRegistry.get(localPort)?.config
      ?? this.getPortConfigs().find((config) => config.port === localPort);
  }

  public getAvailableProviders(): Array<{ key: string; family?: string; protocol?: string }> {
    const items = new Map<string, { key: string; family?: string; protocol?: string }>();
    for (const [providerKey, runtimeKey] of this.providerKeyToRuntimeKey.entries()) {
      const handle = this.providerHandles.get(runtimeKey);
      items.set(providerKey, {
        key: providerKey,
        family: handle?.providerFamily,
        protocol: handle?.providerProtocol,
      });
    }
    if (items.size === 0 && this.currentRouterArtifacts?.targetRuntime) {
      for (const runtime of Object.values(this.currentRouterArtifacts.targetRuntime)) {
        const runtimeRecord = runtime as unknown as Record<string, unknown>;
        const providerKey =
          typeof runtimeRecord.providerKey === 'string' && runtimeRecord.providerKey.trim()
            ? runtimeRecord.providerKey.trim()
            : undefined;
        if (!providerKey || items.has(providerKey)) {
          continue;
        }
        items.set(providerKey, {
          key: providerKey,
          family:
            typeof runtimeRecord.providerFamily === 'string' && runtimeRecord.providerFamily.trim()
              ? runtimeRecord.providerFamily.trim()
              : undefined,
          protocol:
            typeof runtimeRecord.providerProtocol === 'string' && runtimeRecord.providerProtocol.trim()
              ? runtimeRecord.providerProtocol.trim()
              : undefined,
        });
      }
    }
    if (this.currentRouterArtifacts?.config && typeof this.currentRouterArtifacts.config === 'object') {
      const configRecord = this.currentRouterArtifacts.config as Record<string, unknown>;
      const providersNode =
        configRecord.providers && typeof configRecord.providers === 'object'
          ? (configRecord.providers as Record<string, unknown>)
          : undefined;
      if (providersNode) {
        for (const [providerKey, providerRaw] of Object.entries(providersNode)) {
          if (items.has(providerKey) || !providerKey.trim()) {
            continue;
          }
          const providerRecord =
            providerRaw && typeof providerRaw === 'object'
              ? (providerRaw as Record<string, unknown>)
              : {};
          const runtimeKey =
            typeof providerRecord.runtimeKey === 'string' && providerRecord.runtimeKey.trim()
              ? providerRecord.runtimeKey.trim()
              : undefined;
          const handle = runtimeKey ? this.providerHandles.get(runtimeKey) : undefined;
          items.set(providerKey, {
            key: providerKey,
            family:
              handle?.providerFamily
              ?? (typeof providerRecord.providerType === 'string' ? providerRecord.providerType : undefined),
            protocol:
              handle?.providerProtocol
              ?? (typeof providerRecord.outboundProfile === 'string' ? providerRecord.outboundProfile : undefined),
          });
        }
      }
    }
    if (items.size === 0 && this.userConfig && typeof this.userConfig === 'object') {
      const rootRecord = this.userConfig as Record<string, unknown>;
      const virtualRouterNode =
        rootRecord.virtualrouter && typeof rootRecord.virtualrouter === 'object'
          ? (rootRecord.virtualrouter as Record<string, unknown>)
          : undefined;
      const providersNode =
        virtualRouterNode?.providers && typeof virtualRouterNode.providers === 'object'
          ? (virtualRouterNode.providers as Record<string, unknown>)
          : undefined;
      if (providersNode) {
        for (const [providerId, providerRaw] of Object.entries(providersNode)) {
          const providerRecord =
            providerRaw && typeof providerRaw === 'object'
              ? (providerRaw as Record<string, unknown>)
              : {};
          const providerType =
            typeof providerRecord.type === 'string' && providerRecord.type.trim()
              ? providerRecord.type.trim()
              : undefined;
          const modelsNode =
            providerRecord.models && typeof providerRecord.models === 'object'
              ? (providerRecord.models as Record<string, unknown>)
              : undefined;
          if (modelsNode && Object.keys(modelsNode).length > 0) {
            for (const modelId of Object.keys(modelsNode)) {
              if (!modelId.trim()) {
                continue;
              }
              const providerKey = `${providerId}.${modelId.trim()}`;
              if (items.has(providerKey)) {
                continue;
              }
              items.set(providerKey, {
                key: providerKey,
                family: providerType,
                protocol: providerType ? mapProviderProtocol(providerType) : undefined,
              });
            }
            continue;
          }
          if (!items.has(providerId)) {
            items.set(providerId, {
              key: providerId,
              family: providerType,
              protocol: providerType ? mapProviderProtocol(providerType) : undefined,
            });
          }
        }
      }
    }
    return [...items.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  public async applyPortConfig(
    action: 'add' | 'update' | 'remove',
    port: number,
    config?: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const currentConfigs = this.getPortConfigs();
      const preserved = currentConfigs.filter((candidate) => candidate.port !== port);
      let nextPortConfig: PortConfig | undefined;

      if (action !== 'remove') {
        if (!config || typeof config !== 'object') {
          return { ok: false, error: 'Port config is required for add/update' };
        }
        nextPortConfig = { ...(config as unknown as PortConfig), port };
        const validation = validatePortConfigs([...preserved, nextPortConfig]);
        if (!validation.valid) {
          return {
            ok: false,
            error: validation.errors.map((item) => `${item.field}: ${item.message}`).join('; '),
          };
        }
        if (
          nextPortConfig.mode === 'provider'
          && nextPortConfig.providerBinding
          && !this.getAvailableProviders().some((item) => item.key === nextPortConfig!.providerBinding)
        ) {
          return {
            ok: false,
            error: `Provider binding not found: ${nextPortConfig.providerBinding}`,
          };
        }
      }

      const nextConfigs = nextPortConfig
        ? [...preserved, nextPortConfig].sort((a, b) => a.port - b.port)
        : preserved.sort((a, b) => a.port - b.port);

      this.writePortConfigsToUserConfig(nextConfigs);

      if (action === 'remove') {
        await this.portRegistry.removePort(port);
        return { ok: true };
      }

      if (this.portRegistry.has(port)) {
        await this.portRegistry.removePort(port);
      }
      await this.startPortListener(nextPortConfig!);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  public async start(): Promise<void> {
    await startHttpServer(this);
    // Start the session reaper after server is running
    startSessionReaper();
  }

  public async stop(): Promise<void> {
    stopSessionReaper();
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

  /**
   * Seed raw user config before listener start so multi-port bootstrap can read httpserver.ports.
   * This only sets config snapshot and does not initialize runtime/provider state.
   */
  public seedUserConfigForBootstrap(userConfig: UnknownObject): void {
    if (userConfig && typeof userConfig === 'object') {
      this.userConfig = structuredClone(userConfig);
    }
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

  private buildHandlerContext(req: Request): HandlerContext {
    return buildHttpHandlerContext(this, req);
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
    return await this.requestExecutor.execute(input);
  }

  private resolveRuntimeKeyForProviderBinding(bindingKey?: string): string | undefined {
    if (!bindingKey) {
      return undefined;
    }
    if (this.providerKeyToRuntimeKey.has(bindingKey)) {
      return this.providerKeyToRuntimeKey.get(bindingKey);
    }
    if (this.providerHandles.has(bindingKey)) {
      return bindingKey;
    }
    const scopedPrefix = `${bindingKey}.`;
    for (const runtimeKey of this.providerHandles.keys()) {
      if (runtimeKey === bindingKey || runtimeKey.startsWith(scopedPrefix)) {
        return runtimeKey;
      }
    }
    return undefined;
  }

  private resolveProviderHandleForBinding(bindingKey?: string): ProviderHandle | undefined {
    const runtimeKey = this.resolveRuntimeKeyForProviderBinding(bindingKey);
    return runtimeKey ? this.providerHandles.get(runtimeKey) : undefined;
  }

  private writePortConfigsToUserConfig(configs: PortConfig[]): void {
    if (!this.userConfig || typeof this.userConfig !== 'object') {
      this.userConfig = {};
    }
    const rootRecord = this.userConfig as Record<string, unknown>;
    const httpserver =
      rootRecord.httpserver && typeof rootRecord.httpserver === 'object'
        ? (rootRecord.httpserver as Record<string, unknown>)
        : {};
    rootRecord.httpserver = httpserver;
    httpserver.ports = configs.map((config) => ({ ...config }));
    if (configs.length > 0) {
      httpserver.port = configs[0].port;
      httpserver.host = configs[0].host;
      if (typeof configs[0].apikey === 'string' && configs[0].apikey.trim()) {
        httpserver.apikey = configs[0].apikey.trim();
      }
    }
  }

  private async startPortListener(portConfig: PortConfig): Promise<Server> {
    return await new Promise<Server>((resolve, reject) => {
      const listener = this.app.listen(portConfig.port, portConfig.host, () => {
        const boundAddress = listener.address();
        const boundPort =
          boundAddress && typeof boundAddress === 'object' && typeof boundAddress.port === 'number'
            ? boundAddress.port
            : portConfig.port;
        const runtimeConfig = boundPort === portConfig.port ? portConfig : { ...portConfig, port: boundPort };
        this.portRegistry.attachServer(boundPort, runtimeConfig, listener, this.app);
        if (!this.server) {
          this.server = listener;
          this.config.server.port = boundPort;
          this.config.server.host = runtimeConfig.host;
          process.env.ROUTECODEX_SERVER_PORT = String(boundPort);
        }
        console.log(
          `[RouteCodexHttpServer] Port listener started on ${runtimeConfig.host}:${boundPort} mode=${runtimeConfig.mode}`
        );
        resolve(listener);
      });

      if (process.env.JEST_WORKER_ID || process.env.NODE_ENV === 'test') {
        try {
          (listener as unknown as { unref?: () => void }).unref?.();
        } catch {
          // Ignore test-only unref failures.
        }
      }

      listener.on('connection', (socket: Socket) => {
        this.activeSockets.add(socket);
        socket.on('close', () => {
          this.activeSockets.delete(socket);
        });
      });

      listener.on('error', (error: Error) => {
        reject(error);
      });
    });
  }

  private async executePortAwarePipeline(
    localPort: number | undefined,
    input: PipelineExecutionInput,
  ): Promise<PipelineExecutionResult> {
    const portConfig = this.getPortConfigForLocalPort(localPort);

    // Build per-port metadata: routecodexLocalPort + mode always present.
    // Router ports: inject allowedProviders derived from routingPolicyGroup to
    // restrict routing to that group'''s provider pool (replaces global active group).
    let allowedProviders: string[] | undefined;
    if (portConfig?.mode === 'router' && portConfig.routingPolicyGroup) {
      allowedProviders = extractProviderKeysForRoutingGroup(this.userConfig, portConfig.routingPolicyGroup);
    }

    const metadata = {
      ...(input.metadata ?? {}),
      routecodexLocalPort: localPort,
      routecodexPortMode: portConfig?.mode ?? 'router',
      routecodexPortBinding: portConfig?.providerBinding,
      ...(allowedProviders ? { allowedProviders } : {}),
    };
    const nextInput: PipelineExecutionInput = {
      ...input,
      metadata,
    };
    if (!portConfig || portConfig.mode === 'router') {
      return await this.executePipeline(nextInput);
    }
    return await this.executeProviderDirectPipelineForPort(portConfig, nextInput);
  }

  private async executeProviderDirectPipelineForPort(
    portConfig: PortConfig,
    input: PipelineExecutionInput,
  ): Promise<PipelineExecutionResult> {
    const payload =
      input.body && typeof input.body === 'object'
        ? ({ ...(input.body as Record<string, unknown>) })
        : {};
    const providerBinding = portConfig.providerBinding;
    const runtimeKey = this.resolveRuntimeKeyForProviderBinding(providerBinding);
    this.logStage('port_pipeline.dispatch', input.requestId, {
      port: portConfig.port,
      mode: portConfig.mode,
      providerBinding,
      runtimeKey,
      entryEndpoint: input.entryEndpoint,
    });
    const directResult = await executeProviderDirectPipeline(
      payload,
      {
        path: input.entryEndpoint,
        headers: input.headers as Record<string, string | string[] | undefined>,
      },
      {
        portConfig,
        resolveProvider: (bindingKey: string) => this.resolveProviderHandleForBinding(bindingKey),
        detectInboundProtocol: detectInboundProtocolFromRequest,
        preparePayload: (providerPayload, context) => {
          const handle = this.resolveProviderHandleForBinding(context.providerKey);
          if (!handle) {
            throw new Error(`Provider not found for binding: ${context.providerKey}`);
          }
          applyRouteParamsToProviderPayload(providerPayload, input.metadata);
          attachProviderRuntimeMetadata(providerPayload, {
            requestId: input.requestId,
            providerId: handle.providerId,
            providerKey: context.providerKey,
            providerType: handle.providerType,
            providerFamily: handle.providerFamily,
            providerProtocol: handle.providerProtocol,
            pipelineId: context.providerKey,
            runtimeKey: this.resolveRuntimeKeyForProviderBinding(context.providerKey),
            metadata: input.metadata,
            compatibilityProfile: handle.runtime?.compatibilityProfile,
          });
        },
        onSnapshotBefore: (_providerPayload, context) => {
          this.logStage('provider-direct.send.start', input.requestId, {
            port: context.port,
            providerKey: context.providerKey,
            protocol: context.protocol,
          });
        },
        onSnapshotAfter: (response, context) => {
          const responseRecord =
            response && typeof response === 'object' ? (response as Record<string, unknown>) : undefined;
          this.logStage('provider-direct.send.completed', input.requestId, {
            port: context.port,
            providerKey: context.providerKey,
            protocol: context.protocol,
            status:
              typeof responseRecord?.status === 'number'
                ? responseRecord.status
                : undefined,
          });
        },
      },
    );

    const normalized = normalizeProviderResponse(directResult.response);
    const converted = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: input.entryEndpoint,
        providerProtocol: directResult.providerProtocol,
        providerType: directResult.providerHandle.providerType,
        requestId: input.requestId,
        serverToolsEnabled: false,
        wantsStream: Boolean(input.metadata?.inboundStream ?? input.metadata?.stream),
        originalRequest: payload,
        processMode: 'passthrough',
        response: normalized,
        pipelineMetadata: input.metadata,
      },
      {
        runtimeManager: {
          resolveRuntimeKey: (providerKey?: string, fallback?: string): string | undefined =>
            this.resolveRuntimeKeyForProviderBinding(providerKey) ?? fallback,
          getHandleByRuntimeKey: (runtimeKey?: string): ProviderHandle | undefined =>
            runtimeKey ? this.providerHandles.get(runtimeKey) : undefined,
        },
        executeNested: async (nestedInput: PipelineExecutionInput): Promise<PipelineExecutionResult> =>
          await this.executePortAwarePipeline(portConfig.port, nestedInput),
      },
    );
    const usage = extractUsageFromResult(converted, input.metadata);
    const finishReason =
      converted.body && typeof converted.body === 'object'
        ? deriveFinishReason(converted.body as Record<string, unknown>)
        : undefined;
    return {
      ...converted,
      usageLogInfo: {
        ...(converted.usageLogInfo ?? {}),
        providerKey: providerBinding,
        model: this.extractProviderModel(payload),
        routeName: 'port.provider-direct',
        finishReason,
        usage: usage ? (usage as Record<string, unknown>) : undefined,
        requestStartedAtMs: Date.now(),
      },
    };
  }

  private async initializeRouteErrorHub(): Promise<void> {
    await initializeRouteErrorHub(this);
  }
}
function applyRouteParamsToProviderPayload(payload: Record<string, unknown>, metadata?: Record<string, unknown>): void {
  const routeParams = metadata?.routeParams;
  if (!routeParams || typeof routeParams !== 'object' || Array.isArray(routeParams)) {
    return;
  }
  for (const [key, value] of Object.entries(routeParams as Record<string, unknown>)) {
    if (key === 'reasoningEffort') {
      payload.reasoning_effort = value;
      continue;
    }
    payload[key] = value;
  }
}
