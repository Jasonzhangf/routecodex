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
import {
  executeRouterDirectPipeline,
  type RouterDirectAuditContext,
  type RouterDirectOutcome,
  type RouterDirectResult,
} from './router-direct-pipeline.js';
import {
  applyMinimalDirectOverrides,
  resolveRawPayloadForDirect,
} from './direct-passthrough-payload.js';
import { normalizeProviderResponse } from './executor/provider-response-utils.js';
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
import { runHubPipeline } from './executor-pipeline.js';
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
          const debugQwenchat = typeof providerKey === 'string' && providerKey.startsWith('qwenchat.');
          if (providerKey && this.providerKeyToRuntimeKey.has(providerKey)) {
            const mapped = this.providerKeyToRuntimeKey.get(providerKey);
            if (mapped && this.providerHandles.has(mapped)) {
              if (debugQwenchat) {
                console.warn(`[runtime.resolve.debug] providerKey=${providerKey} mapped=${mapped} direct_hit=true`);
              }
              return mapped;
            }
            if (mapped) {
              const normalizedMapped = mapped.replace(/\.key(\d+)(?=\.|$)/gi, '.$1');
              if (normalizedMapped !== mapped && this.providerHandles.has(normalizedMapped)) {
                if (debugQwenchat) {
                  console.warn(`[runtime.resolve.debug] providerKey=${providerKey} mapped=${mapped} normalized_hit=${normalizedMapped}`);
                }
                return normalizedMapped;
              }
              const denormalizedMapped = mapped.replace(/\.(\d+)(?=\.|$)/g, '.key$1');
              if (denormalizedMapped !== mapped && this.providerHandles.has(denormalizedMapped)) {
                if (debugQwenchat) {
                  console.warn(`[runtime.resolve.debug] providerKey=${providerKey} mapped=${mapped} denormalized_hit=${denormalizedMapped}`);
                }
                return denormalizedMapped;
              }
            }
          }
          if (providerKey) {
            const parts = providerKey.split('.');
            if (parts.length >= 3) {
              const providerId = parts[0];
              const alias = parts[1];
              const aliasNormalized = alias.replace(/^key(\d+)$/i, '$1');
              const aliasDenormalized = alias.match(/^\d+$/) ? `key${alias}` : alias;
              const directNormalizedRuntime = `${providerId}.${aliasNormalized}`;
              if (this.providerHandles.has(directNormalizedRuntime)) {
                if (debugQwenchat) {
                  console.warn(`[runtime.resolve.debug] providerKey=${providerKey} direct_normalized_runtime=${directNormalizedRuntime}`);
                }
                return directNormalizedRuntime;
              }
              const directDenormalizedRuntime = `${providerId}.${aliasDenormalized}`;
              if (this.providerHandles.has(directDenormalizedRuntime)) {
                if (debugQwenchat) {
                  console.warn(`[runtime.resolve.debug] providerKey=${providerKey} direct_denormalized_runtime=${directDenormalizedRuntime}`);
                }
                return directDenormalizedRuntime;
              }
            }
            const normalizedProviderKey = providerKey.replace(/\.key(\d+)(?=\.|$)/gi, '.$1');
            if (normalizedProviderKey !== providerKey && this.providerKeyToRuntimeKey.has(normalizedProviderKey)) {
              const mapped = this.providerKeyToRuntimeKey.get(normalizedProviderKey);
              if (mapped && this.providerHandles.has(mapped)) {
                return mapped;
              }
              if (mapped) {
                const normalizedMapped = mapped.replace(/\.key(\d+)(?=\.|$)/gi, '.$1');
                if (this.providerHandles.has(normalizedMapped)) {
                  return normalizedMapped;
                }
              }
            }
            const denormalizedProviderKey = providerKey.replace(/\.(\d+)(?=\.|$)/g, '.key$1');
            if (denormalizedProviderKey !== providerKey && this.providerKeyToRuntimeKey.has(denormalizedProviderKey)) {
              const mapped = this.providerKeyToRuntimeKey.get(denormalizedProviderKey);
              if (mapped && this.providerHandles.has(mapped)) {
                return mapped;
              }
              if (mapped) {
                const denormalizedMapped = mapped.replace(/\.(\d+)(?=\.|$)/g, '.key$1');
                if (this.providerHandles.has(denormalizedMapped)) {
                  return denormalizedMapped;
                }
              }
            }
          }
          if (debugQwenchat) {
            const mappedKeys = Array.from(this.providerKeyToRuntimeKey.keys()).filter((k) => k.startsWith('qwenchat.')).slice(0, 20);
            const handleKeys = Array.from(this.providerHandles.keys()).filter((k) => k.startsWith('qwenchat.')).slice(0, 20);
            const qwenMappedKeys = Array.from(this.providerKeyToRuntimeKey.keys()).filter((k) => k.startsWith('qwen.')).slice(0, 20);
            const qwenHandleKeys = Array.from(this.providerHandles.keys()).filter((k) => k.startsWith('qwen.')).slice(0, 20);
            console.warn(
              `[runtime.resolve.debug] providerKey=${providerKey} miss fallback=${fallback ?? 'undefined'} mapKeys=${JSON.stringify(mappedKeys)} handleKeys=${JSON.stringify(handleKeys)} qwenMapKeys=${JSON.stringify(qwenMappedKeys)} qwenHandleKeys=${JSON.stringify(qwenHandleKeys)}`
            );
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
          const normalizedRuntimeKey = runtimeKey.replace(/\.key(\d+)(?=\.|$)/gi, '.$1');
          if (normalizedRuntimeKey !== runtimeKey) {
            const normalizedDirect = this.providerHandles.get(normalizedRuntimeKey);
            if (normalizedDirect) {
              return normalizedDirect;
            }
          }
          const denormalizedRuntimeKey = runtimeKey.replace(/\.(\d+)(?=\.|$)/g, '.key$1');
          if (denormalizedRuntimeKey !== runtimeKey) {
            const denormalizedDirect = this.providerHandles.get(denormalizedRuntimeKey);
            if (denormalizedDirect) {
              return denormalizedDirect;
            }
          }
          const runtimeKeyParts = runtimeKey.split('.');
          if (runtimeKeyParts.length === 2) {
            const aliasScopedPrefix = `${runtimeKeyParts[0]}.${runtimeKeyParts[1]}.`;
            for (const [candidateKey, handle] of this.providerHandles.entries()) {
              if (candidateKey.startsWith(aliasScopedPrefix)) {
                return handle;
              }
            }
            const normalizedAliasScopedPrefix = aliasScopedPrefix.replace(/\.key(\d+)\./i, '.$1.');
            if (normalizedAliasScopedPrefix !== aliasScopedPrefix) {
              for (const [candidateKey, handle] of this.providerHandles.entries()) {
                if (candidateKey.startsWith(normalizedAliasScopedPrefix)) {
                  return handle;
                }
              }
            }
          }
          return undefined;
        }
      },
      getHubPipeline: () => this.hubPipeline,
      getModuleDependencies: () => this.getModuleDependencies(),
      executeNestedInput: (nestedInput) => this.executePortAwarePipeline(
        typeof nestedInput.metadata?.routecodexLocalPort === 'number'
          ? nestedInput.metadata.routecodexLocalPort
          : undefined,
        nestedInput
      ),
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

  private async resolveVirtualRouterInput(userConfig: UnknownObject): Promise<UnknownObject> {
    return await resolveVirtualRouterInput(this, userConfig);
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
    const normalizedBinding = bindingKey.trim();
    if (!normalizedBinding) {
      return undefined;
    }
    if (this.providerKeyToRuntimeKey.has(normalizedBinding)) {
      return this.providerKeyToRuntimeKey.get(normalizedBinding);
    }
    if (this.providerHandles.has(normalizedBinding)) {
      return normalizedBinding;
    }
    const scopedPrefix = `${normalizedBinding}.`;
    for (const runtimeKey of this.providerHandles.keys()) {
      if (runtimeKey === normalizedBinding || runtimeKey.startsWith(scopedPrefix)) {
        return runtimeKey;
      }
    }
    if (normalizedBinding.includes('.')) {
      const lastDot = normalizedBinding.lastIndexOf('.');
      const modelSuffix = `.${normalizedBinding.slice(lastDot + 1)}`;
      for (const runtimeKey of this.providerHandles.keys()) {
        if (runtimeKey.endsWith(modelSuffix) && runtimeKey.startsWith(normalizedBinding.slice(0, lastDot))) {
          return runtimeKey;
        }
      }
      const parentBinding = normalizedBinding.slice(0, lastDot);
      if (parentBinding && parentBinding !== normalizedBinding) {
        const parentResolved = this.resolveRuntimeKeyForProviderBinding(parentBinding);
        if (parentResolved) {
          return parentResolved;
        }
      }
    }
    const segments = normalizedBinding.split('.').map((part) => part.trim()).filter(Boolean);
    if (segments.length >= 3) {
      const providerId = segments[0];
      const alias = segments[1];
      const normalizedModel = segments[segments.length - 1].replace(/[-_]/g, '').toLowerCase();
      for (const runtimeKey of this.providerHandles.keys()) {
        const runtimeSegments = runtimeKey.split('.').map((part) => part.trim()).filter(Boolean);
        if (runtimeSegments.length < 2 || runtimeSegments[0] !== providerId) {
          continue;
        }
        if (!runtimeSegments.includes(alias)) {
          continue;
        }
        const runtimeTail = runtimeSegments[runtimeSegments.length - 1].replace(/[-_]/g, '').toLowerCase();
        if (runtimeTail === normalizedModel) {
          return runtimeKey;
        }
      }
      for (const runtimeKey of this.providerHandles.keys()) {
        const runtimeSegments = runtimeKey.split('.').map((part) => part.trim()).filter(Boolean);
        if (runtimeSegments[0] === providerId && runtimeSegments.includes(alias)) {
          return runtimeKey;
        }
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

    // stopMessage 默认启用（true），除非端口显式配置 enabled=false
    const effectiveStopMessageEnabled = typeof portConfig?.stopMessage?.enabled === 'boolean'
      ? portConfig.stopMessage.enabled
      : true;

    const metadata = {
      ...(input.metadata ?? {}),
      routecodexLocalPort: localPort,
      routecodexPortMode: portConfig?.mode ?? 'router',
      routecodexPortBinding: portConfig?.providerBinding,
      routecodexRoutingPolicyGroup: portConfig?.routingPolicyGroup,
      stopMessageEnabled: effectiveStopMessageEnabled,
      routecodexPortStopMessageEnabled: effectiveStopMessageEnabled,
      ...(allowedProviders ? { allowedProviders } : {}),
    };
    const nextInput: PipelineExecutionInput = {
      ...input,
      metadata,
    };
    if (!portConfig || portConfig.mode === 'router') {
      // For router-mode ports with sameProtocolBehavior='direct', check same-protocol
      // direct bypass before falling through to the full executor pipeline.
      if (portConfig?.mode === 'router' && (portConfig.sameProtocolBehavior ?? 'direct') === 'direct') {
        const directResult = await this.executeRouterDirectPipelineForPort(portConfig, nextInput);
        if (directResult.used) {
          return this.buildRouterDirectResult(directResult, input);
        }
        // same-protocol direct not applicable, fall through to normal pipeline
      }
      return await this.executePipeline(nextInput);
    }

    const handle = this.resolveProviderHandleForBinding(portConfig.providerBinding);
    if (!handle) {
      throw new Error(`Provider not found for binding: ${portConfig.providerBinding ?? ''}`);
    }
    const inboundProtocol = detectInboundProtocolFromRequest({
      path: input.entryEndpoint,
      headers: input.headers as Record<string, string | string[] | undefined>,
    });
    const behavior = portConfig.protocolBehavior ?? 'auto';
    const shouldUseDirect =
      behavior === 'direct' || (behavior === 'auto' && inboundProtocol === handle.providerProtocol);
    if (shouldUseDirect) {
      return await this.executeProviderDirectPipelineForPort(portConfig, nextInput);
    }

    return await this.executePipeline({
      ...nextInput,
      metadata: {
        ...(nextInput.metadata ?? {}),
        allowedProviders: [portConfig.providerBinding].filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
        routecodexProviderRelayBinding: portConfig.providerBinding,
        routecodexProviderRelayProtocol: handle.providerProtocol,
      },
    });
  }


  /**
   * Router-Direct Pipeline: runs Hub Pipeline routing, then checks same-protocol
   * direct eligibility. If the inbound and provider protocols match, bypasses the
   * full executor pipeline and sends directly via provider.processIncoming.
   */
  private async executeRouterDirectPipelineForPort(
    portConfig: PortConfig,
    input: PipelineExecutionInput,
  ): Promise<RouterDirectOutcome> {
    const hubPipeline = this.hubPipeline;
    if (!hubPipeline) {
      this.logStage('router-direct.skipped', input.requestId, { reason: 'hub-pipeline-not-ready' });
      return { used: false, reason: 'hub-pipeline-not-ready' };
    }

    const allowedProviders =
      portConfig.routingPolicyGroup
        ? extractProviderKeysForRoutingGroup(this.userConfig, portConfig.routingPolicyGroup)
        : undefined;

    const metadataForHub = {
      ...(input.metadata ?? {}),
      routecodexLocalPort: portConfig.port,
      routecodexPortMode: portConfig.mode,
      routecodexPortBinding: portConfig.providerBinding,
      routecodexRoutingPolicyGroup: portConfig.routingPolicyGroup,
      ...(allowedProviders && allowedProviders.length > 0 ? { allowedProviders } : {}),
    };

    // Run Hub Pipeline to get routing decision (preserves routing truth source)
    let pipelineResult: Awaited<ReturnType<typeof runHubPipeline>>;
    try {
      pipelineResult = await runHubPipeline(hubPipeline, input, metadataForHub);
    } catch (error) {
      this.logStage('router-direct.hub_pipeline_failed', input.requestId, {
        error: error instanceof Error ? error.message : String(error),
      });
      return { used: false, reason: `hub-pipeline-failed: ${error instanceof Error ? error.message : String(error)}` };
    }

    const { target, providerPayload, routingDecision, processMode } = pipelineResult;

    if (!target || !target.providerKey) {
      this.logStage('router-direct.skipped', input.requestId, { reason: 'no-target-from-router' });
      return { used: false, reason: 'no-target-from-router' };
    }

    const requestPayload = applyMinimalDirectOverrides(
      resolveRawPayloadForDirect(input.body, input.metadata),
      {
        providerPayload,
        routeParams:
          input.metadata?.routeParams && typeof input.metadata.routeParams === 'object' && !Array.isArray(input.metadata.routeParams)
            ? (input.metadata.routeParams as Record<string, unknown>)
            : undefined,
      },
    );
    // Try the router-direct pipeline
    let directOutcome: RouterDirectOutcome = { used: false, reason: 'uninitialized' };
    const maxDirectAttempts = 2;
    for (let directAttempt = 1; directAttempt <= maxDirectAttempts; directAttempt += 1) {
      directOutcome = await executeRouterDirectPipeline({
        portConfig,
        providerPayload,
        requestPayload,
        target: {
          providerKey: target.providerKey,
          providerType: target.providerType,
          runtimeKey: target.runtimeKey,
          processMode: target.processMode,
        },
        routingDecision,
        processMode,
        requestInfo: {
          path: input.entryEndpoint,
          headers: input.headers as Record<string, string | string[] | undefined>,
        },
        resolveProviderByRuntimeKey: (runtimeKey?: string) => {
          if (!runtimeKey) return undefined;
          return this.providerHandles.get(runtimeKey);
        },
        onSnapshotBefore: (payload, ctx) => {
          this.logStage('router-direct.send.start', input.requestId, {
            port: portConfig.port,
            providerKey: ctx.providerKey,
            inboundProtocol: ctx.inboundProtocol,
            providerProtocol: ctx.providerProtocol,
            routeName: ctx.routingDecision?.routeName,
            observedFields: ctx.observedFields,
            directAttempt,
          });
        },
        onSnapshotAfter: (response, ctx) => {
          const responseRecord =
            response && typeof response === 'object' ? (response as Record<string, unknown>) : undefined;
          this.logStage('router-direct.send.completed', input.requestId, {
            port: portConfig.port,
            providerKey: ctx.providerKey,
            inboundProtocol: ctx.inboundProtocol,
            providerProtocol: ctx.providerProtocol,
            routeName: ctx.routingDecision?.routeName,
            status: typeof responseRecord?.status === 'number' ? responseRecord.status : undefined,
            observedFields: ctx.observedFields,
            directAttempt,
          });
        },
      });
      if (!directOutcome.used) {
        break;
      }
      const normalizedDirectResponse = normalizeProviderResponse(directOutcome.response);
      if (!this.isRecoverableRouterDirectHttp502(normalizedDirectResponse) || directAttempt >= maxDirectAttempts) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200 * directAttempt));
    }

    if (!directOutcome.used) {
      this.logStage('router-direct.skipped', input.requestId, { reason: directOutcome.reason });
      return { used: false, reason: directOutcome.reason };
    }

    return {
      used: true,
      response: directOutcome.response,
      providerHandle: directOutcome.providerHandle,
      auditContext: directOutcome.auditContext,
    };
  }

  private isRecoverableRouterDirectHttp502(response: PipelineExecutionResult): boolean {
    if (!response || typeof response !== 'object') {
      return false;
    }
    if (response.status !== 502) {
      return false;
    }
    const body = response.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return false;
    }
    const error = (body as Record<string, unknown>).error;
    if (!error || typeof error !== 'object' || Array.isArray(error)) {
      return false;
    }
    return String((error as Record<string, unknown>).code || '').trim().toUpperCase() === 'HTTP_502';
  }

  /**
   * Build a PipelineExecutionResult from a router-direct outcome.
   * Response is passed through without outbound rewriting.
   */
  private async buildRouterDirectResult(directResult: RouterDirectResult, input: PipelineExecutionInput): Promise<PipelineExecutionResult> {
    const { response, providerHandle, auditContext } = directResult;

    const normalized = normalizeProviderResponse(response);
    const usage = extractUsageFromResult(normalized, {
      ...(input.metadata ?? {}),
      providerProtocol: providerHandle.providerProtocol,
      providerType: providerHandle.providerType,
      providerKey: auditContext.providerKey
    });
    const requestModel =
      input.body && typeof input.body === 'object' && typeof (input.body as any).model === 'string'
        ? ((input.body as any).model as string)
        : undefined;
    const finishReason =
      normalized.body && typeof normalized.body === 'object'
        ? deriveFinishReason(normalized.body as Record<string, unknown>)
        : undefined;
    if (requestModel && normalized.body && typeof normalized.body === 'object' && !Array.isArray(normalized.body)) {
      try {
        (normalized.body as Record<string, unknown>).model = requestModel;
      } catch {
        // ignore model rewrite failures
      }
    }

    // Response is passed through without outbound rewriting
    return {
      ...normalized,
      metadata:
        input.metadata && typeof input.metadata === 'object'
          ? { ...(input.metadata as Record<string, unknown>) }
          : normalized.metadata,
      usageLogInfo: {
        ...normalized.usageLogInfo ?? {},
        providerKey: auditContext.providerKey,
        model: requestModel,
        routeName: `router-direct:${auditContext.routingDecision?.routeName ?? 'unknown'}`,
        finishReason,
        usage: usage ? (usage as Record<string, unknown>) : undefined,
        requestStartedAtMs: Date.now(),
      },
    };
  }

  /**
   * Build a PipelineExecutionResult from a provider-direct outcome.
   * Contract: provider-mode direct must not re-enter response conversion/chat-process.
   * Only transport normalization + usage extraction/log decoration are allowed here.
   */
  private async buildProviderDirectResult(
    directResult: Awaited<ReturnType<typeof executeProviderDirectPipeline>>,
    input: PipelineExecutionInput,
    payload: Record<string, unknown>,
    providerBinding?: string,
  ): Promise<PipelineExecutionResult> {
    const normalized = normalizeProviderResponse(directResult.response);
    const usage = extractUsageFromResult(normalized, {
      ...(input.metadata ?? {}),
      providerProtocol: directResult.providerProtocol,
      providerType: directResult.providerHandle.providerType,
      providerKey: providerBinding
    });
    const requestModel =
      input.body && typeof input.body === 'object' && typeof (input.body as any).model === 'string'
        ? ((input.body as any).model as string)
        : undefined;
    const finishReason =
      normalized.body && typeof normalized.body === 'object'
        ? deriveFinishReason(normalized.body as Record<string, unknown>)
        : undefined;
    if (requestModel && normalized.body && typeof normalized.body === 'object' && !Array.isArray(normalized.body)) {
      try {
        (normalized.body as Record<string, unknown>).model = requestModel;
      } catch {
        // ignore model rewrite failures
      }
    }
    return {
      ...normalized,
      metadata:
        input.metadata && typeof input.metadata === 'object'
          ? { ...(input.metadata as Record<string, unknown>) }
          : normalized.metadata,
      usageLogInfo: {
        ...(normalized.usageLogInfo ?? {}),
        providerKey: providerBinding,
        model: requestModel ?? this.extractProviderModel(payload),
        routeName: 'port.provider-direct',
        finishReason,
        usage: usage ? (usage as Record<string, unknown>) : undefined,
        requestStartedAtMs: Date.now(),
      },
    };
  }

  private async executeProviderDirectPipelineForPort(
    portConfig: PortConfig,
    input: PipelineExecutionInput,
  ): Promise<PipelineExecutionResult> {
    const payload = applyMinimalDirectOverrides(
      resolveRawPayloadForDirect(input.body, input.metadata),
      {
        routeParams:
          input.metadata?.routeParams && typeof input.metadata.routeParams === 'object' && !Array.isArray(input.metadata.routeParams)
            ? (input.metadata.routeParams as Record<string, unknown>)
            : undefined,
      },
    );
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

    return await this.buildProviderDirectResult(
      directResult,
      input,
      payload,
      providerBinding,
    );
  }

  private async initializeRouteErrorHub(): Promise<void> {
    await initializeRouteErrorHub(this);
  }
}
