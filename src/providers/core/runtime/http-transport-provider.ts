/**
 * HTTP Transport Provider
 *
 * 协议无关的 Provider 基类，负责：
 * - 读取 ServiceProfile / runtimeProfile
 * - 初始化认证、HTTP 客户端、Hook 系统
 * - 提供请求预处理、hook 执行、兼容层调用、错误治理等通用能力
 *
 * 各协议具体行为（OpenAI Chat、Responses、Anthropic、Gemini 等）通过子类覆写钩子实现。
 */

import { BaseProvider } from './base-provider.js';
import { HttpClient } from '../utils/http-client.js';
import { ServiceProfileValidator } from '../config/service-profiles.js';
import {
  attachProviderSseSnapshotStream,
  writeProviderSnapshot
} from '../utils/snapshot-writer.js';
import type { IAuthProvider } from '../../auth/auth-interface.js';
import type { OAuthAuth, OpenAIStandardConfig } from '../api/provider-config.js';
import type { ProviderContext, ServiceProfile, ProviderType } from '../api/provider-types.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import {
  buildVisionSnapshotPayload,
  shouldCaptureVisionDebug,
  summarizeVisionMessages
} from './vision-debug-utils.js';
import {
  DEFAULT_PROVIDER
} from '../../../constants/index.js';
import type { ProviderRuntimeMetadata } from './provider-runtime-metadata.js';
import type { HttpProtocolClient, ProtocolRequestPayload } from '../../../client/http-protocol-client.js';
import { OpenAIChatProtocolClient } from '../../../client/openai/chat-protocol-client.js';
import { HttpRequestExecutor, type HttpRequestExecutorDeps, type PreparedHttpRequest } from './http-request-executor.js';
import type { ProviderErrorAugmented } from './provider-error-types.js';
import { extractStatusCodeFromError } from './provider-error-classifier.js';
import { RuntimeEndpointResolver } from './runtime-endpoint-resolver.js';
import { ProviderRequestPreprocessor } from './provider-request-preprocessor.js';
import { ServiceProfileResolver } from './service-profile-resolver.js';
import { getProviderFamilyProfile } from '../../profile/profile-registry.js';
import type { ProviderFamilyProfile } from '../../profile/profile-contracts.js';

// Transport submodules
import {
  AuthProviderFactory,
  AuthModeUtils,
  HeaderUtils,
  IflowSigner,
  OAuthHeaderPreflight,
  OAuthRecoveryHandler,
  ProviderPayloadUtils,
  RequestHeaderBuilder,
  SessionHeaderUtils,
  RuntimeDetector
} from './transport/index.js';

type ProtocolClient = HttpProtocolClient<ProtocolRequestPayload>;
type OAuthAuthExtended = OAuthAuth & { rawType?: string; oauthProviderId?: string; tokenFile?: string };
type MetadataContainer = { metadata?: Record<string, unknown> };

export type ProviderConfigInternal = OpenAIStandardConfig['config'] & {
  endpoint?: string;
  defaultModel?: string;
  headers?: Record<string, string>;
  responses?: Record<string, unknown>;
  authCapabilities?: {
    required?: string[];
    optional?: string[];
  };
};

const DEFAULT_USER_AGENT = DEFAULT_PROVIDER.USER_AGENT;


export class HttpTransportProvider extends BaseProvider {
  public readonly type: string;

  protected authProvider: IAuthProvider | null = null;
  protected httpClient!: HttpClient;
  protected serviceProfile: ServiceProfile;
  protected protocolClient: ProtocolClient;
  private requestExecutor!: HttpRequestExecutor;
  private injectedConfig: UnknownObject | null = null;

  constructor(
    config: OpenAIStandardConfig,
    dependencies: ModuleDependencies,
    moduleType: string,
    protocolClient?: HttpProtocolClient<ProtocolRequestPayload>
  ) {
    super(config, dependencies);
    this.type = moduleType;
    this.protocolClient = protocolClient ?? new OpenAIChatProtocolClient();

    // 获取服务配置档案
    this.serviceProfile = this.getServiceProfile();

    // 验证配置
    this.validateConfig();

    // 创建HTTP客户端
    this.createHttpClient();
    this.requestExecutor = new HttpRequestExecutor(this.httpClient, this.createRequestExecutorDeps());

    // 创建认证提供者
    this.authProvider = this.createAuthProvider();
  }

  /**
   * 确保认证提供者完成初始化（避免 ApiKeyAuthProvider 未初始化导致的报错）
   */
  protected override async onInitialize(): Promise<void> {
    try {
      if (this.authProvider) {
        await this.authProvider.initialize();
        const providerConfig = this.config.config;
        const auth = providerConfig.auth;
        const authMode = AuthModeUtils.normalizeAuthMode(auth.type);
        // Token 管理迁移后，OAuth 初始化交由 TokenManager/TokenDaemon 负责，
        // 这里不再在服务器启动阶段主动跑 ensureValidOAuthToken，避免多余日志和上游调用。
        if (authMode !== 'oauth') {
          try {
            await this.authProvider.validateCredentials();
          } catch {
            // ignore validation errors on startup
          }
        }
      }

    } catch (error) {
      // 暴露问题，快速失败，便于定位凭证问题
      this.dependencies.logger?.logModule(this.id, 'provider-initialization-error', {
        providerType: this.providerType,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  // V2 注入（V1 不调用）
  public setConfig(cfg: unknown): void {
    if (!cfg || typeof cfg !== 'object') {
      return;
    }

    this.injectedConfig = cfg as UnknownObject;
    const merged = { ...this.config.config, ...(cfg as Record<string, unknown>) };
    (this.config as OpenAIStandardConfig).config = merged as OpenAIStandardConfig['config'];

    // 同步最新 ServiceProfile（providerType/baseUrl 等可能发生变化）
    try {
      this.serviceProfile = this.getServiceProfile();
    } catch {
      // ignore
    }
  }

  public getConfig(): unknown {
    return this.injectedConfig ?? this.config.config ?? null;
  }

  protected getServiceProfile(): ServiceProfile {
    const cfg = this.config.config as ProviderConfigInternal;
    const profileKey = this.resolveProfileKey(cfg);
    return ServiceProfileResolver.resolve({
      cfg,
      profileKey,
      providerType: this.providerType
    });
  }

  protected createAuthProvider(): IAuthProvider {
    const auth = this.config.config.auth;
    const extensions = this.getConfigExtensions();
    const authMode = AuthModeUtils.normalizeAuthMode(auth.type);
    this.authMode = authMode;
    const resolvedOAuthProviderId =
      authMode === 'oauth'
        ? AuthModeUtils.ensureOAuthProviderId(auth as OAuthAuthExtended, extensions)
        : undefined;

    const serviceProfileKey =
      this.type === 'gemini-cli-http-provider'
        ? 'gemini-cli'
        : (resolvedOAuthProviderId ?? this.providerType);

    const validation = ServiceProfileValidator.validateServiceProfile(
      serviceProfileKey,
      authMode
    );

    if (!validation.isValid) {
      throw new Error(
        `Invalid auth configuration for ${serviceProfileKey}: ${validation.errors.join(', ')}`
      );
    }

    // 根据认证类型创建对应的认证提供者
    const authFactory = new AuthProviderFactory({
      providerType: this.providerType,
      moduleType: this.type,
      config: this.config,
      serviceProfile: this.serviceProfile
    });
    const authProvider = authFactory.createAuthProvider();
    if (authMode === 'oauth') {
      const oauthAuth = auth as OAuthAuthExtended;
      const oauthProviderId = resolvedOAuthProviderId ?? serviceProfileKey;
      this.oauthProviderId = oauthProviderId;
    }
    return authProvider;
  }

  protected createHttpClient(): void {
    const profile = this.serviceProfile;
    const effectiveBase = this.getEffectiveBaseUrl();
    const envTimeout = Number(process.env.ROUTECODEX_PROVIDER_TIMEOUT_MS || process.env.RCC_PROVIDER_TIMEOUT_MS || NaN);
    const effectiveTimeout = Number.isFinite(envTimeout) && envTimeout > 0
      ? envTimeout
      // 默认 Provider 请求超时时间（可被 env / overrides 覆盖）
      : (this.config.config.overrides?.timeout ?? profile.timeout ?? DEFAULT_PROVIDER.TIMEOUT_MS);
    const envRetries = Number(process.env.ROUTECODEX_PROVIDER_RETRIES || process.env.RCC_PROVIDER_RETRIES || NaN);
    const effectiveRetries = Number.isFinite(envRetries) && envRetries >= 0
      ? envRetries
      : (this.config.config.overrides?.maxRetries ?? profile.maxRetries ?? DEFAULT_PROVIDER.MAX_RETRIES);

    const overrideHeaders =
      this.config.config.overrides?.headers ||
      (this.config.config as { headers?: Record<string, string> }).headers ||
      undefined;
    const envStreamIdleTimeoutMs = Number(
      process.env.ROUTECODEX_PROVIDER_STREAM_IDLE_TIMEOUT_MS ||
        process.env.RCC_PROVIDER_STREAM_IDLE_TIMEOUT_MS ||
        NaN
    );
    const normalizedStreamIdleTimeoutMs = Number.isFinite(envStreamIdleTimeoutMs) && envStreamIdleTimeoutMs > 0
      ? envStreamIdleTimeoutMs
      : (
          typeof this.config.config.overrides?.streamIdleTimeoutMs === 'number' &&
          Number.isFinite(this.config.config.overrides.streamIdleTimeoutMs)
            ? this.config.config.overrides.streamIdleTimeoutMs
            : undefined
        );

    const envStreamHeadersTimeoutMs = Number(
      process.env.ROUTECODEX_PROVIDER_STREAM_HEADERS_TIMEOUT_MS ||
        process.env.RCC_PROVIDER_STREAM_HEADERS_TIMEOUT_MS ||
        NaN
    );
    const normalizedStreamHeadersTimeoutMs = Number.isFinite(envStreamHeadersTimeoutMs) && envStreamHeadersTimeoutMs > 0
      ? envStreamHeadersTimeoutMs
      : (
          typeof this.config.config.overrides?.streamHeadersTimeoutMs === 'number' &&
          Number.isFinite(this.config.config.overrides.streamHeadersTimeoutMs)
            ? this.config.config.overrides.streamHeadersTimeoutMs
            : undefined
        );
    this.httpClient = new HttpClient({
      baseUrl: effectiveBase,
      timeout: effectiveTimeout,
      maxRetries: effectiveRetries,
      streamIdleTimeoutMs: normalizedStreamIdleTimeoutMs ?? profile.streamIdleTimeoutMs,
      streamHeadersTimeoutMs: normalizedStreamHeadersTimeoutMs ?? profile.streamHeadersTimeoutMs,
      defaultHeaders: {
        'Content-Type': 'application/json',
        ...(profile.headers || {}),
        ...(overrideHeaders || {}),
      }
    });
  }

  private createRequestExecutorDeps(): HttpRequestExecutorDeps {
    return {
      wantsUpstreamSse: this.wantsUpstreamSse.bind(this),
      getEffectiveEndpoint: () => this.getEffectiveEndpoint(),
      resolveRequestEndpoint: this.resolveRequestEndpoint.bind(this),
      buildRequestHeaders: this.buildRequestHeaders.bind(this),
      finalizeRequestHeaders: this.finalizeRequestHeaders.bind(this),
      applyStreamModeHeaders: this.applyStreamModeHeaders.bind(this),
      getEffectiveBaseUrl: () => this.getEffectiveBaseUrl(),
      getBaseUrlCandidates: this.getBaseUrlCandidates.bind(this),
      buildHttpRequestBody: this.buildHttpRequestBody.bind(this),
      prepareSseRequestBody: this.prepareSseRequestBody.bind(this),
      getEntryEndpointFromPayload: (payload) => ProviderPayloadUtils.extractEntryEndpointFromPayload(payload),
      getClientRequestIdFromContext: (context) => ProviderPayloadUtils.getClientRequestIdFromContext(context),
      wrapUpstreamSseResponse: this.wrapUpstreamSseResponse.bind(this),
      getHttpRetryLimit: () => this.getHttpRetryLimit(),
      shouldRetryHttpError: this.shouldRetryHttpError.bind(this),
      delayBeforeHttpRetry: this.delayBeforeHttpRetry.bind(this),
      tryRecoverOAuthAndReplay: this.tryRecoverOAuthAndReplay.bind(this),
      resolveBusinessResponseError: this.resolveProfileBusinessResponseError.bind(this),
      normalizeHttpError: this.normalizeHttpError.bind(this)
    };
  }

  protected async preprocessRequest(request: UnknownObject): Promise<UnknownObject> {
    const context = this.createProviderContext();
    const runtimeMetadata = context.runtimeMetadata;
    this.getRuntimeProfile();
    const processedRequest = ProviderRequestPreprocessor.preprocess(request, runtimeMetadata);
    this.logVisionDebug('preprocess', processedRequest);
    await this.captureVisionDebugSnapshot('provider-preprocess-debug', processedRequest);
    return processedRequest;
  }

  protected async postprocessResponse(response: unknown, context: ProviderContext): Promise<UnknownObject> {
    this.getRuntimeProfile();
    const processingTime = Date.now() - context.startTime;

    const processedResponse = response;
    const originalRecord = ProviderPayloadUtils.asResponseRecord(response);
    const processedRecord = ProviderPayloadUtils.asResponseRecord(processedResponse);

    const sseStream =
      processedRecord.__sse_responses ||
      processedRecord.data?.__sse_responses;
    if (sseStream) {
      return { __sse_responses: sseStream } as UnknownObject;
    }

    return {
      data: processedRecord.data || processedResponse,
      status: processedRecord.status ?? originalRecord.status,
      headers: processedRecord.headers || originalRecord.headers,
      metadata: {
        requestId: context.requestId,
        processingTime,
        providerType: this.providerType,
        // 对外暴露的 model 统一为入站模型
        model: context.model ?? ProviderPayloadUtils.extractModel(processedRecord) ?? ProviderPayloadUtils.extractModel(originalRecord),
        usage: ProviderPayloadUtils.extractUsage(processedRecord) ?? ProviderPayloadUtils.extractUsage(originalRecord)
      }
    } as UnknownObject;
  }

  private logVisionDebug(stage: string, payload: UnknownObject): void {
    const debug = shouldCaptureVisionDebug(payload);
    if (!debug.enabled) {
      return;
    }
    const summary = summarizeVisionMessages(payload);
    const label = debug.routeName ?? 'vision';
    console.debug(`[vision-debug][${stage}] route=${label} request=${debug.requestId ?? '-'} ${summary}`);
  }

  private async captureVisionDebugSnapshot(
    stage: 'provider-preprocess-debug' | 'provider-body-debug',
    payload: UnknownObject
  ): Promise<void> {
    const debug = shouldCaptureVisionDebug(payload);
    if (!debug.enabled || !debug.requestId) {
      return;
    }
    try {
      const metadataNode = (payload as MetadataContainer)?.metadata;
      const entryEndpoint =
        metadataNode && typeof metadataNode === 'object' && typeof (metadataNode as Record<string, unknown>).entryEndpoint === 'string'
          ? ((metadataNode as Record<string, unknown>).entryEndpoint as string)
          : undefined;
      await writeProviderSnapshot({
        phase: stage,
        requestId: debug.requestId,
        data: buildVisionSnapshotPayload(payload),
        entryEndpoint
      });
    } catch {
      // snapshot is best-effort; ignore failures
    }
  }

  protected async sendRequestInternal(request: UnknownObject): Promise<unknown> {
    const context = this.createProviderContext();
    return this.requestExecutor.execute(request, context);
  }

  protected wantsUpstreamSse(request: UnknownObject, context: ProviderContext): boolean {
    const runtimeMetadata = context.runtimeMetadata ?? this.getCurrentRuntimeMetadata();
    const familyProfile = this.resolveFamilyProfile(runtimeMetadata);
    const profileResolved = familyProfile?.resolveStreamIntent?.({
      request,
      context,
      runtimeMetadata
    });
    return typeof profileResolved === 'boolean' ? profileResolved : false;
  }

  protected applyStreamModeHeaders(headers: Record<string, string>, wantsSse: boolean): Record<string, string> {
    const normalized = { ...headers };
    const acceptKey = Object.keys(normalized).find((key) => key.toLowerCase() === 'accept');

    // 上游 Accept 必须由我们“上游是否走 SSE”来决定；不能透传客户端的 SSE Accept。
    // 否则会出现 “Accept: text/event-stream 但 body 无 stream 标记” 的组合（部分上游会返回 406）。
    if (acceptKey) {
      delete normalized[acceptKey];
    }
    normalized['Accept'] = wantsSse ? 'text/event-stream' : 'application/json';

    const runtimeMetadata = this.getCurrentRuntimeMetadata();
    const familyProfile = this.resolveFamilyProfile(runtimeMetadata);
    const profileHeaders = familyProfile?.applyStreamModeHeaders?.({
      headers: normalized,
      wantsSse,
      runtimeMetadata
    });
    if (profileHeaders && typeof profileHeaders === 'object') {
      return profileHeaders;
    }

    return normalized;
  }

  protected prepareSseRequestBody(body: UnknownObject, context?: ProviderContext): void {
    const runtimeMetadata = context?.runtimeMetadata ?? this.getCurrentRuntimeMetadata();
    const familyProfile = this.resolveFamilyProfile(runtimeMetadata);
    const effectiveContext = context ?? this.createProviderContext();
    familyProfile?.prepareStreamBody?.({
      body,
      context: effectiveContext,
      runtimeMetadata
    });
  }

  protected async wrapUpstreamSseResponse(stream: NodeJS.ReadableStream, _context: ProviderContext): Promise<UnknownObject> {
    return { __sse_responses: stream } as UnknownObject;
  }

  protected async performHealthCheck(url: string): Promise<boolean> {
    try {
      const headers = await this.buildRequestHeaders();
      const response = await this.httpClient.get(url, headers);
      return response.status === 200 || response.status === 404;
    } catch {
      return false;
    }
  }

  private getHttpRetryLimit(): number {
    // Provider 层禁止重复尝试；失败后由虚拟路由负责 failover。
    return 1;
  }

  private async delayBeforeHttpRetry(attempt: number): Promise<void> {
    const delay = Math.min(500 * attempt, 2000);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  private shouldRetryHttpError(error: unknown, attempt: number, maxAttempts: number): boolean {
    if (attempt >= maxAttempts) {
      return false;
    }
    const normalized = error as ProviderErrorAugmented;
    const statusCode = extractStatusCodeFromError(normalized);
    if (statusCode && statusCode >= 500) {
      return true;
    }
    return false;
  }

  private async tryRecoverOAuthAndReplay(
    error: unknown,
    requestInfo: PreparedHttpRequest,
    processedRequest: UnknownObject,
    captureSse: boolean,
    context: ProviderContext
  ): Promise<unknown | undefined> {
    try {
      const recovery = new OAuthRecoveryHandler({
        authProvider: this.authProvider,
        oauthProviderId: this.oauthProviderId,
        providerType: this.providerType,
        config: this.config,
        httpClient: this.httpClient
      });
      return await recovery.tryRecoverOAuthAndReplay(
        error,
        requestInfo,
        processedRequest,
        captureSse,
        context,
        () => this.buildRequestHeaders(),
        (headers, req) => this.finalizeRequestHeaders(headers, req),
        (headers, wantsSse) => this.applyStreamModeHeaders(headers, wantsSse),
        (stream, ctx) => this.wrapUpstreamSseResponse(stream, ctx)
      );
    } catch {
      return undefined;
    }
  }

  private async normalizeHttpError(
    error: unknown,
    processedRequest: UnknownObject,
    requestInfo: PreparedHttpRequest,
    context: ProviderContext
  ): Promise<ProviderErrorAugmented> {
    const normalized: ProviderErrorAugmented = error as ProviderErrorAugmented;
    try {
      const statusCode = extractStatusCodeFromError(normalized);
      if (statusCode && !Number.isNaN(statusCode)) {
        normalized.statusCode = statusCode;
        if (!normalized.status) {
          normalized.status = statusCode;
        }
        if (!normalized.code) {
          normalized.code = `HTTP_${statusCode}`;
        }
      }
      if (!normalized.response) {
        normalized.response = {};
      }
      if (!normalized.response.data) {
        normalized.response.data = {};
      }
      if (!normalized.response.data.error) {
        normalized.response.data.error = {};
      }
      if (normalized.code && !normalized.response.data.error.code) {
        normalized.response.data.error.code = normalized.code;
      }
      if (normalized.message && !normalized.response.data.error.message) {
        normalized.response.data.error.message = normalized.message;
      }
    } catch {
      /* ignore */
    }

    try {
      await writeProviderSnapshot({
        phase: 'provider-error',
        requestId: context.requestId,
        data: {
          status: normalized?.statusCode ?? normalized?.status ?? null,
          code: normalized?.code ?? null,
          error: typeof normalized?.message === 'string' ? normalized.message : String(error || '')
        },
        headers: requestInfo.headers,
        url: requestInfo.targetUrl,
        entryEndpoint: requestInfo.entryEndpoint ?? ProviderPayloadUtils.extractEntryEndpointFromPayload(processedRequest),
        clientRequestId: requestInfo.clientRequestId ?? ProviderPayloadUtils.getClientRequestIdFromContext(context),
        providerKey: context.providerKey,
        providerId: context.providerId
      });
    } catch { /* non-blocking */ }

    return normalized;
  }

  private resolveProfileBusinessResponseError(response: unknown, context: ProviderContext): Error | undefined {
    const runtimeMetadata = context.runtimeMetadata ?? this.getCurrentRuntimeMetadata();
    const familyProfile = this.resolveFamilyProfile(runtimeMetadata);
    if (!familyProfile?.resolveBusinessResponseError) {
      return undefined;
    }
    return familyProfile.resolveBusinessResponseError({
      response,
      runtimeMetadata
    });
  }

  /**
   * 为特定请求确定最终 endpoint（默认使用配置值，可由子类覆写）
   */
  protected resolveRequestEndpoint(request: UnknownObject, defaultEndpoint: string): string {
    const protocolResolvedEndpoint = this.protocolClient.resolveEndpoint(
      request as ProtocolRequestPayload,
      defaultEndpoint
    );
    const runtimeMetadata = this.getCurrentRuntimeMetadata();
    const familyProfile = this.resolveFamilyProfile(runtimeMetadata);
    const profileResolvedEndpoint = familyProfile?.resolveEndpoint?.({
      request,
      defaultEndpoint: protocolResolvedEndpoint,
      runtimeMetadata
    });
    if (typeof profileResolvedEndpoint === 'string' && profileResolvedEndpoint.trim()) {
      return profileResolvedEndpoint.trim();
    }

    const legacyEndpoint = this.resolveLegacyIflowEndpoint(request);
    if (legacyEndpoint) {
      return legacyEndpoint;
    }

    return protocolResolvedEndpoint;
  }

  /**
   * 构造最终发送到上游的请求体，默认实现包含模型/令牌治理，可由子类覆写
   */
  protected buildHttpRequestBody(request: UnknownObject): UnknownObject {
    const runtimeMetadata = this.getCurrentRuntimeMetadata();
    const familyProfile = this.resolveFamilyProfile(runtimeMetadata);

    const defaultBody = this.protocolClient.buildRequestBody(request as ProtocolRequestPayload);

    const profileBody = familyProfile?.buildRequestBody?.({
      request,
      defaultBody,
      runtimeMetadata
    });
    if (profileBody && typeof profileBody === 'object') {
      return profileBody as UnknownObject;
    }

    const legacyBody = this.resolveLegacyIflowRequestBody(request);
    if (legacyBody && typeof legacyBody === 'object') {
      return legacyBody;
    }

    return defaultBody;
  }

  private resolveFamilyProfile(runtimeMetadata?: ProviderRuntimeMetadata): ProviderFamilyProfile | undefined {
    const targetNode =
      runtimeMetadata?.target && typeof runtimeMetadata.target === 'object'
        ? (runtimeMetadata.target as Record<string, unknown>)
        : undefined;

    const normalize = (value: unknown): string | undefined => {
      if (typeof value !== 'string') {
        return undefined;
      }
      const normalized = value.trim().toLowerCase();
      return normalized.length ? normalized : undefined;
    };

    return getProviderFamilyProfile({
      providerFamily:
        normalize(runtimeMetadata?.providerFamily) ??
        normalize(this.getRuntimeProfile()?.providerFamily),
      providerId:
        normalize(runtimeMetadata?.providerId) ??
        normalize(targetNode?.providerId) ??
        normalize(this.config?.config?.providerId),
      providerKey:
        normalize(runtimeMetadata?.providerKey) ??
        normalize(targetNode?.providerKey) ??
        normalize(this.getRuntimeProfile()?.providerKey),
      providerType:
        normalize(runtimeMetadata?.providerType) ??
        normalize(targetNode?.providerType) ??
        normalize(this.config?.config?.providerType) ??
        normalize(this.providerType),
      oauthProviderId: normalize(this.oauthProviderId)
    });
  }

  private isIflowWebSearchRequest(request: UnknownObject): boolean {
    const metadata = (request as { metadata?: unknown }).metadata;
    if (!metadata || typeof metadata !== 'object') {
      return false;
    }
    const flag = (metadata as { iflowWebSearch?: unknown }).iflowWebSearch;
    return flag === true;
  }

  private resolveLegacyIflowEndpoint(request: UnknownObject): string | undefined {
    if (!this.isIflowTransportRuntime(this.getCurrentRuntimeMetadata())) {
      return undefined;
    }
    if (!this.isIflowWebSearchRequest(request)) {
      return undefined;
    }
    const metadata = (request as { metadata?: unknown }).metadata;
    const endpoint =
      metadata && typeof (metadata as { entryEndpoint?: unknown }).entryEndpoint === 'string'
        ? ((metadata as { entryEndpoint: string }).entryEndpoint || '').trim()
        : '';
    return endpoint || '/chat/retrieve';
  }

  private resolveLegacyIflowRequestBody(request: UnknownObject): UnknownObject | undefined {
    if (!this.isIflowTransportRuntime(this.getCurrentRuntimeMetadata())) {
      return undefined;
    }
    if (!this.isIflowWebSearchRequest(request)) {
      return undefined;
    }
    const data = (request as { data?: unknown }).data;
    if (data && typeof data === 'object') {
      return data as UnknownObject;
    }
    return {};
  }

  /**
   * 允许子类在 Hook 运行完后对头部做最终调整
   */
  protected async finalizeRequestHeaders(
    headers: Record<string, string>,
    request: UnknownObject
  ): Promise<Record<string, string>> {
    const finalized = await this.protocolClient.finalizeHeaders(
      headers,
      request as ProtocolRequestPayload
    );

    const runtimeMetadata = this.getCurrentRuntimeMetadata();
    const familyProfile = this.resolveFamilyProfile(runtimeMetadata);

    const profileResolvedUa = await familyProfile?.resolveUserAgent?.({
      uaFromConfig: HeaderUtils.findHeaderValue(finalized, 'User-Agent'),
      uaFromService: undefined,
      inboundUserAgent: undefined,
      defaultUserAgent: DEFAULT_USER_AGENT,
      runtimeMetadata
    });
    if (typeof profileResolvedUa === 'string' && profileResolvedUa.trim()) {
      HeaderUtils.assignHeader(finalized, 'User-Agent', profileResolvedUa.trim());
    }

    const profileAdjustedHeaders = familyProfile?.applyRequestHeaders?.({
      headers: finalized,
      request,
      runtimeMetadata,
      isCodexUaMode: this.isCodexUaMode()
    });
    if (profileAdjustedHeaders && typeof profileAdjustedHeaders === 'object') {
      return profileAdjustedHeaders;
    }

    if (this.isIflowTransportRuntime(runtimeMetadata)) {
      IflowSigner.enforceIflowCliHeaders(finalized);
    }

    return finalized;
  }

  // 私有方法
  private validateConfig(): void {
    const profile = this.serviceProfile;
    const cfg = this.config.config as ProviderConfigInternal;
    const profileKey = this.resolveProfileKey(cfg);
    const auth = this.config.config.auth;
    const authMode = AuthModeUtils.normalizeAuthMode(auth.type);

    // 验证认证类型
    const supportedAuthTypes = [...profile.requiredAuth, ...profile.optionalAuth];
    if (!supportedAuthTypes.includes(authMode)) {
      throw new Error(
        `Auth type '${auth.type}' not supported for provider '${profileKey}'. ` +
        `Supported types: ${supportedAuthTypes.join(', ')}`
      );
    }
  }

  private buildRequestUrl(): string {
    const baseUrl = this.getEffectiveBaseUrl();
    const endpoint = this.getEffectiveEndpoint();
    return `${baseUrl}${endpoint}`;
  }

  protected async buildRequestHeaders(): Promise<Record<string, string>> {
    const baseHeaders: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    const runtimeMetadata = this.getCurrentRuntimeMetadata();
    const inboundMetadata = runtimeMetadata?.metadata;
    const inboundUserAgent =
      typeof inboundMetadata?.userAgent === 'string' && inboundMetadata.userAgent.trim()
        ? inboundMetadata.userAgent.trim()
        : undefined;
    const inboundOriginator =
      typeof inboundMetadata?.clientOriginator === 'string' && inboundMetadata.clientOriginator.trim()
        ? inboundMetadata.clientOriginator.trim()
        : undefined;
    const codexUaMode = this.isCodexUaMode();
    const inboundClientHeaders = SessionHeaderUtils.extractClientHeaders(runtimeMetadata);
    const normalizedClientHeaders = SessionHeaderUtils.normalizeCodexClientHeaders(inboundClientHeaders, codexUaMode);
    const isAntigravity = this.isAntigravityTransportRuntime(runtimeMetadata);

    // 服务特定头部
    const serviceHeaders = this.serviceProfile.headers || {};

    // 配置覆盖头部
    const overrideHeaders = this.config.config.overrides?.headers || {};
    const runtimeHeaders = this.getRuntimeProfile()?.headers || {};
    const isGeminiFamily = this.isGeminiFamilyTransport();
    if (isGeminiFamily && !isAntigravity) {
      RequestHeaderBuilder.buildGeminiDefaultHeaders(baseHeaders, runtimeMetadata);
    }

    // OAuth：请求前确保令牌有效（提前刷新）
    try {
      await OAuthHeaderPreflight.ensureTokenReady({
        auth: this.config.config.auth,
        authProvider: this.authProvider,
        oauthProviderId: this.oauthProviderId
      });
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        (error as { __routecodexAuthPreflightFatal?: unknown }).__routecodexAuthPreflightFatal === true
      ) {
        throw error;
      }
      // bubble up in authHeaders build below
    }

    // 认证头部（如为 OAuth，若当前无有效 token 则尝试拉取/刷新一次再取 headers）
    const providerAuth = this.config.config.auth;
    const authRawType =
      typeof (providerAuth as { rawType?: unknown }).rawType === 'string'
        ? String((providerAuth as { rawType?: string }).rawType).trim().toLowerCase()
        : '';
    if (authRawType === 'deepseek-account' && this.authProvider?.validateCredentials) {
      await this.authProvider.validateCredentials();
    }

    const authHeaders = this.authProvider?.buildHeaders() || {};
    const isIflow = this.isIflowTransportRuntime(runtimeMetadata);
    const familyProfile = this.resolveFamilyProfile(runtimeMetadata);

    return await RequestHeaderBuilder.buildHeaders({
      baseHeaders,
      serviceHeaders,
      overrideHeaders,
      runtimeHeaders,
      authHeaders,
      normalizedClientHeaders,
      inboundMetadata: inboundMetadata as Record<string, unknown> | undefined,
      inboundUserAgent,
      inboundOriginator,
      runtimeMetadata,
      familyProfile,
      defaultUserAgent: DEFAULT_USER_AGENT,
      isGeminiFamily,
      isAntigravity,
      isIflow,
      codexUaMode
    });
  }

  protected isCodexUaMode(): boolean {
    const raw =
      process.env.ROUTECODEX_UA_MODE ??
      process.env.RCC_UA_MODE ??
      '';
    const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';

    const runtime = this.getCurrentRuntimeMetadata();
    if (!runtime) {
      return false;
    }

    const providerType = (runtime.providerType as ProviderType) || this.providerType;
    const entryEndpoint = ProviderPayloadUtils.extractEntryEndpointFromRuntime(runtime);

    // 显式 UA 模式（--codex / --ua codex）：对所有 provider 激活
    if (normalized === 'codex') {
      return true;
    }

    // 隐式模式：未显式设置 UA 时，仅在 responses provider 且入口不是 /v1/responses 时激活
    if (providerType === 'responses' && entryEndpoint) {
      const lowered = entryEndpoint.trim().toLowerCase();
      if (!lowered.includes('/responses')) {
        return true;
      }
    }

    return false;
  }

  private isAntigravityTransportRuntime(runtimeMetadata?: ProviderRuntimeMetadata): boolean {
    return this.getRuntimeDetector().isAntigravity(runtimeMetadata);
  }

  private isIflowTransportRuntime(runtimeMetadata?: ProviderRuntimeMetadata): boolean {
    return this.getRuntimeDetector().isIflow(runtimeMetadata);
  }

  protected getEffectiveBaseUrl(): string {
    const cfg = this.config.config as ProviderConfigInternal;
    const profileKey = this.resolveProfileKey(cfg);
    return RuntimeEndpointResolver.resolveEffectiveBaseUrl({
      runtime: this.getRuntimeProfile(),
      overrideBaseUrl: this.config.config.overrides?.baseUrl,
      configBaseUrl: this.config.config.baseUrl,
      serviceDefaultBaseUrl: this.serviceProfile.defaultBaseUrl,
      profileKey,
      providerType: this.providerType
    });
  }

  protected getBaseUrlCandidates(_context: ProviderContext): string[] | undefined {
    return undefined;
  }

  protected getEffectiveEndpoint(): string {
    return RuntimeEndpointResolver.resolveEffectiveEndpoint({
      runtime: this.getRuntimeProfile(),
      overrideEndpoint: this.config.config.overrides?.endpoint,
      serviceDefaultEndpoint: this.serviceProfile.defaultEndpoint
    });
  }

  // （工具自动修复辅助函数已删除）
  private getConfigExtensions(): Record<string, unknown> {
    const extensions = this.config.config.extensions;
    return extensions && typeof extensions === 'object'
      ? extensions as Record<string, unknown>
      : {};
  }

  protected createProviderContext(): ProviderContext {
    const runtime = this.getCurrentRuntimeMetadata();
    return {
      requestId: runtime?.requestId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      providerType: (runtime?.providerType as ProviderType) || (this.providerType as ProviderType),
      startTime: Date.now(),
      profile: this.serviceProfile,
      routeName: runtime?.routeName,
      providerId: runtime?.providerId,
      providerKey: runtime?.providerKey,
      providerProtocol: runtime?.providerProtocol,
      metadata: runtime?.metadata,
      target: runtime?.target,
      runtimeMetadata: runtime,
      pipelineId: runtime?.pipelineId
    };
  }

  private resolveProfileKey(config: Record<string, unknown>): string {
    if (this.type === 'gemini-cli-http-provider') {
      return 'gemini-cli';
    }
    const direct = typeof config?.providerId === 'string' && config.providerId.trim()
      ? config.providerId.trim().toLowerCase()
      : '';
    return direct || this.providerType;
  }

  /**
   * 检查是否为 Gemini 系列传输
   */
  private isGeminiFamilyTransport(): boolean {
    return this.getRuntimeDetector().isGeminiFamily();
  }

  private getRuntimeDetector(): RuntimeDetector {
    return new RuntimeDetector(this.config, this.providerType, this.oauthProviderId);
  }

}
