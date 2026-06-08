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
  HubPipelineConfig,
  HubPipeline,
  HubPipelineCtor,
  ProviderHandle,
  ServerConfigV2,
  ServerStatusV2,
  VirtualRouterArtifacts
} from './types.js';
import { createServerColoredLogger } from './colored-logger.js';
import { ManagerDaemon } from '../../../manager/index.js';
import { ensureServerScopedSessionDir, resolvePortScopedSessionDir } from './session-dir.js';
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
  assertDirectRouteDecision,
  evaluateDirectRouteDecision,
  resolveRawPayloadForDirect,
} from './direct-passthrough-payload.js';
import { normalizeProviderResponse } from './executor/provider-response-utils.js';
import { extractStatusCodeFromError } from './executor/utils.js';
import { resolveRequestExecutorProviderFailurePlan } from './executor/request-executor-provider-failure-plan.js';
import { extractRetryErrorSnapshot } from './executor/retry-payload-snapshot.js';
import { createRequestLocalTransientRetryTracker } from './executor/request-executor-transient-retry-tracker.js';
import { resolveMaxProviderAttempts } from './executor/retry-engine.js';
import { resolveHubShadowCompareConfig } from './hub-shadow-compare.js';
import { resolveLlmsEngineShadowConfig } from '../../../utils/llms-engine-shadow.js';
import { createRequestExecutor, type RequestExecutor } from './request-executor.js';
import {
  clearResponsesConversationByRequestId,
  finalizeResponsesConversationRequestRetention,
  recordResponsesResponseForRequest,
} from '../../../modules/llmswitch/bridge.js';
import { isPoolExhaustedPipelineError } from './executor/request-executor-core-utils.js';
import { RequestActivityTracker } from './request-activity-tracker.js';
import { getSessionExecutionStateTracker } from './session-execution-state.js';
import { startSessionReaper, stopSessionReaper } from './session-client-reaper.js';
import { QuietErrorHandlingCenter } from '../../../error-handling/quiet-error-handling-center.js';
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
  stopSessionDaemonInjectLoop
} from './http-server-session-daemon.js';
import { setupRuntime } from './http-server-runtime-setup.js';
import { buildVirtualRouterInputV2 } from '../../../config/virtual-router-builder.js';
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

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readRuntimeScopeFromMetadata(metadata: Record<string, unknown>): { sessionDir?: string; rccUserDir?: string } {
  const rt = metadata.__rt && typeof metadata.__rt === 'object' && !Array.isArray(metadata.__rt)
    ? (metadata.__rt as Record<string, unknown>)
    : undefined;
  return {
    sessionDir: readTrimmedString(rt?.sessionDir),
    rccUserDir: readTrimmedString(rt?.rccUserDir),
  };
}

function readSessionIdForUsageLog(metadata: Record<string, unknown>): string | undefined {
  return readTrimmedString(metadata.sessionId)
    ?? readTrimmedString(metadata.session_id)
    ?? readTrimmedString(metadata.clientTmuxSessionId)
    ?? readTrimmedString(metadata.client_tmux_session_id)
    ?? readTrimmedString(metadata.tmuxSessionId)
    ?? readTrimmedString(metadata.tmux_session_id);
}

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
import { mapErrorToPublicLogSummary } from '../../utils/http-error-mapper.js';
import { emitRequestExecutorProviderRetryTelemetry } from './executor/request-executor-retry-telemetry.js';
import {
  logProviderRetrySwitchCompact,
  REQUEST_EXECUTOR_NON_BLOCKING_LOG_THROTTLE_MS,
} from './executor/request-executor-runtime-blocks.js';
import {
  consumeSessionStormBackoffMs,
  isSessionStormBackoffCandidate,
  peekSessionStormBackoffWaitMs,
  resolveSessionStormBackoffScopes,
  waitSessionStormBackoffWithGate,
} from './executor/request-executor-session-storm-backoff.js';
import { getClientConnectionAbortSignal } from '../../utils/client-connection-state.js';

const ROUTER_DIRECT_PROVIDER_SWITCH_LOG_THROTTLE_MS = 5_000;
const routerDirectProviderSwitchLogState = new Map<string, { lastAtMs: number; suppressed: number }>();
const routerDirectNonBlockingLogState = new Map<string, number>();

type RouterDirectRetryState = {
  maxAttempts: number;
  excludedProviderKeys: Set<string>;
  transientRetryTracker: ReturnType<typeof createRequestLocalTransientRetryTracker>;
  retryProviderKey?: string;
  lastError?: unknown;
};

function createRouterDirectRetryState(input: PipelineExecutionInput): RouterDirectRetryState {
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  const excludedProviderKeys = new Set<string>(
    Array.isArray(metadata.excludedProviderKeys)
      ? metadata.excludedProviderKeys.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : []
  );
  return {
    maxAttempts: resolveMaxProviderAttempts(),
    excludedProviderKeys,
    transientRetryTracker: createRequestLocalTransientRetryTracker(),
  };
}

function logRouterDirectNonBlockingError(stage: string, error: unknown, details?: Record<string, unknown>): void {
  const now = Date.now();
  const last = routerDirectNonBlockingLogState.get(stage) ?? 0;
  if (now - last < REQUEST_EXECUTOR_NON_BLOCKING_LOG_THROTTLE_MS) {
    return;
  }
  routerDirectNonBlockingLogState.set(stage, now);
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
  console.warn(`[router-direct] ${stage} failed (non-blocking): ${message}${detailSuffix}`);
}

function asMetadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function buildRouterDirectFailureError(reason: unknown): Error {
  const message = typeof reason === 'string' && reason.trim() ? reason.trim() : String(reason ?? 'unknown');
  return new Error(`router-direct failed without relay: ${message}`);
}

function shouldRecordRouterDirectStorm(error: unknown, readableMessage?: string): boolean {
  if (isSessionStormBackoffCandidate(error)) {
    return true;
  }
  if (!readableMessage) {
    return false;
  }
  return isSessionStormBackoffCandidate(new Error(readableMessage));
}

export class RouteCodexHttpServer {
  private app: Application;
  private server?: Server;
  private activeSockets: Set<Socket> = new Set();
  private config: ServerConfigV2;
  private _isInitialized: boolean = false;
  private _isRunning: boolean = false;

  private hubPipeline: HubPipeline | null = null;
  private hubPipelinesByRoutingPolicyGroup: Map<string, HubPipeline> = new Map();
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
  private errorHandling = new QuietErrorHandlingCenter();
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
  private readonly serverId: string;

  constructor(config: ServerConfigV2) {
    this.config = config;
    this.app = express();
    (this.app.locals as Record<string, unknown>).routecodexServer = this;
    this.stageLoggingEnabled = isStageLoggingEnabled();
    this.repoRoot = resolveRepoRoot(import.meta.url);
    this.serverId = canonicalizeServerId(this.config.server.host, this.config.server.port);
    ensureServerScopedSessionDir(this.serverId);
    const sessionCleanup = cleanupSessionStorageOnStartup({ isTmuxSessionAlive });
    if (
      sessionCleanup.removedLegacyScopeFiles > 0 ||
      sessionCleanup.removedDeadTmuxStateFiles > 0 ||
      sessionCleanup.removedHeartbeatStateFiles > 0 ||
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
        resolveRuntimeKey: (providerKey?: string, fallback?: string, metadata?: Record<string, unknown>): string | undefined => {
          const tryVariants = (candidate: string | undefined): string | undefined => {
            if (!candidate) {
              return undefined;
            }
            const variants = [
              candidate,
              candidate.replace(/\.key(\d+)(?=\.|$)/gi, '.$1'),
              candidate.replace(/\.(\d+)(?=\.|$)/g, '.key$1')
            ].filter((value, index, arr) => typeof value === 'string' && value.trim() && arr.indexOf(value) === index) as string[];
            for (const variant of variants) {
              if (!this.isProviderVisibleInMetadataScope(variant, metadata)) {
                continue;
              }
              const mapped = this.providerKeyToRuntimeKey.get(variant);
              if (mapped && this.providerHandles.has(mapped) && this.isProviderVisibleInMetadataScope(mapped, metadata)) {
                return mapped;
              }
              if (mapped) {
                const mappedVariants = [
                  mapped,
                  mapped.replace(/\.key(\d+)(?=\.|$)/gi, '.$1'),
                  mapped.replace(/\.(\d+)(?=\.|$)/g, '.key$1')
                ].filter((value, index, arr) => typeof value === 'string' && value.trim() && arr.indexOf(value) === index) as string[];
                for (const mappedVariant of mappedVariants) {
                  if (this.providerHandles.has(mappedVariant) && this.isProviderVisibleInMetadataScope(mappedVariant, metadata)) {
                    return mappedVariant;
                  }
                }
              }
              if (this.providerHandles.has(variant) && this.isProviderVisibleInMetadataScope(variant, metadata)) {
                return variant;
              }
            }
            return undefined;
          };

          const direct = tryVariants(providerKey);
          if (direct) {
            return direct;
          }

          if (providerKey) {
            const parts = providerKey.split('.');
            if (parts.length >= 3) {
              const aliasScopedKey = `${parts[0]}.${parts[1]}`;
              const aliasHit = tryVariants(aliasScopedKey);
              if (aliasHit) {
                return aliasHit;
              }
            }
          }

          return tryVariants(fallback) ?? fallback;
        },
        getHandleByRuntimeKey: (runtimeKey?: string, metadata?: Record<string, unknown>): ProviderHandle | undefined => {
          if (!runtimeKey) {
            return undefined;
          }
          if (!this.isProviderVisibleInMetadataScope(runtimeKey, metadata)) {
            return undefined;
          }
          const direct = this.providerHandles.get(runtimeKey);
          if (direct) {
            return direct;
          }
          const normalizedRuntimeKey = runtimeKey.replace(/\.key(\d+)(?=\.|$)/gi, '.$1');
          if (normalizedRuntimeKey !== runtimeKey) {
            const normalizedDirect = this.isProviderVisibleInMetadataScope(normalizedRuntimeKey, metadata)
              ? this.providerHandles.get(normalizedRuntimeKey)
              : undefined;
            if (normalizedDirect) {
              return normalizedDirect;
            }
          }
          const denormalizedRuntimeKey = runtimeKey.replace(/\.(\d+)(?=\.|$)/g, '.key$1');
          if (denormalizedRuntimeKey !== runtimeKey) {
            const denormalizedDirect = this.isProviderVisibleInMetadataScope(denormalizedRuntimeKey, metadata)
              ? this.providerHandles.get(denormalizedRuntimeKey)
              : undefined;
            if (denormalizedDirect) {
              return denormalizedDirect;
            }
          }
          const runtimeKeyParts = runtimeKey.split('.');
          if (runtimeKeyParts.length === 2) {
            const aliasScopedPrefix = `${runtimeKeyParts[0]}.${runtimeKeyParts[1]}.`;
            for (const [candidateKey, handle] of this.providerHandles.entries()) {
              if (candidateKey.startsWith(aliasScopedPrefix) && this.isProviderVisibleInMetadataScope(candidateKey, metadata)) {
                return handle;
              }
            }
            const normalizedAliasScopedPrefix = aliasScopedPrefix.replace(/\.key(\d+)\./i, '.$1.');
            if (normalizedAliasScopedPrefix !== aliasScopedPrefix) {
              for (const [candidateKey, handle] of this.providerHandles.entries()) {
                if (candidateKey.startsWith(normalizedAliasScopedPrefix) && this.isProviderVisibleInMetadataScope(candidateKey, metadata)) {
                  return handle;
                }
              }
            }
          }
          return undefined;
        }
      },
      getHubPipeline: (routingPolicyGroup?: string) => this.resolveHubPipelineForRoutingPolicyGroup(routingPolicyGroup),
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

  private resolveHubPipelineForRoutingPolicyGroup(routingPolicyGroup?: string): HubPipeline | null {
    const group = typeof routingPolicyGroup === 'string' ? routingPolicyGroup.trim() : '';
    if (group) {
      return this.hubPipelinesByRoutingPolicyGroup.get(group) ?? null;
    }
    return this.hubPipeline;
  }

  private resolvePortSessionDir(portConfig?: PortConfig | null, localPort?: number): string | undefined {
    if (typeof localPort === 'number') {
      const inst = this.portRegistry.get(localPort);
      if (inst?.sessionDir) {
        return inst.sessionDir;
      }
    }
    const resolved = resolvePortScopedSessionDir({
      serverId: this.resolvePortServerId(portConfig, localPort),
      port: typeof portConfig?.port === 'number' ? portConfig.port : localPort,
      routingPolicyGroup: portConfig?.routingPolicyGroup,
    });
    return resolved ?? undefined;
  }

  private resolvePortServerId(portConfig?: PortConfig | null, localPort?: number): string {
    if (typeof localPort === 'number') {
      const inst = this.portRegistry.get(localPort);
      if (inst?.serverId) {
        return inst.serverId;
      }
    }
    const port = typeof portConfig?.port === 'number' ? portConfig.port : localPort;
    const host = typeof portConfig?.host === 'string' && portConfig.host.trim()
      ? portConfig.host
      : this.config.server.host;
    return canonicalizeServerId(host, typeof port === 'number' ? port : this.config.server.port);
  }

  private isProviderVisibleInMetadataScope(providerKey: string | undefined, metadata?: Record<string, unknown>): boolean {
    const key = typeof providerKey === 'string' ? providerKey.trim() : '';
    if (!key) {
      return false;
    }
    const allowed = Array.isArray(metadata?.allowedProviders)
      ? (metadata.allowedProviders as unknown[])
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .map((value) => value.trim().toLowerCase())
      : [];
    if (allowed.length === 0) {
      return true;
    }
    const normalizedKey = key.toLowerCase();
    return allowed.some((providerId) => normalizedKey === providerId || normalizedKey.startsWith(`${providerId}.`));
  }

  private async buildHubPipelineConfigForRoutingPolicyGroup(
    routingPolicyGroup: string,
    baseConfig: HubPipelineConfig,
  ): Promise<HubPipelineConfig> {
    const routerInput = await buildVirtualRouterInputV2(this.userConfig as Record<string, unknown>, undefined, {
      routingPolicyGroup,
    });
    const artifacts = await this.bootstrapVirtualRouter(routerInput as UnknownObject);
    return {
      ...baseConfig,
      virtualRouter: artifacts.config,
    };
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

  private stopSessionDaemonInjectLoop(): void {
    stopSessionDaemonInjectLoop(this);
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

  private resolveRuntimeKeyForProviderBinding(bindingKey?: string, metadata?: Record<string, unknown>): string | undefined {
    if (!bindingKey) {
      return undefined;
    }
    const normalizedBinding = bindingKey.trim();
    if (!normalizedBinding) {
      return undefined;
    }
    if (this.providerKeyToRuntimeKey.has(normalizedBinding)) {
      const runtimeKey = this.providerKeyToRuntimeKey.get(normalizedBinding);
      return this.isProviderVisibleInMetadataScope(runtimeKey, metadata) ? runtimeKey : undefined;
    }
    if (this.providerHandles.has(normalizedBinding) && this.isProviderVisibleInMetadataScope(normalizedBinding, metadata)) {
      return normalizedBinding;
    }
    const scopedPrefix = `${normalizedBinding}.`;
    for (const runtimeKey of this.providerHandles.keys()) {
      if ((runtimeKey === normalizedBinding || runtimeKey.startsWith(scopedPrefix)) && this.isProviderVisibleInMetadataScope(runtimeKey, metadata)) {
        return runtimeKey;
      }
    }
    if (normalizedBinding.includes('.')) {
      const lastDot = normalizedBinding.lastIndexOf('.');
      const modelSuffix = `.${normalizedBinding.slice(lastDot + 1)}`;
      for (const runtimeKey of this.providerHandles.keys()) {
        if (runtimeKey.endsWith(modelSuffix) && runtimeKey.startsWith(normalizedBinding.slice(0, lastDot)) && this.isProviderVisibleInMetadataScope(runtimeKey, metadata)) {
          return runtimeKey;
        }
      }
      const parentBinding = normalizedBinding.slice(0, lastDot);
      if (parentBinding && parentBinding !== normalizedBinding) {
        const parentResolved = this.resolveRuntimeKeyForProviderBinding(parentBinding, metadata);
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
        if (runtimeTail === normalizedModel && this.isProviderVisibleInMetadataScope(runtimeKey, metadata)) {
          return runtimeKey;
        }
      }
      for (const runtimeKey of this.providerHandles.keys()) {
        const runtimeSegments = runtimeKey.split('.').map((part) => part.trim()).filter(Boolean);
        if (runtimeSegments[0] === providerId && runtimeSegments.includes(alias) && this.isProviderVisibleInMetadataScope(runtimeKey, metadata)) {
          return runtimeKey;
        }
      }
    }
    return undefined;
  }

  private resolveProviderHandleForBinding(bindingKey?: string, metadata?: Record<string, unknown>): ProviderHandle | undefined {
    const runtimeKey = this.resolveRuntimeKeyForProviderBinding(bindingKey, metadata);
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
    const routeHintHeader = (input.headers as Record<string, unknown> | undefined)?.['x-route-hint'];
    const routeHint = typeof routeHintHeader === 'string' && routeHintHeader.trim()
      ? routeHintHeader.trim()
      : Array.isArray(routeHintHeader) && routeHintHeader[0]
        ? String(routeHintHeader[0]).trim()
        : undefined;

    if (portConfig?.mode === 'router' && portConfig.routingPolicyGroup) {
      const groupPipeline = this.resolveHubPipelineForRoutingPolicyGroup(portConfig.routingPolicyGroup);
      if (!groupPipeline) {
        const scopeLabel = this.resolvePortServerId(portConfig, localPort);
        const message = `Routing policy group pipeline not available for port ${portConfig.port} ` +
          `(serverId=${scopeLabel}, routingPolicyGroup=${portConfig.routingPolicyGroup}). ` +
          `Server is misconfigured for this port.`;
        // Hard fail-fast: do not silently drop the request.
        // Routes must catch this and return HTTP 500 JSON, never an empty reply.
        const err = Object.assign(
          new Error(message),
          {
            code: 'ROUTECODEX_HUB_PIPELINE_NOT_READY',
            status: 500,
            port: portConfig.port,
            serverId: scopeLabel,
            routingPolicyGroup: portConfig.routingPolicyGroup,
          }
        );
        throw err;
      }
    }

    // Build per-port metadata: routecodexLocalPort + mode always present.
    // Router ports: inject allowedProviders derived from routingPolicyGroup to
    // restrict routing to that group'''s provider pool (replaces global active group).
    let allowedProviders: string[] | undefined;
    if (portConfig?.mode === 'router' && portConfig.routingPolicyGroup) {
      allowedProviders = extractProviderKeysForRoutingGroup(this.userConfig, portConfig.routingPolicyGroup);
    }

    // stopMessage 默认启用（true），除非端口显式配置 enabled=false。
    // direct 路径默认排除 stopMessage，只有端口显式 includeDirect=true 才纳入。
    const effectiveStopMessageEnabled = typeof portConfig?.stopMessage?.enabled === 'boolean'
      ? portConfig.stopMessage.enabled
      : true;
    const effectiveStopMessageExcludeDirect = portConfig?.stopMessage?.includeDirect === true
      ? false
      : true;

    const metadata: Record<string, unknown> = {
      ...(input.metadata ?? {}),
      routecodexLocalPort: localPort,
      routecodexPortMode: portConfig?.mode ?? 'router',
      routecodexPortBinding: portConfig?.providerBinding,
      routecodexRoutingPolicyGroup: portConfig?.routingPolicyGroup,
      routecodexServerId: this.resolvePortServerId(portConfig, localPort),
      entryPort: typeof portConfig?.port === 'number' ? portConfig.port : localPort,
      stopMessageEnabled: effectiveStopMessageEnabled,
      stopMessageExcludeDirect: effectiveStopMessageExcludeDirect,
      routecodexPortStopMessageEnabled: effectiveStopMessageEnabled,
      ...(routeHint ? { routeHint } : {}),
      ...(allowedProviders ? { allowedProviders } : {}),
    };
    const portSessionDir = this.resolvePortSessionDir(portConfig, localPort);
    if (portSessionDir) {
      const existingRt = metadata.__rt && typeof metadata.__rt === 'object' && !Array.isArray(metadata.__rt)
        ? (metadata.__rt as Record<string, unknown>)
        : {};
      metadata.__rt = {
        ...existingRt,
        sessionDir: portSessionDir,
      };
    }
    const resumeProviderKey = (() => {
      const resume = metadata.responsesResume;
      if (!resume || typeof resume !== 'object' || Array.isArray(resume)) return undefined;
      const value = (resume as Record<string, unknown>).providerKey;
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    })();
    if (resumeProviderKey && portConfig?.mode === 'router' && (portConfig.sameProtocolBehavior ?? 'direct') === 'direct') {
      metadata.__shadowCompareForcedProviderKey = resumeProviderKey;
    }
    const nextInput: PipelineExecutionInput = {
      ...input,
      metadata,
    };
    if (!portConfig || portConfig.mode === 'router') {
      if (
        portConfig?.mode === 'router'
        && (portConfig.sameProtocolBehavior ?? 'direct') === 'direct'
      ) {
        const directEntryDecision = evaluateDirectRouteDecision({
          payload:
            nextInput.body && typeof nextInput.body === 'object' && !Array.isArray(nextInput.body)
              ? nextInput.body as Record<string, unknown>
              : {},
          inboundProtocol: detectInboundProtocolFromRequest({
            path: nextInput.entryEndpoint,
            headers: nextInput.headers as Record<string, string | string[] | undefined>,
          }),
          applyPatchMode: 'client',
        });
        if (!directEntryDecision.providerWireValid || directEntryDecision.requiresHubRelay) {
          this.logStage('router-direct.skipped', input.requestId, {
            reason: directEntryDecision.requiresHubRelay ? 'direct_payload_requires_hub_relay' : 'direct_payload_not_provider_wire',
            detail: directEntryDecision.reason ?? (directEntryDecision.requiresHubRelay ? 'requires_hub_relay' : 'invalid_direct_payload'),
            mode: 'client',
          });
          throw new Error(`router-direct requires provider-wire payload: ${directEntryDecision.reason ?? 'invalid_direct_payload'}`);
        }
        this.logStage('router-direct.entry', input.requestId, {
          routingPolicyGroup: portConfig.routingPolicyGroup,
          sameProtocolBehavior: portConfig.sameProtocolBehavior,
          model: input.body && typeof input.body === 'object' && !Array.isArray(input.body) && typeof (input.body as Record<string, unknown>).model === 'string'
            ? (input.body as Record<string, unknown>).model
            : undefined,
        });
        const routerDirectStormScopes = resolveSessionStormBackoffScopes(asMetadataRecord(nextInput.metadata));
        for (const scope of routerDirectStormScopes) {
          const waitMs = peekSessionStormBackoffWaitMs(scope);
          if (!(waitMs > 0)) {
            continue;
          }
          this.logStage('request.session_storm_backoff_wait', input.requestId, {
            scope,
            waitMs,
            source: 'router-direct',
          });
          await waitSessionStormBackoffWithGate(
            scope,
            waitMs,
            getClientConnectionAbortSignal(asMetadataRecord(nextInput.metadata)),
            logRouterDirectNonBlockingError,
          );
          this.logStage('request.session_storm_backoff_wait.completed', input.requestId, {
            scope,
            waitMs,
            source: 'router-direct',
          });
        }
        let directResult: RouterDirectOutcome;
        try {
          directResult = await this.executeRouterDirectPipelineForPort(portConfig, nextInput);
        } catch (error) {
          this.recordRouterDirectStormBackoff(input.requestId, routerDirectStormScopes, error);
          throw error;
        }
        if (directResult.used) {
          return this.buildRouterDirectResult(directResult, input);
        }
        this.logStage('router-direct.failed_no_relay', input.requestId, {
          reason: directResult.reason,
        });
        const directError = buildRouterDirectFailureError(directResult.reason);
        this.recordRouterDirectStormBackoff(input.requestId, routerDirectStormScopes, directError);
        throw directError;
      }
      return await this.executePipeline(nextInput);
    }

    const handle = this.resolveProviderHandleForBinding(portConfig.providerBinding, metadata);
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
   * Router-Direct Pipeline: asks the Virtual Router for target selection, then
   * checks same-protocol direct eligibility. It must not enter Hub Pipeline
   * request/response conversion; non provider-wire payloads are direct misses.
   */
  private async executeRouterDirectPipelineForPort(
    portConfig: PortConfig,
    input: PipelineExecutionInput,
    retryState: RouterDirectRetryState = createRouterDirectRetryState(input),
    directAttempt = 1,
  ): Promise<RouterDirectOutcome> {
    const routingPipeline = this.resolveHubPipelineForRoutingPolicyGroup(portConfig.routingPolicyGroup);
    const routerEngine = routingPipeline?.getVirtualRouter?.();
    if (!routerEngine || typeof routerEngine.route !== 'function') {
      this.logStage('router-direct.skipped', input.requestId, { reason: 'virtual-router-not-ready' });
      return { used: false, reason: 'virtual-router-not-ready' };
    }

    const allowedProviders =
      portConfig.routingPolicyGroup
        ? extractProviderKeysForRoutingGroup(this.userConfig, portConfig.routingPolicyGroup)
        : undefined;

    const metadataForHub: Record<string, unknown> = {
      ...(input.metadata ?? {}),
      routecodexLocalPort: portConfig.port,
      routecodexPortMode: portConfig.mode,
      routecodexPortBinding: portConfig.providerBinding,
      routecodexRoutingPolicyGroup: portConfig.routingPolicyGroup,
      ...(allowedProviders && allowedProviders.length > 0 ? { allowedProviders } : {}),
    };
    const portSessionDir = this.resolvePortSessionDir(portConfig, portConfig.port);
    if (portSessionDir) {
      const existingRt = metadataForHub.__rt && typeof metadataForHub.__rt === 'object' && !Array.isArray(metadataForHub.__rt)
        ? (metadataForHub.__rt as Record<string, unknown>)
        : {};
      metadataForHub.__rt = {
        ...existingRt,
        sessionDir: portSessionDir,
      };
    }
    if (retryState.retryProviderKey) {
      metadataForHub.__routecodexRetryProviderKey = retryState.retryProviderKey;
      delete metadataForHub.excludedProviderKeys;
    } else if (retryState.excludedProviderKeys.size > 0) {
      metadataForHub.excludedProviderKeys = Array.from(retryState.excludedProviderKeys);
      delete metadataForHub.__routecodexRetryProviderKey;
    } else {
      delete metadataForHub.excludedProviderKeys;
      delete metadataForHub.__routecodexRetryProviderKey;
    }

    const rawDirectPayload = resolveRawPayloadForDirect(input.body, input.metadata);
    const inboundProtocol = detectInboundProtocolFromRequest({
      path: input.entryEndpoint,
      headers: input.headers as Record<string, string | string[] | undefined>,
    });
    metadataForHub.routerDirectInboundProtocol = inboundProtocol;
    const directPayloadDecision = evaluateDirectRouteDecision({
      payload: rawDirectPayload,
      inboundProtocol,
    });
    if (!directPayloadDecision.providerWireValid || directPayloadDecision.requiresHubRelay) {
      this.logStage('router-direct.skipped', input.requestId, {
        reason: directPayloadDecision.requiresHubRelay ? 'direct_payload_requires_hub_relay' : 'direct_payload_not_provider_wire',
        detail: directPayloadDecision.reason ?? (directPayloadDecision.requiresHubRelay ? 'requires_hub_relay' : 'invalid_direct_payload'),
      });
      return { used: false, reason: directPayloadDecision.requiresHubRelay ? 'direct_payload_requires_hub_relay' : 'direct_payload_not_provider_wire' };
    }

    let routeResult: {
      target?: Record<string, unknown>;
      decision?: Record<string, unknown>;
      diagnostics?: Record<string, unknown>;
    };
    try {
      routeResult = routerEngine.route(rawDirectPayload as never, metadataForHub as never) as typeof routeResult;
    } catch (error) {
      if (isPoolExhaustedPipelineError(error)) {
        this.logStage('router-direct.pool_exhausted', input.requestId, {
          error: error instanceof Error ? error.message : String(error),
          code: error && typeof error === 'object' && typeof (error as Record<string, unknown>).code === 'string'
            ? (error as Record<string, unknown>).code
            : undefined,
          statusCode: extractStatusCodeFromError(error),
          routecodexRoutingPolicyGroup: metadataForHub.routecodexRoutingPolicyGroup,
          allowedProviders: metadataForHub.allowedProviders,
          model: input.body && typeof input.body === 'object' && !Array.isArray(input.body) && typeof (input.body as Record<string, unknown>).model === 'string'
            ? (input.body as Record<string, unknown>).model
            : undefined,
        });
        if (retryState.lastError) {
          throw retryState.lastError;
        }
      }
      this.logStage('router-direct.route_failed', input.requestId, {
        error: error instanceof Error ? error.message : String(error),
      });
      await clearResponsesConversationByRequestId(input.requestId).catch(() => {
        // non-blocking cleanup
      });
      throw error;
    }

    const target = routeResult.target;
    const routingDecision = routeResult.decision;
    const providerPayload = {
      ...(typeof target?.modelId === 'string' && target.modelId.trim() ? { model: target.modelId.trim() } : {}),
    } as Record<string, unknown>;

    if (!target || typeof target.providerKey !== 'string' || !target.providerKey.trim()) {
      this.logStage('router-direct.skipped', input.requestId, { reason: 'no-target-from-router' });
      return { used: false, reason: 'no-target-from-router' };
    }
    const providerKey = target.providerKey.trim();
    const runtimeKey = typeof target.runtimeKey === 'string' && target.runtimeKey.trim() ? target.runtimeKey.trim() : providerKey;
    const providerType = typeof target.providerType === 'string' ? target.providerType : '';
    if (retryState.retryProviderKey && providerKey !== retryState.retryProviderKey) {
      this.logStage('router-direct.retry.forced_provider_mismatch', input.requestId, {
        expectedProviderKey: retryState.retryProviderKey,
        selectedProviderKey: providerKey,
        directAttempt,
      });
      if (retryState.lastError) {
        throw retryState.lastError;
      }
      throw Object.assign(new Error(`router-direct retry selected ${providerKey}, expected ${retryState.retryProviderKey}`), {
        code: 'ERR_ROUTER_DIRECT_RETRY_PROVIDER_MISMATCH',
        requestId: input.requestId,
        providerKey,
        expectedProviderKey: retryState.retryProviderKey,
      });
    }
    if (!retryState.retryProviderKey && retryState.excludedProviderKeys.has(providerKey)) {
      this.logStage('router-direct.retry.excluded_target_reselected', input.requestId, {
        providerKey,
        excluded: Array.from(retryState.excludedProviderKeys),
        directAttempt,
      });
      if (retryState.lastError) {
        throw retryState.lastError;
      }
      throw Object.assign(new Error(`router-direct reselected excluded provider ${providerKey}`), {
        code: 'ERR_ROUTER_DIRECT_EXCLUDED_PROVIDER_RESELECTED',
        requestId: input.requestId,
        providerKey,
      });
    }

    const requestPayload = applyMinimalDirectOverrides(rawDirectPayload);
    try {
      const finalDirectPayloadDecision = evaluateDirectRouteDecision({
        payload: requestPayload,
        inboundProtocol,
      });
      if (finalDirectPayloadDecision.requiresHubRelay) {
        throw new Error(finalDirectPayloadDecision.reason ?? 'requires_hub_relay');
      }
      assertDirectRouteDecision({
        payload: requestPayload,
        inboundProtocol,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '');
      this.logStage('router-direct.skipped', input.requestId, {
        reason: message.includes('Hub relay') || message.includes('hub_relay')
          ? 'direct_payload_requires_hub_relay'
          : 'direct_payload_not_provider_wire',
        detail: message || 'invalid_direct_payload',
        stage: 'final_request_payload',
      });
      return {
        used: false,
        reason: message.includes('Hub relay') || message.includes('hub_relay')
          ? 'direct_payload_requires_hub_relay'
          : 'direct_payload_not_provider_wire',
      };
    }
    let capturedUsage: Record<string, unknown> | undefined;
    let directOutcome: RouterDirectOutcome;
    let directRetryRequested = false;
    try {
      directOutcome = await executeRouterDirectPipeline({
      portConfig,
      providerPayload,
      requestPayload,
      requestId: input.requestId,
      target: {
        providerKey,
        providerType,
        runtimeKey,
      },
      routingDecision: routingDecision as { routeName?: string; pool?: string[] } | undefined,
      requestInfo: {
        path: input.entryEndpoint,
        headers: input.headers as Record<string, string | string[] | undefined>,
      },
      resolveProviderByRuntimeKey: (runtimeKey?: string) => {
        if (!runtimeKey) return undefined;
        return this.isProviderVisibleInMetadataScope(runtimeKey, metadataForHub)
          ? this.providerHandles.get(runtimeKey)
          : undefined;
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
        const handle = this.resolveProviderHandleForBinding(ctx.providerKey, metadataForHub)
          ?? this.resolveProviderHandleForBinding(runtimeKey, metadataForHub);
        if (handle) {
          const normalized = normalizeProviderResponse(response);
          const usage = extractUsageFromResult(normalized, {
            ...(input.metadata ?? {}),
            providerProtocol: handle.providerProtocol,
            providerType: handle.providerType,
            providerKey: ctx.providerKey,
          });
          if (usage) {
            capturedUsage = usage as Record<string, unknown>;
          }
        }
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
      onProviderError: async (error, ctx) => {
        const runtimeScope = readRuntimeScopeFromMetadata(metadataForHub);
        const retryError = extractRetryErrorSnapshot(error);
        const statusCode = typeof retryError.statusCode === 'number'
          ? retryError.statusCode
          : extractStatusCodeFromError(error);
        const publicErrorMessage = mapErrorToPublicLogSummary(error);
        this.logStage('router-direct.send.error', input.requestId, {
          port: portConfig.port,
          providerKey: ctx.providerKey,
          routeName: ctx.routingDecision?.routeName,
          statusCode,
          errorCode: retryError.errorCode,
          upstreamCode: retryError.upstreamCode,
          message: publicErrorMessage,
          directAttempt,
        });
        const directFailurePlan = await resolveRequestExecutorProviderFailurePlan({
          error,
          retryError,
          requestId: input.requestId,
          providerKey: ctx.providerKey,
          providerType,
          providerProtocol: ctx.providerProtocol,
          routeName: ctx.routingDecision?.routeName,
          runtimeKey,
          target: {
            providerKey,
            providerType,
            runtimeKey,
          },
          dependencies: this.getModuleDependencies(),
          attempt: directAttempt,
          maxAttempts: retryState.maxAttempts,
          stage: 'provider.send',
          logicalRequestChainKey: input.requestId,
          logicalChainRetryLimitStageRequestId: input.requestId,
          routePool: Array.isArray(ctx.routingDecision?.pool) ? ctx.routingDecision?.pool : undefined,
          excludedProviderKeys: retryState.excludedProviderKeys,
          recordAttempt: () => {},
          logStage: (stage, requestId, details) => this.logStage(stage, requestId, details),
          routeHint: typeof metadataForHub.routeHint === 'string' ? metadataForHub.routeHint : undefined,
          transientRetryTracker: retryState.transientRetryTracker,
          logNonBlockingError: logRouterDirectNonBlockingError,
          metadata: {
            ...metadataForHub,
            __rt: {
              ...(metadataForHub.__rt && typeof metadataForHub.__rt === 'object' && !Array.isArray(metadataForHub.__rt)
                ? (metadataForHub.__rt as Record<string, unknown>)
                : {}),
              ...runtimeScope,
            },
          },
          extraDetails: {
            source: 'router-direct',
            directAttempt,
            ...(typeof statusCode === 'number' ? { statusCode } : {}),
          },
        });
        const retryPlan = directFailurePlan.retryExecutionPlan;
        if (
          !retryPlan.shouldRetry
          || !retryPlan.requestLocalTransient
          || !retryPlan.retrySwitchPlan
          || !directFailurePlan.requestLocalProviderRetryState
          || directAttempt >= retryState.maxAttempts
        ) {
          return;
        }
        if (directFailurePlan.retryTelemetryPlan) {
          emitRequestExecutorProviderRetryTelemetry({
            requestId: input.requestId,
            retryTelemetryPlan: directFailurePlan.retryTelemetryPlan,
            logStage: (stage, requestId, details) => this.logStage(stage, requestId, details),
            logProviderRetrySwitch: (switchArgs) => logProviderRetrySwitchCompact({
              ...switchArgs,
              providerSwitchLogState: routerDirectProviderSwitchLogState,
              throttleMs: ROUTER_DIRECT_PROVIDER_SWITCH_LOG_THROTTLE_MS,
            }),
          });
        }
        retryState.lastError = error;
        directRetryRequested = true;
        if (directFailurePlan.requestLocalProviderRetryState.switchAction === 'retry_same_provider_once') {
          retryState.retryProviderKey = ctx.providerKey;
          retryState.excludedProviderKeys.delete(ctx.providerKey);
        } else {
          retryState.retryProviderKey = undefined;
        }
        this.logStage('router-direct.retry.requested', input.requestId, {
          providerKey: ctx.providerKey,
          routeName: ctx.routingDecision?.routeName,
          switchAction: directFailurePlan.requestLocalProviderRetryState.switchAction,
          excluded: Array.from(retryState.excludedProviderKeys),
          directAttempt,
          nextDirectAttempt: directAttempt + 1,
          ...(typeof statusCode === 'number' ? { statusCode } : {}),
          ...(retryError.errorCode ? { errorCode: retryError.errorCode } : {}),
          ...(retryError.upstreamCode ? { upstreamCode: retryError.upstreamCode } : {}),
        });
      },
      });
    } catch (error) {
      if (directRetryRequested && directAttempt < retryState.maxAttempts) {
        return await this.executeRouterDirectPipelineForPort(portConfig, input, retryState, directAttempt + 1);
      }
      throw error;
    }

    if (!directOutcome.used) {
      this.logStage('router-direct.skipped', input.requestId, { reason: directOutcome.reason });
      return {
        used: false,
        reason: directOutcome.reason,
        preselectedRoute: {
          target,
          decision: routingDecision,
          diagnostics: routeResult.diagnostics,
        },
      };
    }

    return {
      used: true,
      response: directOutcome.response,
      providerHandle: directOutcome.providerHandle,
      auditContext: directOutcome.auditContext,
      capturedUsage,
      providerPayload,
      pipelineMetadata: metadataForHub,
    };
  }

  private recordRouterDirectStormBackoff(
    requestId: string,
    scopes: string[],
    error: unknown,
    readableMessage?: string,
  ): void {
    if (!shouldRecordRouterDirectStorm(error, readableMessage)) {
      return;
    }
    for (const scope of scopes) {
      const backoffMs = consumeSessionStormBackoffMs(scope, error);
      this.logStage('request.session_storm_backoff.recorded', requestId, {
        scope,
        backoffMs,
        source: 'router-direct',
      });
    }
  }

  /**
   * Build a PipelineExecutionResult from a router-direct outcome.
   * Contract: router-direct is provider passthrough + hooks only.
   * It must not re-enter Hub response conversion/chat-process.
   */
  private async buildRouterDirectResult(directResult: RouterDirectResult, input: PipelineExecutionInput): Promise<PipelineExecutionResult> {
    const { response, providerHandle, auditContext } = directResult;

    const normalized = normalizeProviderResponse(response);
    const usage = directResult.capturedUsage ?? extractUsageFromResult(normalized, {
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
    const inputMetadata = input.metadata && typeof input.metadata === 'object'
      ? (input.metadata as Record<string, unknown>)
      : {};
    if (input.requestId && providerHandle.providerProtocol === 'openai-responses') {
      const responseBody = normalized.body;
      if (
        normalized.status && normalized.status >= 400
        || !responseBody
        || typeof responseBody !== 'object'
        || Array.isArray(responseBody)
        || '__sse_responses' in (responseBody as Record<string, unknown>)
      ) {
        await clearResponsesConversationByRequestId(input.requestId);
      } else {
        await recordResponsesResponseForRequest({
          requestId: input.requestId,
          response: responseBody as Record<string, unknown>,
          providerKey: auditContext.providerKey,
          sessionId: readSessionIdForUsageLog(inputMetadata),
          conversationId: typeof inputMetadata.conversationId === 'string' ? inputMetadata.conversationId : undefined,
          routingPolicyGroup:
            directResult.pipelineMetadata
            && typeof directResult.pipelineMetadata.routecodexRoutingPolicyGroup === 'string'
              ? directResult.pipelineMetadata.routecodexRoutingPolicyGroup
              : undefined,
          allowScopeContinuation: true,
        });
        await finalizeResponsesConversationRequestRetention(input.requestId, {
          keepForSubmitToolOutputs: finishReason === 'tool_calls',
        });
      }
    }
    const baseResult: PipelineExecutionResult = {
      ...normalized,
      metadata:
        input.metadata && typeof input.metadata === 'object'
          ? { ...(input.metadata as Record<string, unknown>), __routecodexDirectPassthrough: true }
          : { ...(normalized.metadata ?? {}), __routecodexDirectPassthrough: true },
      usageLogInfo: {
        ...normalized.usageLogInfo ?? {},
        providerKey: auditContext.providerKey,
        model: requestModel,
        routeName: `router-direct:${auditContext.routingDecision?.routeName ?? 'unknown'}`,
        finishReason,
        usage: usage ? (usage as Record<string, unknown>) : undefined,
        requestStartedAtMs: Date.now(),
        sessionId: readSessionIdForUsageLog(inputMetadata),
        conversationId: inputMetadata.conversationId,
        projectPath:
          inputMetadata.clientWorkdir
          ?? inputMetadata.client_workdir
          ?? inputMetadata.workdir
          ?? inputMetadata.cwd,
        providerRequestId: input.requestId,
        inputRequestId: input.requestId,
      },
    };

    return baseResult;
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
    capturedUsage?: Record<string, unknown>,
  ): Promise<PipelineExecutionResult> {
    const normalized = normalizeProviderResponse(directResult.response);
    // Prefer usage extracted by the onSnapshotAfter hook; fall back to extraction here
    const usage = capturedUsage ?? extractUsageFromResult(normalized, {
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
    const inputMetadata = input.metadata && typeof input.metadata === 'object'
      ? (input.metadata as Record<string, unknown>)
      : {};
    return {
      ...normalized,
      metadata:
        input.metadata && typeof input.metadata === 'object'
          ? { ...(input.metadata as Record<string, unknown>), __routecodexDirectPassthrough: true }
          : { ...(normalized.metadata ?? {}), __routecodexDirectPassthrough: true },
      usageLogInfo: {
        ...(normalized.usageLogInfo ?? {}),
        providerKey: providerBinding,
        model: requestModel ?? this.extractProviderModel(payload),
        routeName: 'port.provider-direct',
        finishReason,
        usage: usage ? (usage as Record<string, unknown>) : undefined,
        requestStartedAtMs: Date.now(),
        sessionId: readSessionIdForUsageLog(inputMetadata),
        conversationId: inputMetadata.conversationId,
        projectPath:
          inputMetadata.clientWorkdir
          ?? inputMetadata.client_workdir
          ?? inputMetadata.workdir
          ?? inputMetadata.cwd,
        providerRequestId: input.requestId,
        inputRequestId: input.requestId,
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
    const inboundProtocol = detectInboundProtocolFromRequest({
      path: input.entryEndpoint,
      headers: input.headers as Record<string, string | string[] | undefined>,
    });
    const directPayloadDecision = evaluateDirectRouteDecision({
      payload,
      inboundProtocol,
    });
    if (!directPayloadDecision.providerWireValid || directPayloadDecision.requiresHubRelay) {
      throw new Error(directPayloadDecision.reason ?? 'invalid direct payload');
    }
    const providerBinding = portConfig.providerBinding;
    const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? (input.metadata as Record<string, unknown>)
      : undefined;
    const runtimeKey = this.resolveRuntimeKeyForProviderBinding(providerBinding, metadata);
    this.logStage('port_pipeline.dispatch', input.requestId, {
      port: portConfig.port,
      mode: portConfig.mode,
      providerBinding,
      runtimeKey,
      entryEndpoint: input.entryEndpoint,
    });
    // Closure vars for usage data captured by hooks
    let capturedUsage: Record<string, unknown> | undefined;

    const directResult = await executeProviderDirectPipeline(
      payload,
      {
        path: input.entryEndpoint,
        headers: input.headers as Record<string, string | string[] | undefined>,
      },
      {
        portConfig,
        resolveProvider: (bindingKey: string) => this.resolveProviderHandleForBinding(bindingKey, metadata),
        detectInboundProtocol: detectInboundProtocolFromRequest,
        preparePayload: (providerPayload, context) => {
          const handle = this.resolveProviderHandleForBinding(context.providerKey, metadata);
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
            runtimeKey: this.resolveRuntimeKeyForProviderBinding(context.providerKey, metadata),
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
          // Extract usage/cache from response inline in the output hook
          const handle = this.resolveProviderHandleForBinding(context.providerKey, metadata);
          if (handle) {
            const normalized = normalizeProviderResponse(response);
            const usage = extractUsageFromResult(normalized, {
              providerProtocol: handle.providerProtocol,
              providerType: handle.providerType,
              providerKey: context.providerKey,
            });
            if (usage) {
              capturedUsage = usage as Record<string, unknown>;
            }
          }
        },
      },
    );

    return await this.buildProviderDirectResult(
      directResult,
      input,
      payload,
      providerBinding,
      capturedUsage,
    );
  }

  private async initializeRouteErrorHub(): Promise<void> {
    await initializeRouteErrorHub(this);
  }
}
