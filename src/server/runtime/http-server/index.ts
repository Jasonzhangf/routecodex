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
import { emitProviderError } from '../../../providers/core/utils/provider-error-reporter.js';
import { isStageLoggingEnabled, logPipelineStage } from '../../utils/stage-logger.js';
import { registerDefaultMiddleware } from './middleware.js';
import { registerHttpRoutes } from './routes.js';
import { mapProviderProtocol, normalizeProviderType, resolveProviderIdentity, asRecord } from './provider-utils.js';
import { resolveRepoRoot, loadLlmswitchModule } from './llmswitch-loader.js';
import { importCoreModule } from '../../../modules/llmswitch/core-loader.js';
import { enhanceProviderRequestId } from '../../utils/request-id-manager.js';
import type {
  HubPipeline,
  HubPipelineCtor,
  ProviderHandle,
  ProviderProtocol,
  ServerConfigV2,
  ServerStatusV2,
  VirtualRouterArtifacts
} from './types.js';
import type { ProviderErrorRuntimeMetadata } from '@jsonstudio/llms/dist/router/virtual-router/types.js';
import { writeClientSnapshot } from '../../../providers/core/utils/snapshot-writer.js';

type ConvertProviderResponseFn = (options: {
  providerProtocol: string;
  providerResponse: Record<string, unknown>;
  context: Record<string, unknown>;
  entryEndpoint: string;
  wantsStream: boolean;
  stageRecorder?: unknown;
}) => Promise<Record<string, unknown> & { __sse_responses?: unknown; body?: unknown }>;
type SnapshotRecorderFactory = (context: Record<string, unknown>, entryEndpoint: string) => unknown;
type ConvertProviderModule = {
  convertProviderResponse?: ConvertProviderResponseFn;
};
type SnapshotRecorderModule = {
  createSnapshotRecorder?: SnapshotRecorderFactory;
};
type VirtualRouterBootstrapModule = {
  bootstrapVirtualRouterConfig?: (input: UnknownObject) => VirtualRouterArtifacts;
};
type HubPipelineModule = {
  HubPipeline?: HubPipelineCtor;
};
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

let convertProviderResponseFn: ConvertProviderResponseFn | null = null;
async function loadConvertProviderResponse(): Promise<ConvertProviderResponseFn> {
  if (convertProviderResponseFn) {
    return convertProviderResponseFn;
  }
  const mod = await importCoreModule<ConvertProviderModule>('conversion/hub/response/provider-response');
  if (!mod?.convertProviderResponse) {
    throw new Error('[RouteCodexHttpServer] llmswitch-core 缺少 convertProviderResponse 实现');
  }
  convertProviderResponseFn = mod.convertProviderResponse;
  return convertProviderResponseFn;
}

let createSnapshotRecorderFn: SnapshotRecorderFactory | null = null;
async function loadSnapshotRecorderFactory(): Promise<SnapshotRecorderFactory> {
  if (createSnapshotRecorderFn) {
    return createSnapshotRecorderFn;
  }
  const mod = await importCoreModule<SnapshotRecorderModule>('conversion/hub/snapshot-recorder');
  if (!mod?.createSnapshotRecorder) {
    throw new Error('[RouteCodexHttpServer] llmswitch-core 缺少 createSnapshotRecorder 实现');
  }
  createSnapshotRecorderFn = mod.createSnapshotRecorder;
  return createSnapshotRecorderFn;
}

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

  constructor(config: ServerConfigV2) {
    this.config = config;
    this.app = express();
    this.errorHandling = new ErrorHandlingCenter();
    this.stageLoggingEnabled = isStageLoggingEnabled();
    this.repoRoot = resolveRepoRoot(import.meta.url);
    const envFlag = (process.env.ROUTECODEX_USE_HUB_PIPELINE || '').trim().toLowerCase();
    if (config.pipeline?.useHubPipeline === false || envFlag === '0' || envFlag === 'false') {
      console.warn('[RouteCodexHttpServer] Super pipeline has been removed; falling back to Hub pipeline.');
    }

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

  private getErrorHandlingShim(): ModuleDependencies['errorHandlingCenter'] {
    if (!this.errorHandlingShim) {
      this.errorHandlingShim = {
        handleError: async (errorPayload, contextPayload) => {
          await this.errorHandling.handleError({
            error: errorPayload,
            context: contextPayload
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
      logDebug: () => {},
      logError: () => {},
      logModule: () => {},
      processDebugEvent: () => {},
      getLogs: () => []
    };
  }

  private updateProviderProfiles(collection?: ProviderProfileCollection, rawConfig?: UnknownObject): void {
    this.providerProfileIndex.clear();
    const source = collection ?? this.tryBuildProfiles(rawConfig);
    if (!source) {return;}
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
    if (!fallback) {return;}
    for (const profile of fallback.profiles) {
      if (profile && typeof profile.id === 'string' && profile.id.trim()) {
        this.providerProfileIndex.set(profile.id.trim(), profile);
      }
    }
  }

  private tryBuildProfiles(config: UnknownObject | undefined): ProviderProfileCollection | null {
    if (!config) {return null;}
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
      if (profile) {return profile;}
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
    if (!patched.baseUrl && profile.transport.baseUrl) {
      patched.baseUrl = profile.transport.baseUrl;
    }
    if (!patched.endpoint && profile.transport.endpoint) {
      patched.endpoint = profile.transport.endpoint;
    }
    if (!patched.headers && profile.transport.headers) {
      patched.headers = profile.transport.headers;
    }
    if (!patched.compatibilityProfile && profile.compatibilityProfiles.length > 0) {
      patched.compatibilityProfile = profile.compatibilityProfiles[0];
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
    const mod = await loadLlmswitchModule<VirtualRouterBootstrapModule>(
      this.repoRoot,
      'router/virtual-router/bootstrap.js'
    );
    const fn = mod?.bootstrapVirtualRouterConfig;
    if (typeof fn !== 'function') {
      throw new Error('llmswitch-core missing bootstrapVirtualRouterConfig');
    }
    return fn(input);
  }

  private async ensureHubPipelineCtor(): Promise<HubPipelineCtor> {
    if (this.hubPipelineCtor) {
      return this.hubPipelineCtor;
    }
    const mod = await loadLlmswitchModule<HubPipelineModule>(
      this.repoRoot,
      'conversion/hub/pipeline/hub-pipeline.js'
    );
    if (!mod?.HubPipeline) {
      throw new Error('Unable to load HubPipeline implementation from llmswitch-core');
    }
    this.hubPipelineCtor = mod.HubPipeline;
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

      registerDefaultMiddleware(this.app);
      registerHttpRoutes({
        app: this.app,
        config: this.config,
        buildHandlerContext: () => this.buildHandlerContext(),
        getPipelineReady: () => this.isPipelineReady(),
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
    if (!this.hubPipeline) {
      this.hubPipeline = new hubCtor({ virtualRouter: bootstrapArtifacts.config });
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
      if (!runtime) {continue;}
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
      if (!value) {return undefined;}
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
    const metadata = this.buildRequestMetadata(input);
    const providerRequestId = input.requestId;
    const clientRequestId = typeof metadata.clientRequestId === 'string' && metadata.clientRequestId.trim()
      ? metadata.clientRequestId.trim()
      : providerRequestId;

    this.logStage('request.received', providerRequestId, {
      endpoint: input.entryEndpoint,
      stream: input.metadata?.stream === true
    });
    try {
      const headerUa =
        (typeof input.headers?.['user-agent'] === 'string' && input.headers['user-agent']) ||
        (typeof input.headers?.['User-Agent'] === 'string' && input.headers['User-Agent']);
      await writeClientSnapshot({
        entryEndpoint: input.entryEndpoint,
        requestId: input.requestId,
        headers: asRecord(input.headers),
        body: input.body,
        metadata: {
          ...metadata,
          userAgent: headerUa
        }
      });
    } catch {
      // snapshot failure should not block request path
    }
    const pipelineLabel = 'hub';
    this.logStage(`${pipelineLabel}.start`, providerRequestId, {
      endpoint: input.entryEndpoint,
      stream: metadata.stream
    });
    const originalRequestSnapshot = this.cloneRequestPayload(input.body);
    const pipelineResult = await this.runHubPipeline(input, metadata);
    const pipelineMetadata = pipelineResult.metadata ?? {};
    const mergedMetadata = { ...metadata, ...pipelineMetadata };
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
      const normalized = this.normalizeProviderResponse(providerResponse);
      return await this.convertProviderResponseIfNeeded({
        entryEndpoint: input.entryEndpoint,
        providerType: handle.providerType,
        requestId: input.requestId,
        wantsStream: Boolean(input.metadata?.inboundStream ?? input.metadata?.stream),
        originalRequest: originalRequestSnapshot,
        processMode: pipelineResult.processMode,
        response: normalized,
        pipelineMetadata: mergedMetadata
      });
    } catch (error) {
      this.logStage('provider.send.error', input.requestId, {
        providerKey: target.providerKey,
        message: error instanceof Error ? error.message : String(error ?? 'Unknown error'),
        providerType: handle.providerType,
        providerFamily: handle.providerFamily,
        model: providerModel,
        providerLabel
      });
      const runtimeMetadata: ProviderErrorRuntimeMetadata & { providerFamily?: string } = {
        requestId: input.requestId,
        providerKey: target.providerKey,
        providerId: handle.providerId,
        providerType: handle.providerType,
        providerProtocol,
        routeName: pipelineResult.routingDecision?.routeName,
        pipelineId: target.providerKey,
        runtimeKey,
        target
      };
      runtimeMetadata.providerFamily = handle.providerFamily;
      emitProviderError({
        error,
        stage: 'provider.send',
        runtime: runtimeMetadata,
        dependencies: this.getModuleDependencies()
      });
      throw error;
    }
  }

  private async runHubPipeline(
    input: PipelineExecutionInput,
    metadata: Record<string, unknown>
  ): Promise<{
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
      metadata,
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
    return {
      providerPayload: result.providerPayload,
      target: result.target,
      routingDecision: result.routingDecision ?? undefined,
      processMode,
      metadata: result.metadata ?? {}
    };
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
    if (!headers || typeof headers !== 'object') {return undefined;}
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
    processMode?: string;
    response: PipelineExecutionResult;
    pipelineMetadata?: Record<string, unknown>;
  }): Promise<PipelineExecutionResult> {
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
    const body = options.response.body;
    if (!body || typeof body !== 'object') {
      return options.response;
    }
    try {
      const providerProtocol = mapProviderProtocol(options.providerType);
      const metadataBag = asRecord(options.pipelineMetadata);
      const aliasMap = extractAnthropicToolAliasMap(metadataBag);
      const originalModelId = this.extractClientModelId(metadataBag, options.originalRequest);
      const adapterContext = {
        requestId: options.requestId,
        entryEndpoint: options.entryEndpoint || entry,
        providerProtocol,
        originalModelId
      };
      if (aliasMap) {
        (adapterContext as Record<string, unknown>).anthropicToolNameMap = aliasMap;
      }
      const [convertProviderResponse, createSnapshotRecorder] = await Promise.all([
        loadConvertProviderResponse(),
        loadSnapshotRecorderFactory()
      ]);
      const stageRecorder = createSnapshotRecorder(adapterContext, adapterContext.entryEndpoint);
      const converted = await convertProviderResponse({
        providerProtocol,
        providerResponse: body as Record<string, unknown>,
        context: adapterContext,
        entryEndpoint: options.entryEndpoint || entry,
        wantsStream: options.wantsStream,
        stageRecorder
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
      console.error('[RouteCodexHttpServer] Failed to convert provider response via llmswitch-core', error);
      return options.response;
    }
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
    if (!payload || typeof payload !== 'object') {return undefined;}
    try {
      return JSON.parse(JSON.stringify(payload));
    } catch {
      return undefined;
    }
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
    exportLogs: () => ([]),
    log: noop
  };
}
