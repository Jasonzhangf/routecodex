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
import { preloadAntigravityAliasUserAgents, primeAntigravityUserAgentVersion } from '../../../providers/auth/antigravity-user-agent.js';
import { getAntigravityWarmupBlacklistDurationMs, isAntigravityWarmupEnabled, warmupCheckAntigravityAlias } from '../../../providers/auth/antigravity-warmup.js';
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
  extractSessionIdentifiersFromMetadata,
  bootstrapVirtualRouterConfig,
  getProviderSuccessCenter,
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
import { describeRetryReason, isNetworkTransportError, shouldRetryProviderError, waitBeforeRetry } from './executor-provider.js';
import { ManagerDaemon } from '../../../manager/index.js';
import { HealthManagerModule } from '../../../manager/modules/health/index.js';
import { RoutingStateManagerModule } from '../../../manager/modules/routing/index.js';
import { TokenManagerModule } from '../../../manager/modules/token/index.js';
import type { ProviderQuotaDaemonModule } from '../../../manager/modules/quota/index.js';
import { ensureServerScopedSessionDir } from './session-dir.js';
import { canonicalizeServerId } from './server-id.js';
import { StatsManager, type UsageMetrics } from './stats-manager.js';
import { loadRouteCodexConfig } from '../../../config/routecodex-config-loader.js';
import { buildInfo } from '../../../build-info.js';
import {
  recordHubShadowCompareDiff,
  resolveHubShadowCompareConfig,
  shouldRunHubShadowCompare
} from './hub-shadow-compare.js';
import {
  recordLlmsEngineShadowDiff,
  isLlmsEngineShadowEnabledForSubpath,
  resolveLlmsEngineShadowConfig,
  shouldRunLlmsEngineShadowForSubpath
} from '../../../utils/llms-engine-shadow.js';
import { resolveLlmswitchCoreVersion } from '../../../utils/runtime-versions.js';
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

const DEFAULT_MAX_PROVIDER_ATTEMPTS = 6;
const DEFAULT_ANTIGRAVITY_MAX_PROVIDER_ATTEMPTS = 20;

function resolveMaxProviderAttempts(): number {
  const raw = String(
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS || process.env.RCC_MAX_PROVIDER_ATTEMPTS || ''
  )
    .trim()
    .toLowerCase();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  const candidate = Number.isFinite(parsed) ? parsed : DEFAULT_MAX_PROVIDER_ATTEMPTS;
  return Math.max(1, Math.min(20, candidate));
}

function resolveAntigravityMaxProviderAttempts(): number {
  const raw = String(
    process.env.ROUTECODEX_ANTIGRAVITY_MAX_PROVIDER_ATTEMPTS || process.env.RCC_ANTIGRAVITY_MAX_PROVIDER_ATTEMPTS || ''
  )
    .trim()
    .toLowerCase();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  const candidate = Number.isFinite(parsed) ? parsed : DEFAULT_ANTIGRAVITY_MAX_PROVIDER_ATTEMPTS;
  return Math.max(1, Math.min(60, candidate));
}

function isAntigravityProviderKey(providerKey: string | undefined): boolean {
  return typeof providerKey === 'string' && providerKey.startsWith('antigravity.');
}

function extractStatusCodeFromError(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const direct = (err as any).statusCode;
  if (typeof direct === 'number') return direct;
  const nested = (err as any).status;
  if (typeof nested === 'number') return nested;
  return undefined;
}

/**
 * RouteCodex Server V2
 *
 * 与V1完全并行实现，集成系统hooks
 */
export class RouteCodexHttpServer {
  private app: Application;
  private server?: Server;
  private activeSockets: Set<Socket> = new Set();
  private config: ServerConfigV2;
  private errorHandling: ErrorHandlingCenter;
  private _isInitialized: boolean = false;
  private _isRunning: boolean = false;

  // Runtime state
  private hubPipeline: HubPipeline | null = null;
  private providerHandles: Map<string, ProviderHandle> = new Map();
  private providerKeyToRuntimeKey: Map<string, string> = new Map();
  private providerRuntimeInitErrors: Map<string, Error> = new Map();
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

  constructor(config: ServerConfigV2) {
    this.config = config;
    this.app = express();
    this.errorHandling = new QuietErrorHandlingCenter();
    this.stageLoggingEnabled = isStageLoggingEnabled();
    this.repoRoot = resolveRepoRoot(import.meta.url);
    // Ensure session-scoped routing state does not leak across server instances.
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
   * Serves docs/daemon-admin-ui.html as a static page.
   * Note: daemon-admin UI/API now uses password login (stored at ~/.routecodex/login) instead of httpserver.apikey.
   */
  private registerDaemonAdminUiRoute(): void {
    this.app.get('/daemon/admin', async (req, res) => {
      try {
        const fs = await import('node:fs/promises');
        let html = '';
        try {
          const filePath = new URL('../../../../docs/daemon-admin-ui.html', import.meta.url);
          html = await fs.readFile(filePath, 'utf8');
        } catch {
          // build output reads from dist/docs; fallback to cwd/docs for dev runners
          const path = await import('node:path');
          const fallback = path.join(process.cwd(), 'docs', 'daemon-admin-ui.html');
          html = await fs.readFile(fallback, 'utf8');
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        // Avoid stale admin UI in browsers / proxies after upgrades.
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('X-RouteCodex-Version', buildInfo?.version ? String(buildInfo.version) : String(process.env.ROUTECODEX_VERSION || 'dev'));
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
    if (patched.timeoutMs === undefined && typeof profile.transport.timeoutMs === 'number') {
      patched.timeoutMs = profile.transport.timeoutMs;
    }
    if (patched.maxRetries === undefined && typeof profile.transport.maxRetries === 'number') {
      patched.maxRetries = profile.transport.maxRetries;
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

  private isSafeSecretReference(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) {
      return false;
    }
    if (trimmed.startsWith('authfile-')) {
      return true;
    }
    if (/^\$\{[A-Z0-9_]+\}$/i.test(trimmed)) {
      return true;
    }
    if (/^[A-Z][A-Z0-9_]+$/.test(trimmed)) {
      return true;
    }
    return false;
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

  private async ensureHubPipelineEngineShadow(): Promise<HubPipeline> {
    if (this.hubPipelineEngineShadow) {
      return this.hubPipelineEngineShadow;
    }
    if (!this.hubPipelineConfigForShadow) {
      throw new Error('Hub pipeline shadow config is not initialized');
    }

    const baseConfig = this.hubPipelineConfigForShadow as unknown as Record<string, unknown>;
    const shadowConfig: Record<string, unknown> = { ...baseConfig };

    // Avoid double side effects when shadow-running the pipeline: keep reads, drop writes.
    const routingStateStore = baseConfig.routingStateStore as unknown as
      | { loadSync?: (key: string) => unknown | null; saveAsync?: (key: string, state: unknown | null) => void }
      | undefined;
    if (routingStateStore && typeof routingStateStore.loadSync === 'function') {
      shadowConfig.routingStateStore = {
        loadSync: routingStateStore.loadSync.bind(routingStateStore),
        saveAsync: () => {}
      };
    }

    const healthStore = baseConfig.healthStore as unknown as
      | { loadInitialSnapshot?: () => unknown | null; persistSnapshot?: (snapshot: unknown) => void; recordProviderError?: (event: unknown) => void }
      | undefined;
    if (healthStore && typeof healthStore.loadInitialSnapshot === 'function') {
      shadowConfig.healthStore = {
        loadInitialSnapshot: healthStore.loadInitialSnapshot.bind(healthStore)
      };
    }

    const quotaViewReadOnly = baseConfig.quotaViewReadOnly as unknown as ((providerKey: string) => unknown) | undefined;
    if (typeof quotaViewReadOnly === 'function') {
      shadowConfig.quotaView = quotaViewReadOnly;
    }

    const bridge = (await import('../../../modules/llmswitch/bridge.js')) as unknown as {
      getHubPipelineCtorForImpl?: (impl: 'engine') => Promise<unknown>;
    };
    const getCtor = bridge.getHubPipelineCtorForImpl;
    if (typeof getCtor !== 'function') {
      throw new Error('llmswitch bridge does not expose getHubPipelineCtorForImpl');
    }
    const ctorFactory = await getCtor('engine');
    const hubCtor = ctorFactory as unknown as HubPipelineCtor;
    if (!('virtualRouter' in shadowConfig)) {
      throw new Error('HubPipeline shadow config missing virtualRouter');
    }
    this.hubPipelineEngineShadow = new hubCtor(
      shadowConfig as unknown as { virtualRouter: unknown; [key: string]: unknown }
    ) as unknown as HubPipeline;
    return this.hubPipelineEngineShadow;
  }

  private isPipelineReady(): boolean {
    return Boolean(this.hubPipeline);
  }

  private async waitForRuntimeReady(): Promise<void> {
    if (this.runtimeReadyResolved) {
      return;
    }
    if (this.runtimeReadyError) {
      throw this.runtimeReadyError;
    }
    const raw = String(process.env.ROUTECODEX_STARTUP_HOLD_MS || process.env.RCC_STARTUP_HOLD_MS || '').trim();
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    const timeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
    const timeoutPromise = new Promise<void>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`startup timeout after ${timeoutMs}ms`)), timeoutMs);
      try {
        (timer as unknown as { unref?: () => void }).unref?.();
      } catch {
        // ignore
      }
    });
    await Promise.race([this.runtimeReadyPromise, timeoutPromise]);
  }

  private isQuotaRoutingEnabled(): boolean {
    const flag = (this.config.server as { quotaRoutingEnabled?: unknown }).quotaRoutingEnabled;
    if (typeof flag === 'boolean') {
      return flag;
    }
    return true;
  }

  private shouldStartManagerDaemon(): boolean {
    const mockFlag = String(process.env.ROUTECODEX_USE_MOCK || '').trim();
    if (mockFlag === '1' || mockFlag.toLowerCase() === 'true') {
      return false;
    }
    if (process.env.ROUTECODEX_MOCK_CONFIG_PATH || process.env.ROUTECODEX_MOCK_SAMPLES_DIR) {
      return false;
    }
    return true;
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
      // Mock regressions run many short-lived servers; skip daemon to avoid flakiness from lingering background tasks.
      if (this.shouldStartManagerDaemon() && !this.managerDaemon) {
        const serverId = canonicalizeServerId(this.config.server.host, this.config.server.port);
        const daemon = new ManagerDaemon({ serverId, quotaRoutingEnabled: this.isQuotaRoutingEnabled() });
        daemon.registerModule(new TokenManagerModule());
        daemon.registerModule(new RoutingStateManagerModule());
        daemon.registerModule(new HealthManagerModule());
        // Quota manager（当前仅用于 antigravity/gemini-cli 等需要配额信息的 Provider）
        try {
          const mod = (await import('../../../manager/modules/quota/index.js')) as {
            QuotaManagerModule?: new () => import('../../../manager/modules/quota/index.js').QuotaManagerModule;
          };
          if (typeof mod.QuotaManagerModule === 'function') {
            daemon.registerModule(new mod.QuotaManagerModule());
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
        waitForPipelineReady: async () => await this.waitForRuntimeReady(),
        handleError: (error, context) => this.handleError(error, context),
        restartRuntimeFromDisk: async () => await this.restartRuntimeFromDisk(),
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
        getStatsSnapshot: () => ({
          session: this.stats.snapshot(Math.round(process.uptime() * 1000)),
          historical: this.stats.snapshotHistorical()
        }),
        getServerId: () => canonicalizeServerId(this.config.server.host, this.config.server.port)
      });

      this._isInitialized = true;

      console.log('[RouteCodexHttpServer] Initialization completed successfully');

    } catch (error) {
      await this.handleError(error as Error, 'initialization');
      throw error;
    }
  }

  private async restartRuntimeFromDisk(): Promise<{ reloadedAt: number; configPath: string; warnings?: string[] }> {
    // Serialize restarts to avoid racing provider disposals / hub updates.
    const run = async (): Promise<{ reloadedAt: number; configPath: string; warnings?: string[] }> => {
      const loaded = await loadRouteCodexConfig(this.config?.configPath);
      const userConfig = asRecord(loaded.userConfig) ?? {};
      const httpServerNode =
        asRecord((userConfig as Record<string, unknown>).httpserver) ??
        asRecord(asRecord((userConfig as Record<string, unknown>).modules)?.httpserver)?.config ??
        null;
      const nextApiKey = httpServerNode ? (typeof (httpServerNode as any).apikey === 'string' ? String((httpServerNode as any).apikey).trim() : '') : '';
      const nextHost = httpServerNode ? (typeof (httpServerNode as any).host === 'string' ? String((httpServerNode as any).host).trim() : '') : '';
      const nextPort = httpServerNode ? (typeof (httpServerNode as any).port === 'number' ? Number((httpServerNode as any).port) : NaN) : NaN;

      const warnings: string[] = [];
      // Best-effort: allow rotating apikey at runtime by mutating config object.
      if (typeof nextApiKey === 'string' && nextApiKey !== String(this.config.server.apikey || '')) {
        this.config.server.apikey = nextApiKey || undefined;
      }
      // host/port changes require rebind; record warnings but do not attempt to re-listen.
      if (nextHost && nextHost !== this.config.server.host) {
        warnings.push(`httpserver.host changed to "${nextHost}" but live server keeps "${this.config.server.host}" until process restart`);
      }
      if (Number.isFinite(nextPort) && nextPort > 0 && nextPort !== this.config.server.port) {
        warnings.push(`httpserver.port changed to ${nextPort} but live server keeps ${this.config.server.port} until process restart`);
      }

      // Keep the server's configPath aligned with what was loaded.
      this.config.configPath = loaded.configPath;

      await this.reloadRuntime(loaded.userConfig, { providerProfiles: loaded.providerProfiles });
      return { reloadedAt: Date.now(), configPath: loaded.configPath, ...(warnings.length ? { warnings } : {}) };
    };

    const slot = this.restartChain.then(run);
    this.restartChain = slot.then(() => undefined, () => undefined);
    return await slot;
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

      // In test runners (Jest), prevent the listen handle from keeping the process alive
      // in case some keep-alive sockets linger.
      if (process.env.JEST_WORKER_ID || process.env.NODE_ENV === 'test') {
        try {
          (this.server as unknown as { unref?: () => void }).unref?.();
        } catch {
          // ignore
        }
      }

      this.server.on('connection', (socket: Socket) => {
        this.activeSockets.add(socket);
        socket.on('close', () => {
          this.activeSockets.delete(socket);
        });
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
      // Best-effort: close any open keep-alive sockets so server.close can finish.
      for (const socket of this.activeSockets) {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      }
      this.activeSockets.clear();
      try {
        const srv = this.server as unknown as {
          closeIdleConnections?: () => void;
          closeAllConnections?: () => void;
        };
        srv.closeIdleConnections?.();
        srv.closeAllConnections?.();
      } catch {
        // ignore
      }
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
          try {
            this.server?.removeAllListeners();
          } catch {
            // ignore
          }
          this.server = undefined;
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
    try {
      this.updateProviderProfiles(context?.providerProfiles, userConfig);
      await this.setupRuntime(userConfig);
      if (!this.runtimeReadyResolved) {
        this.runtimeReadyResolved = true;
        this.runtimeReadyResolve?.();
      }
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.runtimeReadyError = normalized;
      if (!this.runtimeReadyResolved) {
        this.runtimeReadyReject?.(normalized);
      }
      throw error;
    }
  }

  public async reloadRuntime(
    userConfig: UnknownObject,
    context?: { providerProfiles?: ProviderProfileCollection }
  ): Promise<void> {
    this.updateProviderProfiles(context?.providerProfiles, userConfig);
    await this.setupRuntime(userConfig);
    if (!this.runtimeReadyResolved) {
      this.runtimeReadyResolved = true;
      this.runtimeReadyResolve?.();
    }
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

    // Unified Hub Framework V1: policy rollout toggle.
    // Default: enforce (Phase 1: Responses-first outbound policy; currently only
    // affects openai-responses provider outbound payload).
    // - Disable via env: ROUTECODEX_HUB_POLICY_MODE=off
    // - Enforce via env: ROUTECODEX_HUB_POLICY_MODE=enforce
    const hubPolicyModeRaw = String(process.env.ROUTECODEX_HUB_POLICY_MODE || '').trim().toLowerCase();
    const hubPolicyMode =
      hubPolicyModeRaw === 'off' || hubPolicyModeRaw === '0' || hubPolicyModeRaw === 'false'
        ? null
        : (hubPolicyModeRaw === 'observe' || hubPolicyModeRaw === 'enforce' ? hubPolicyModeRaw : 'enforce');

    this.hubPolicyMode = hubPolicyMode ?? 'off';

    if (hubPolicyMode) {
      const sampleRateRaw = String(process.env.ROUTECODEX_HUB_POLICY_SAMPLE_RATE || '').trim();
      const sampleRate = sampleRateRaw ? Number(sampleRateRaw) : undefined;
      hubConfig.policy = {
        mode: hubPolicyMode,
        ...(Number.isFinite(sampleRate) ? { sampleRate } : {})
      };
    }

    // Unified Hub Framework V1: tool surface rollout toggle (enforce by default in dev).
    // - Disable via env: ROUTECODEX_HUB_TOOL_SURFACE_MODE=off
    // - Observe via env: ROUTECODEX_HUB_TOOL_SURFACE_MODE=observe
    // - Shadow (diff-only, no rewrites) via env: ROUTECODEX_HUB_TOOL_SURFACE_MODE=shadow
    // - Enforce (rewrite outbound payload) via env: ROUTECODEX_HUB_TOOL_SURFACE_MODE=enforce
    const toolSurfaceModeRaw = String(process.env.ROUTECODEX_HUB_TOOL_SURFACE_MODE || '').trim().toLowerCase();
    const toolSurfaceMode =
      toolSurfaceModeRaw === 'off' || toolSurfaceModeRaw === '0' || toolSurfaceModeRaw === 'false'
        ? null
        : toolSurfaceModeRaw === 'observe' || toolSurfaceModeRaw === 'shadow' || toolSurfaceModeRaw === 'enforce'
          ? toolSurfaceModeRaw
          : buildInfo.mode === 'dev'
            ? 'enforce'
            : null;

    if (toolSurfaceMode) {
      const sampleRateRaw = String(process.env.ROUTECODEX_HUB_TOOL_SURFACE_SAMPLE_RATE || '').trim();
      const sampleRate = sampleRateRaw ? Number(sampleRateRaw) : undefined;
      hubConfig.toolSurface = {
        mode: toolSurfaceMode,
        ...(Number.isFinite(sampleRate) ? { sampleRate } : {})
      };
      // Also export the resolved mode to env so llmswitch-core response conversion
      // (convertProviderResponse) can observe tool surface mismatches consistently.
      if (!process.env.ROUTECODEX_HUB_TOOL_SURFACE_MODE) {
        process.env.ROUTECODEX_HUB_TOOL_SURFACE_MODE = toolSurfaceMode;
      }
    }

    // Unified Hub Framework V1: followup (servertool) shadow compare toggle.
    // Implemented in llmswitch-core servertool engine; controlled by env for progressive rollout.
    // Default: shadow in dev builds; off in release builds.
    if (!process.env.ROUTECODEX_HUB_FOLLOWUP_MODE) {
      if (buildInfo.mode === 'dev') {
        process.env.ROUTECODEX_HUB_FOLLOWUP_MODE = 'shadow';
      }
    }

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
    const quotaModule = this.managerDaemon?.getModule('quota') as unknown as
      | { getQuotaView?: () => unknown; getQuotaViewReadOnly?: () => unknown }
      | undefined;
    if (this.isQuotaRoutingEnabled() && quotaModule && typeof quotaModule.getQuotaView === 'function') {
      hubConfig.quotaView = quotaModule.getQuotaView() as any;
      if (typeof quotaModule.getQuotaViewReadOnly === 'function') {
        (hubConfig as Record<string, unknown>).quotaViewReadOnly = quotaModule.getQuotaViewReadOnly();
      }
    }
    if (!this.hubPipeline) {
      this.hubPipeline = new hubCtor(hubConfig);
    } else {
      const existing = this.hubPipeline as unknown as {
        updateRuntimeDeps?: (deps: { healthStore?: unknown; routingStateStore?: unknown; quotaView?: unknown }) => void;
        updateVirtualRouterConfig?: (config: unknown) => void;
      };
      try {
        existing.updateRuntimeDeps?.({
          ...(healthStore ? { healthStore } : {}),
          ...(routingStateStore ? { routingStateStore } : {}),
          ...('quotaView' in hubConfig ? { quotaView: hubConfig.quotaView } : {})
        });
      } catch {
        // best-effort: runtime deps updates must never block reload
      }
      this.hubPipeline.updateVirtualRouterConfig(bootstrapArtifacts.config);
    }

    // llms-engine shadow: capture the latest hub config and reset shadow pipeline to avoid stale deps.
    this.hubPipelineConfigForShadow = hubConfig as unknown as Record<string, unknown>;
    this.hubPipelineEngineShadow = null;

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
    this.providerRuntimeInitErrors.clear();

    // Antigravity UA preload (best-effort):
    // - fetch latest UA version once (cached)
    // - load per-alias camoufox fingerprints so UA suffix stays stable per OAuth session
    try {
      const aliases: string[] = [];
      for (const [providerKey, runtime] of Object.entries(runtimeMap)) {
        const key = typeof providerKey === 'string' ? providerKey.trim() : '';
        const rk =
          runtime && typeof (runtime as any).runtimeKey === 'string'
            ? String((runtime as any).runtimeKey).trim()
            : '';
        for (const candidate of [rk, key]) {
          if (!candidate.toLowerCase().startsWith('antigravity.')) {
            continue;
          }
          const parts = candidate.split('.');
          if (parts.length >= 2 && parts[1] && parts[1].trim()) {
            aliases.push(parts[1].trim());
          }
        }
      }
      if (aliases.length) {
        await Promise.allSettled([
          primeAntigravityUserAgentVersion(),
          preloadAntigravityAliasUserAgents(aliases)
        ]);
      }
    } catch {
      // UA preload must never block runtime init/reload
    }

    const quotaModule = this.managerDaemon?.getModule('quota') as
      | {
          registerProviderStaticConfig?: (
            providerKey: string,
            config: { authType?: string | null; priorityTier?: number | null; apikeyDailyResetTime?: string | null }
          ) => void;
          disableProvider?: (options: { providerKey: string; mode: 'cooldown' | 'blacklist'; durationMs: number }) => Promise<unknown>;
        }
      | undefined;

    // Antigravity warmup (strict): if UA fingerprint suffix doesn't match local OAuth fingerprint, blacklist the alias.
    if (isAntigravityWarmupEnabled()) {
      try {
        const providerKeysByAlias = new Map<string, string[]>();
        for (const providerKey of Object.keys(runtimeMap)) {
          const key = typeof providerKey === 'string' ? providerKey.trim() : '';
          if (!key.toLowerCase().startsWith('antigravity.')) {
            continue;
          }
          const parts = key.split('.');
          if (parts.length < 3) {
            continue;
          }
          const alias = parts[1]?.trim();
          if (!alias) {
            continue;
          }
          const list = providerKeysByAlias.get(alias) || [];
          list.push(key);
          providerKeysByAlias.set(alias, list);
        }

        if (providerKeysByAlias.size > 0) {
          const canBlacklist = Boolean(quotaModule && typeof quotaModule.disableProvider === 'function');
          const durationMs = getAntigravityWarmupBlacklistDurationMs();
          let okCount = 0;
          let failCount = 0;
          for (const [alias, providerKeys] of providerKeysByAlias.entries()) {
            const result = await warmupCheckAntigravityAlias(alias);
            if (result.ok) {
              okCount += 1;
              console.log(
                `[antigravity:warmup] ok alias=${alias} profile=${result.profileId} fp_os=${result.fingerprintOs} fp_arch=${result.fingerprintArch} ua_suffix=${result.actualSuffix} ua=${result.actualUserAgent}`
              );
              continue;
            }
            failCount += 1;
            const expected = result.expectedSuffix ? ` expected=${result.expectedSuffix}` : '';
            const actual = result.actualSuffix ? ` actual=${result.actualSuffix}` : '';
            const hint =
              result.reason === 'linux_not_allowed'
                ? ` hint="run: routecodex camoufox-fp repair --provider antigravity --alias ${alias}"`
                : result.reason === 'reauth_required'
                  ? ` hint="run: routecodex oauth antigravity-auto ${result.tokenFile || `antigravity-oauth-*-` + alias + `.json`}"` +
                    `${result.fromSuffix ? ` from=${result.fromSuffix}` : ''}${result.toSuffix ? ` to=${result.toSuffix}` : ''}`
                  : '';
            console.error(
              `[antigravity:warmup] FAIL alias=${alias} profile=${result.profileId}${result.fingerprintOs ? ` fp_os=${result.fingerprintOs}` : ''}${result.fingerprintArch ? ` fp_arch=${result.fingerprintArch}` : ''} reason=${result.reason}${expected}${actual}${hint} providerKeys=${providerKeys.length}${canBlacklist ? '' : ' (quota module unavailable; cannot blacklist)'}`
            );
            if (canBlacklist) {
              await Promise.allSettled(
                providerKeys.map((providerKey) =>
                  quotaModule!.disableProvider!({ providerKey, mode: 'blacklist', durationMs })
                )
              );
            }
          }
          console.log(`[antigravity:warmup] summary ok=${okCount} fail=${failCount} total=${providerKeysByAlias.size}`);
        }
      } catch {
        // warmup is best-effort; never block server startup
      }
    }

    // Multiple providerKeys may share the same runtimeKey (single provider handle with multiple models).
    // Quota is tracked by providerKey, so we need a stable way to derive authType for every key,
    // even when the handle has already been created for this runtimeKey.
    const runtimeKeyAuthType = new Map<string, string | null>();
    const apikeyDailyResetTime = (() => {
      const vr = this.userConfig && typeof this.userConfig === 'object' ? (this.userConfig as any).virtualrouter : null;
      const quota = vr && typeof vr === 'object' && !Array.isArray(vr) ? (vr as any).quota : null;
      if (!quota || typeof quota !== 'object' || Array.isArray(quota)) {
        return null;
      }
      const raw =
        typeof (quota as any).apikeyDailyResetTime === 'string'
          ? (quota as any).apikeyDailyResetTime
          : typeof (quota as any).apikeyResetTime === 'string'
            ? (quota as any).apikeyResetTime
            : typeof (quota as any).apikeyReset === 'string'
              ? (quota as any).apikeyReset
              : null;
      const trimmed = typeof raw === 'string' ? raw.trim() : '';
      return trimmed ? trimmed : null;
    })();

    const failedRuntimeKeys = new Set<string>();

    for (const [providerKey, runtime] of Object.entries(runtimeMap)) {
      if (!runtime) { continue; }
      const runtimeKey = runtime.runtimeKey || providerKey;

      const authTypeFromRuntime =
        runtime && (runtime as any).auth && typeof (runtime as any).auth.type === 'string'
          ? String((runtime as any).auth.type).trim()
          : null;

      if (failedRuntimeKeys.has(runtimeKey)) {
        continue;
      }

      if (!this.providerHandles.has(runtimeKey)) {
        let patchedRuntime: ProviderRuntimeProfile | null = null;
        try {
          const resolvedRuntime = await this.materializeRuntimeProfile(runtime);
          patchedRuntime = this.applyProviderProfileOverrides(resolvedRuntime);
          try {
            const authTypeFromPatched =
              patchedRuntime && patchedRuntime.auth && typeof (patchedRuntime.auth as { type?: unknown }).type === 'string'
                ? String((patchedRuntime.auth as { type?: string }).type).trim()
                : null;
            if (authTypeFromPatched) {
              runtimeKeyAuthType.set(runtimeKey, authTypeFromPatched);
            } else if (authTypeFromRuntime) {
              runtimeKeyAuthType.set(runtimeKey, authTypeFromRuntime);
            } else if (!runtimeKeyAuthType.has(runtimeKey)) {
              runtimeKeyAuthType.set(runtimeKey, null);
            }
          } catch {
            // ignore authType derivation failures
          }

          const handle = await this.createProviderHandle(runtimeKey, patchedRuntime);
          this.providerHandles.set(runtimeKey, handle);
          this.providerRuntimeInitErrors.delete(runtimeKey);
        } catch (error) {
          // Non-blocking: do not crash server startup when a provider is misconfigured (e.g. missing env var).
          // Emit a provider error so health/quota modules can mark it unhealthy and routing can fail over.
          failedRuntimeKeys.add(runtimeKey);
          if (error instanceof Error) {
            this.providerRuntimeInitErrors.set(runtimeKey, error);
          } else {
            this.providerRuntimeInitErrors.set(runtimeKey, new Error(String(error)));
          }
          try {
            const { emitProviderError } = await import('../../../providers/core/utils/provider-error-reporter.js');
            emitProviderError({
              error,
              stage: 'provider.runtime.init',
              runtime: {
                requestId: `startup_${Date.now()}`,
                providerKey,
                providerId: runtime.providerId || runtimeKey.split('.')[0],
                providerType: String((runtime as any).providerType || runtime.providerType || 'unknown'),
                providerProtocol: String((runtime as any).outboundProfile || ''),
                routeName: 'startup',
                pipelineId: 'startup',
                runtimeKey
              },
              dependencies: this.getModuleDependencies(),
              recoverable: false,
              affectsHealth: true,
              details: {
                reason: 'provider_init_failed',
                runtimeKey,
                providerKey
              }
            });
          } catch {
            // ignore emit failures
          }
          // Skip this providerKey mapping; requests will fail over if routing selects it.
          continue;
        }
      }

      // Register static quota metadata for every providerKey (not just per runtimeKey).
      // Use the runtimeKey authType when available so shared runtimeKey models inherit correct policy.
      try {
        const authType = runtimeKeyAuthType.get(runtimeKey) ?? authTypeFromRuntime;
        const apikeyResetForKey = authType === 'apikey' ? apikeyDailyResetTime : null;
        quotaModule?.registerProviderStaticConfig?.(providerKey, {
          authType: authType ?? null,
          apikeyDailyResetTime: apikeyResetForKey
        });
      } catch {
        // best-effort: quota static config registration must never block runtime init
      }

      // Only map providerKey when runtimeKey has an initialized handle.
      if (this.providerHandles.has(runtimeKey)) {
        this.providerKeyToRuntimeKey.set(providerKey, runtimeKey);
      }
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
      if (this.isSafeSecretReference(inline)) {
        return await this.resolveSecretValue(inline);
      }
      return inline;
    }

    const rawSecretRef = typeof auth?.secretRef === 'string' ? auth.secretRef.trim() : '';
    // llmswitch-core may populate secretRef as a stable signature (e.g. "provider.alias").
    // Only treat it as a resolvable secret reference when it matches our safe reference grammar.
    if (rawSecretRef && this.isSafeSecretReference(rawSecretRef)) {
      const resolved = await this.resolveSecretValue(rawSecretRef);
      if (resolved) {
        return resolved;
      }
    }

    // Local OpenAI-compatible endpoints (e.g., LM Studio) may not require auth.
    // Keep fail-fast for remote providers by only allowing empty apiKey when baseURL is local.
    const baseURL =
      typeof (runtime as any)?.baseURL === 'string'
        ? String((runtime as any).baseURL).trim()
        : typeof (runtime as any)?.baseUrl === 'string'
          ? String((runtime as any).baseUrl).trim()
          : typeof (runtime as any)?.endpoint === 'string'
            ? String((runtime as any).endpoint).trim()
            : '';
    if (this.isLocalBaseUrl(baseURL)) {
      return '';
    }

    throw new Error(`Provider runtime "${runtime.runtimeKey || runtime.providerId}" missing API key`);
  }

  private isLocalBaseUrl(value: string): boolean {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) {
      return false;
    }
    try {
      const url = new URL(raw);
      const host = String(url.hostname || '').trim().toLowerCase();
      return (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '0.0.0.0' ||
        host === '::1' ||
        host === '::ffff:127.0.0.1'
      );
    } catch {
      const lower = raw.toLowerCase();
      return (
        lower.includes('localhost') ||
        lower.includes('127.0.0.1') ||
        lower.includes('0.0.0.0') ||
        lower.includes('[::1]')
      );
    }
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
    // Stats must remain stable across provider retries and requestId enhancements.
    const statsRequestId = input.requestId;
    this.stats.recordRequestStart(statsRequestId);
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
    const iterationMetadata = initialMetadata;
    // _followupTriggered = false;
    // 单次 HTTP 请求内允许多次 failover（不在 Provider 层做重试）：
    // - 让 VirtualRouter 根据 excludedProviderKeys 跳过失败目标
    // - 避免客户端“一次就断”导致对话破裂（尤其是 429 / prompt too long 等可恢复错误）
    // - 通过 env 允许按部署/客户端调整：ROUTECODEX_MAX_PROVIDER_ATTEMPTS / RCC_MAX_PROVIDER_ATTEMPTS
    let maxAttempts = resolveMaxProviderAttempts();
    let attempt = 0;
    let firstError: unknown | null = null;
    const originalBodySnapshot = this.cloneRequestPayload(input.body);
    const excludedProviderKeys = new Set<string>();
    let initialRoutePool: string[] | null = null;

    while (attempt < maxAttempts) {
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
      if (!initialRoutePool && Array.isArray(pipelineResult.routingDecision?.pool)) {
        initialRoutePool = [...pipelineResult.routingDecision!.pool];
      }

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
        const error = Object.assign(new Error(`Runtime for provider ${target.providerKey} not initialized`), {
          code: 'ERR_RUNTIME_NOT_FOUND',
          requestId: input.requestId,
          retryable: true
        });
        if (!firstError) {
          firstError = error;
        }
        excludedProviderKeys.add(target.providerKey);
        this.logStage('provider.retry', input.requestId, {
          providerKey: target.providerKey,
          attempt,
          nextAttempt: attempt + 1,
          excluded: Array.from(excludedProviderKeys),
          reason: 'runtime_not_initialized'
        });
        continue;
      }

      const handle = this.providerHandles.get(runtimeKey);
      if (!handle) {
        const initError = this.providerRuntimeInitErrors.get(runtimeKey);
        const error = Object.assign(
          new Error(
            initError
              ? `Provider runtime ${runtimeKey} failed to initialize: ${initError.message}`
              : `Provider runtime ${runtimeKey} not found`
          ),
          {
          code: 'ERR_PROVIDER_NOT_FOUND',
          requestId: input.requestId,
          retryable: true
          }
        );
        if (!firstError) {
          firstError = error;
        }
        excludedProviderKeys.add(target.providerKey);
        this.logStage('provider.retry', input.requestId, {
          providerKey: target.providerKey,
          attempt,
          nextAttempt: attempt + 1,
          excluded: Array.from(excludedProviderKeys),
          reason: 'provider_runtime_missing'
        });
        continue;
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
      // /v1/responses tool loop depends on a stable requestId mapping between:
      // - inbound conversion capture (uses the initial requestId), and
      // - outbound response record (may run after requestId enhancement).
      // Enhancement happens for all providers, so rebind must be keyed off the client endpoint,
      // not the providerProtocol (which can be gemini-chat/anthropic-messages/etc.).
      if (String(input.entryEndpoint || '').startsWith('/v1/responses')) {
        try {
          await rebindResponsesConversationRequestId(providerRequestId, enhancedRequestId);
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

      this.stats.bindProvider(statsRequestId, {
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
        const pipelineProcessed = pipelineResult.processedRequest;
        const pipelineStandardized = pipelineResult.standardizedRequest;
        const requestSemantics =
          pipelineProcessed && typeof pipelineProcessed === 'object' && typeof (pipelineProcessed as any).semantics === 'object'
            ? ((pipelineProcessed as any).semantics as Record<string, unknown>)
            : pipelineStandardized && typeof pipelineStandardized === 'object' && typeof (pipelineStandardized as any).semantics === 'object'
              ? ((pipelineStandardized as any).semantics as Record<string, unknown>)
              : undefined;
        const converted = await this.convertProviderResponseIfNeeded({
          entryEndpoint: input.entryEndpoint,
          providerType: handle.providerType,
          requestId: input.requestId,
          wantsStream: wantsStreamBase,
          originalRequest: originalRequestSnapshot,
          requestSemantics:
            requestSemantics,
          processMode: pipelineResult.processMode,
          response: normalized,
          pipelineMetadata: mergedMetadata
        });

        const usage = this.extractUsageFromResult(converted, mergedMetadata);
        // QuotaManager listens to provider error/success events; avoid duplicating accounting here.
        this.stats.recordCompletion(statsRequestId, { usage, error: false });

        // Notify llmswitch-core about successful completion so session-scoped routing state
        // (e.g. Antigravity alias bindings) can be committed only after the first success.
        try {
          const center = await getProviderSuccessCenter().catch(() => null);
          const sessionId =
            typeof mergedMetadata.sessionId === 'string' && mergedMetadata.sessionId.trim()
              ? mergedMetadata.sessionId.trim()
              : undefined;
          const conversationId =
            typeof mergedMetadata.conversationId === 'string' && mergedMetadata.conversationId.trim()
              ? mergedMetadata.conversationId.trim()
              : undefined;
          center?.emit({
            runtime: {
              requestId: input.requestId,
              routeName: pipelineResult.routingDecision?.routeName,
              providerKey: target.providerKey,
              providerId: handle.providerId,
              providerType: handle.providerType,
              providerProtocol,
              pipelineId: target.providerKey,
              target
            },
            timestamp: Date.now(),
            metadata: {
              ...(sessionId ? { sessionId } : {}),
              ...(conversationId ? { conversationId } : {})
            }
          });
        } catch {
          // best-effort: must never affect request path
        }

        // 回传 session_id 和 conversation_id 到响应头（如果存在）
        const sessionId = typeof mergedMetadata.sessionId === "string" && mergedMetadata.sessionId.trim()
          ? mergedMetadata.sessionId.trim()
          : undefined;
        let conversationId = typeof mergedMetadata.conversationId === "string" && mergedMetadata.conversationId.trim()
          ? mergedMetadata.conversationId.trim()
          : undefined;

        // 对称补齐：如果只有 session_id，则回传 conversation_id=session_id
        if (!conversationId && sessionId) {
          conversationId = sessionId;
        }

        if (sessionId || conversationId) {
          if (!converted.headers) {
            converted.headers = {};
          }
          if (sessionId && !converted.headers["session_id"]) {
            converted.headers["session_id"] = sessionId;
          }
          if (conversationId && !converted.headers["conversation_id"]) {
            converted.headers["conversation_id"] = conversationId;
          }
        }

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
        if (isAntigravityProviderKey(target.providerKey) && extractStatusCodeFromError(error) === 429) {
          maxAttempts = Math.max(maxAttempts, resolveAntigravityMaxProviderAttempts());
        }
        // QuotaManager listens to provider error events emitted by providers.
        if (!firstError) {
          firstError = error;
        }
        const shouldRetry = attempt < maxAttempts && shouldRetryProviderError(error);
        if (!shouldRetry) {
          this.stats.recordCompletion(statsRequestId, { error: true });
          throw error;
        }
        // Record this failed provider attempt even if the overall request succeeds later via failover.
        this.stats.recordCompletion(statsRequestId, { error: true });
        const singleProviderPool =
          Boolean(initialRoutePool && initialRoutePool.length === 1 && initialRoutePool[0] === target.providerKey);
        if (singleProviderPool) {
          if (isNetworkTransportError(error)) {
            await waitBeforeRetry(error);
          }
        } else if (target.providerKey) {
          excludedProviderKeys.add(target.providerKey);
        }
        this.logStage('provider.retry', input.requestId, {
          providerKey: target.providerKey,
          attempt,
          nextAttempt: attempt + 1,
          excluded: Array.from(excludedProviderKeys),
          reason: describeRetryReason(error)
        });
        continue;
      }
    }

    // best-effort: if failover attempt could not produce a successful response,
    // return the original error (avoid masking 429 with PROVIDER_NOT_AVAILABLE etc.).
    this.stats.recordCompletion(statsRequestId, { error: true });
    throw firstError ?? new Error('Provider execution failed without response');
  }

  private async runHubPipeline(
    input: PipelineExecutionInput,
    metadata: Record<string, unknown>
  ): Promise<{
    requestId: string;
    providerPayload: Record<string, unknown>;
    standardizedRequest?: Record<string, unknown>;
    processedRequest?: Record<string, unknown>;
    target: {
      providerKey: string;
      providerType: string;
      outboundProfile: string;
      runtimeKey?: string;
      processMode?: string;
    };
    routingDecision?: { routeName?: string; pool?: string[] };
    processMode: string;
    metadata: Record<string, unknown>;
  }> {
    if (!this.hubPipeline) {
      throw new Error('Hub pipeline runtime is not initialized');
    }
    const payload = asRecord(input.body);
    const isInternalFollowup = asRecord((metadata as any).__rt)?.serverToolFollowup === true;
    const wantsShadowCompare = !isInternalFollowup && shouldRunHubShadowCompare(this.hubShadowCompareConfig);
    const pipelineInput: PipelineExecutionInput & { payload: Record<string, unknown> } & { id?: string; endpoint?: string } = {
      ...input,
      id: input.requestId,
      endpoint: input.entryEndpoint,
      metadata: {
        ...metadata,
        logger: this.coloredLogger,
        ...(wantsShadowCompare
          ? { __hubShadowCompare: { baselineMode: this.hubShadowCompareConfig.baselineMode } }
          : {})
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

	    const llmsEngineShadowEnabled =
	      !isInternalFollowup &&
	      isLlmsEngineShadowEnabledForSubpath(this.llmsEngineShadowConfig, 'conversion/hub/pipeline');
	    if (llmsEngineShadowEnabled) {
	      // Fail fast: if shadow is enabled for this module, engine core must be available.
	      await this.ensureHubPipelineEngineShadow();
	    }
	    const wantsLlmsEngineShadow =
	      llmsEngineShadowEnabled &&
	      shouldRunLlmsEngineShadowForSubpath(this.llmsEngineShadowConfig, 'conversion/hub/pipeline');

	    // Unified Hub Framework V1: runtime black-box shadow compare (baseline policy vs current policy).
    // - baseline payload is computed in the SAME hub pipeline execution (single-pass)
    // - only writes errorsample when diff exists
    try {
      const shadow = (result.metadata as any)?.hubShadowCompare;
      const baselineProviderPayload =
        shadow && typeof shadow === 'object' && !Array.isArray(shadow)
          ? (shadow as any).baselineProviderPayload
          : undefined;
      if (wantsShadowCompare && baselineProviderPayload && typeof baselineProviderPayload === 'object') {
        const entryEndpoint = String(input.entryEndpoint || '/v1/chat/completions');
        const routeHint =
          typeof (metadata as Record<string, unknown>).routeHint === 'string'
            ? String((metadata as Record<string, unknown>).routeHint)
            : undefined;
        const excludedProviderKeys =
          Array.isArray((metadata as Record<string, unknown>).excludedProviderKeys)
            ? ((metadata as Record<string, unknown>).excludedProviderKeys as string[])
            : [];

        const cloneJsonSafe = <T>(value: T): T => {
          try {
            return JSON.parse(JSON.stringify(value)) as T;
          } catch {
            return value;
          }
        };

        const candidateOut = {
          providerPayload: cloneJsonSafe(result.providerPayload),
          target: cloneJsonSafe(result.target),
          metadata: {
            entryEndpoint: result.metadata?.entryEndpoint,
            providerProtocol: result.metadata?.providerProtocol,
            processMode: result.metadata?.processMode,
            stream: result.metadata?.stream,
            routeHint: result.metadata?.routeHint
          }
        };

        void (async () => {
          try {
            const baselineOut = {
              providerPayload: cloneJsonSafe(baselineProviderPayload),
              target:
                shadow && typeof shadow === 'object' && !Array.isArray(shadow) && (shadow as any).baselineTarget
                  ? cloneJsonSafe((shadow as any).baselineTarget)
                  : cloneJsonSafe(result.target),
              metadata: {
                entryEndpoint: result.metadata?.entryEndpoint,
                providerProtocol: result.metadata?.providerProtocol,
                processMode: result.metadata?.processMode,
                stream: result.metadata?.stream,
                routeHint: result.metadata?.routeHint
              }
            };

            await recordHubShadowCompareDiff({
              requestId: derivedRequestId,
              entryEndpoint,
              routeHint,
              excludedProviderKeys,
              baselineMode: this.hubShadowCompareConfig.baselineMode,
              candidateMode: typeof shadow?.candidateMode === 'string' ? shadow.candidateMode : (this.hubPolicyMode ?? undefined),
              baselineOut,
              candidateOut
            });
          } catch (error) {
            // eslint-disable-next-line no-console
            console.error('[unified-hub-shadow-runtime] baseline compare failed:', error);
          }
        })();
      }
	    } catch {
	      // best-effort only
	    }

	    // llms-engine: runtime black-box shadow compare (TS vs engine) for hub pipeline.
	    if (wantsLlmsEngineShadow) {
	      const cloneJsonSafe = <T>(value: T): T => {
	        try {
	          return JSON.parse(JSON.stringify(value)) as T;
	        } catch {
	          return value;
	        }
	      };
	      const entryEndpoint = String(input.entryEndpoint || '/v1/chat/completions');
	      const routeHint =
	        typeof (metadata as Record<string, unknown>).routeHint === 'string'
	          ? String((metadata as Record<string, unknown>).routeHint)
	          : undefined;
	      const baselineOut = {
	        providerPayload: cloneJsonSafe(result.providerPayload),
	        target: cloneJsonSafe(result.target),
	        metadata: {
	          entryEndpoint: result.metadata?.entryEndpoint,
	          providerProtocol: result.metadata?.providerProtocol,
	          processMode: result.metadata?.processMode,
	          stream: result.metadata?.stream,
	          routeHint: result.metadata?.routeHint
	        }
	      };

		      void (async () => {
		        try {
		          const shadowPipeline = await this.ensureHubPipelineEngineShadow();
		          const shadowRequestId = `${input.requestId}__llms_engine_shadow`;
		          const baseMeta = (pipelineInput as unknown as { metadata?: unknown }).metadata;
		          const shadowInput = {
		            ...(pipelineInput as unknown as Record<string, unknown>),
		            id: shadowRequestId,
		            endpoint: input.entryEndpoint,
		            metadata: {
		              ...(baseMeta && typeof baseMeta === 'object' ? (baseMeta as Record<string, unknown>) : {}),
		              __llmsEngineShadow: { baselineRequestId: derivedRequestId, entryEndpoint, routeHint }
		            },
		            payload: cloneJsonSafe(payload)
		          } as unknown as PipelineExecutionInput & { payload: Record<string, unknown> };
		          const shadowResult = await shadowPipeline.execute(shadowInput);
		          if (!shadowResult?.providerPayload || !shadowResult?.target) {
		            return;
		          }
	          const candidateOut = {
	            providerPayload: cloneJsonSafe(shadowResult.providerPayload),
	            target: cloneJsonSafe(shadowResult.target),
	            metadata: {
	              entryEndpoint: shadowResult.metadata?.entryEndpoint,
	              providerProtocol: shadowResult.metadata?.providerProtocol,
	              processMode: shadowResult.metadata?.processMode,
	              stream: shadowResult.metadata?.stream,
	              routeHint: shadowResult.metadata?.routeHint
	            }
	          };
	          await recordLlmsEngineShadowDiff({
	            group: 'hub-pipeline',
	            requestId: derivedRequestId,
	            subpath: 'conversion/hub/pipeline',
	            baselineImpl: 'ts',
	            candidateImpl: 'engine',
	            baselineOut,
	            candidateOut
	          });
	        } catch (error) {
	          // eslint-disable-next-line no-console
	          console.error('[llms-engine-shadow] hub pipeline shadow failed:', error);
	        }
	      })();
	    }
		    return {
		      requestId: derivedRequestId,
		      providerPayload: result.providerPayload,
          standardizedRequest:
            result.standardizedRequest && typeof result.standardizedRequest === 'object'
              ? (result.standardizedRequest as Record<string, unknown>)
              : undefined,
          processedRequest:
            result.processedRequest && typeof result.processedRequest === 'object'
              ? (result.processedRequest as Record<string, unknown>)
              : undefined,
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
    const runtimeFromUser = asRecord(userMeta.runtime);
    const llmsVersion = resolveLlmswitchCoreVersion();
    const metadata: Record<string, unknown> = {
      ...userMeta,
      entryEndpoint: input.entryEndpoint,
      processMode,
      direction: 'request',
      stage: 'inbound',
      routeHint,
      stream: userMeta.stream === true,
      runtime: {
        ...(runtimeFromUser ?? {}),
        routecodex: {
          version: buildInfo.version,
          mode: buildInfo.mode
        },
        llmswitchCore: llmsVersion ? { version: llmsVersion } : undefined,
        node: { version: process.version }
      },
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
    const identifiers = extractSessionIdentifiersFromMetadata(metadata);
    if (identifiers.sessionId) {
      metadata.sessionId = identifiers.sessionId;
    }
    if (identifiers.conversationId) {
      metadata.conversationId = identifiers.conversationId;
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
    requestSemantics?: Record<string, unknown>;
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

        // 基于首次 HubPipeline metadata + 调用方注入的 metadata 构建新的请求 metadata。
        // 不在 Host 层编码 servertool/web_search 等语义，由 llmswitch-core 负责。
        const nestedMetadata: Record<string, unknown> = {
          ...(metadataBag ?? {}),
          ...nestedExtra,
          entryEndpoint: nestedEntry,
          direction: 'request',
          stage: 'inbound'
        };

        // servertool followup 是内部二跳请求：不应继承客户端 headers 偏好（尤其是 Accept），
        // 否则会导致上游返回非 SSE 响应而被当作 SSE 解析，出现“空回复”。
        // E1: merge internal runtime metadata carrier (`__rt`) instead of clobbering it.
        try {
          const baseRt = asRecord((metadataBag as any)?.__rt) ?? {};
          const extraRt = asRecord((nestedExtra as any)?.__rt) ?? {};
          if (Object.keys(baseRt).length || Object.keys(extraRt).length) {
            (nestedMetadata as any).__rt = { ...baseRt, ...extraRt };
          }
        } catch {
          // best-effort
        }

        if (asRecord((nestedMetadata as any).__rt)?.serverToolFollowup === true) {
          delete nestedMetadata.clientHeaders;
          delete nestedMetadata.clientRequestId;
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
        requestSemantics: options.requestSemantics,
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
      const statusCandidate =
        typeof (errRecord as { status?: unknown }).status === 'number'
          ? (errRecord as { status: number }).status
          : typeof (errRecord as { statusCode?: unknown }).statusCode === 'number'
            ? (errRecord as { statusCode: number }).statusCode
            : undefined;
      const isSseDecodeError =
        errCode === 'SSE_DECODE_ERROR' ||
        (errName === 'ProviderProtocolError' && message.toLowerCase().includes('sse'));
      const isServerToolFollowupError =
        errCode === 'SERVERTOOL_FOLLOWUP_FAILED' ||
        errCode === 'SERVERTOOL_EMPTY_FOLLOWUP' ||
        (typeof errCode === 'string' && errCode.startsWith('SERVERTOOL_'));
      const isProviderProtocolError = errName === 'ProviderProtocolError';
      // If we need to stream a client response, conversion failures are fatal: there is no safe fallback
      // that preserves protocol correctness.
      const isStreamingConversion = Boolean(options.wantsStream && (needsAnthropicConversion || needsResponsesConversion || needsChatConversion));

      if (isSseDecodeError || isServerToolFollowupError || isStreamingConversion || (isProviderProtocolError && typeof statusCandidate === 'number')) {
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
