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
import type { HttpClient } from '../utils/http-client.js';
import type { IAuthProvider } from '../../auth/auth-interface.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ProviderContext, ServiceProfile } from '../api/provider-types.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import {
  captureVisionDebugPayloadSnapshot,
  logVisionDebugSummary
} from './vision-debug-utils.js';
import type { ProviderRuntimeMetadata } from './provider-runtime-metadata.js';
import type { HttpProtocolClient, ProtocolRequestPayload } from '../../../client/http-protocol-client.js';
import { OpenAIChatProtocolClient } from '../../../client/openai/chat-protocol-client.js';
import { HttpRequestExecutor, type HttpRequestExecutorDeps, type PreparedHttpRequest } from './http-request-executor.js';
import type { ProviderErrorAugmented } from './provider-error-types.js';
import { normalizeProviderHttpError } from './provider-http-executor-utils.js';
import { RuntimeEndpointResolver } from './runtime-endpoint-resolver.js';
import { ProviderRequestPreprocessor } from './provider-request-preprocessor.js';
import { buildProviderRequestExecutorDeps } from './provider-request-executor-deps-factory.js';
import { buildPostprocessedProviderResponse } from './provider-response-postprocessor.js';
import { ServiceProfileResolver } from './service-profile-resolver.js';
import { createTransportAuthProvider, createTransportHttpClient } from './provider-bootstrap-utils.js';
import { createProviderRuntimeContext, resolveProviderProfileKey } from './provider-runtime-utils.js';
import { buildProviderRequestHeaders, finalizeProviderRequestHeaders } from './provider-request-header-orchestrator.js';
import {
  resolveLegacyIflowEndpoint as resolveLegacyIflowEndpointFromRequest,
  resolveLegacyIflowRequestBody as resolveLegacyIflowRequestBodyFromRequest,
  resolveProviderFamilyProfile
} from './provider-family-profile-utils.js';
import {
  applyProviderStreamModeHeaders,
  buildProviderHttpRequestBody,
  resolveProviderBusinessResponseError,
  resolveProviderRequestEndpoint,
  resolveProviderWantsUpstreamSse
} from './provider-request-shaping-utils.js';
import type { ProviderFamilyProfile } from '../../profile/profile-contracts.js';

// Transport submodules
import {
  AuthModeUtils,
  RuntimeDetector
} from './transport/index.js';

type ProtocolClient = HttpProtocolClient<ProtocolRequestPayload>;
type TokenPayloadReader = {
  getTokenPayload?: () => Record<string, unknown> | null;
};

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
    const profileKey = resolveProviderProfileKey({
      moduleType: this.type,
      providerType: this.providerType,
      providerId: typeof cfg.providerId === 'string' ? cfg.providerId : undefined
    });
    return ServiceProfileResolver.resolve({
      cfg,
      profileKey,
      providerType: this.providerType
    });
  }

  protected createAuthProvider(): IAuthProvider {
    const authBootstrap = createTransportAuthProvider({
      config: this.config,
      providerType: this.providerType,
      moduleType: this.type,
      serviceProfile: this.serviceProfile,
      extensions: this.config.config.extensions && typeof this.config.config.extensions === 'object'
        ? this.config.config.extensions as Record<string, unknown>
        : undefined
    });
    this.authMode = authBootstrap.authMode;
    this.oauthProviderId = authBootstrap.oauthProviderId;
    return authBootstrap.authProvider;
  }

  protected createHttpClient(): void {
    this.httpClient = createTransportHttpClient({
      config: this.config,
      serviceProfile: this.serviceProfile,
      effectiveBaseUrl: this.getEffectiveBaseUrl()
    });
  }

  private createRequestExecutorDeps(): HttpRequestExecutorDeps {
    return buildProviderRequestExecutorDeps({
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
      wrapUpstreamSseResponse: this.wrapUpstreamSseResponse.bind(this),
      resolveBusinessResponseError: this.resolveProfileBusinessResponseError.bind(this),
      normalizeHttpError: this.normalizeHttpError.bind(this),
      authProvider: this.authProvider,
      oauthProviderId: this.oauthProviderId,
      providerType: this.providerType,
      config: this.config,
      httpClient: this.httpClient
    });
  }

  protected async preprocessRequest(request: UnknownObject): Promise<UnknownObject> {
    const context = this.createProviderContext();
    const runtimeMetadata = context.runtimeMetadata;
    const configuredAuthType =
      this.config?.config?.auth && typeof this.config.config.auth.type === 'string'
        ? this.config.config.auth.type.trim()
        : '';
    if (runtimeMetadata && configuredAuthType) {
      runtimeMetadata.authType = configuredAuthType.toLowerCase();
    }
    const requestMetadata =
      request && typeof request === 'object' && typeof (request as { metadata?: unknown }).metadata === 'object'
        ? ((request as { metadata: Record<string, unknown> }).metadata || {})
        : undefined;
    if (runtimeMetadata && requestMetadata?.qwenWebSearch === true) {
      runtimeMetadata.qwenWebSearch = true;
      if (!runtimeMetadata.metadata || typeof runtimeMetadata.metadata !== 'object') {
        runtimeMetadata.metadata = {};
      }
      (runtimeMetadata.metadata as Record<string, unknown>).qwenWebSearch = true;
    }
    this.getRuntimeProfile();
    const processedRequest = ProviderRequestPreprocessor.preprocess(request, runtimeMetadata);
    logVisionDebugSummary('preprocess', processedRequest);
    await captureVisionDebugPayloadSnapshot('provider-preprocess-debug', processedRequest);
    return processedRequest;
  }

  protected async postprocessResponse(response: unknown, context: ProviderContext): Promise<UnknownObject> {
    this.getRuntimeProfile();
    return buildPostprocessedProviderResponse({
      response,
      context,
      providerType: this.providerType
    });
  }

  protected async sendRequestInternal(request: UnknownObject): Promise<unknown> {
    const context = this.createProviderContext();
    return this.requestExecutor.execute(request, context);
  }

  protected wantsUpstreamSse(request: UnknownObject, context: ProviderContext): boolean {
    const runtimeMetadata = context.runtimeMetadata ?? this.getCurrentRuntimeMetadata();
    return resolveProviderWantsUpstreamSse({
      request,
      context,
      runtimeMetadata,
      familyProfile: this.resolveFamilyProfile(runtimeMetadata)
    });
  }

  protected applyStreamModeHeaders(headers: Record<string, string>, wantsSse: boolean): Record<string, string> {
    const runtimeMetadata = this.getCurrentRuntimeMetadata();
    return applyProviderStreamModeHeaders({
      headers,
      wantsSse,
      runtimeMetadata,
      familyProfile: this.resolveFamilyProfile(runtimeMetadata)
    });
  }

  protected prepareSseRequestBody(body: UnknownObject, context?: ProviderContext): void {
    const runtimeMetadata = context?.runtimeMetadata ?? this.getCurrentRuntimeMetadata();
    const familyProfile = this.resolveFamilyProfile(runtimeMetadata);
    const effectiveContext = context ?? createProviderRuntimeContext({
      runtime: this.getCurrentRuntimeMetadata(),
      serviceProfile: this.serviceProfile,
      providerType: this.providerType
    });
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

  private async normalizeHttpError(
    error: unknown,
    processedRequest: UnknownObject,
    requestInfo: PreparedHttpRequest,
    context: ProviderContext
  ): Promise<ProviderErrorAugmented> {
    return normalizeProviderHttpError({
      error,
      processedRequest,
      requestInfo,
      context
    });
  }

  private resolveProfileBusinessResponseError(response: unknown, context: ProviderContext): Error | undefined {
    const runtimeMetadata = context.runtimeMetadata ?? this.getCurrentRuntimeMetadata();
    return resolveProviderBusinessResponseError({
      response,
      runtimeMetadata,
      familyProfile: this.resolveFamilyProfile(runtimeMetadata)
    });
  }

  /**
   * 为特定请求确定最终 endpoint（默认使用配置值，可由子类覆写）
   */
  protected resolveRequestEndpoint(request: UnknownObject, defaultEndpoint: string): string {
    const runtimeMetadata = this.getCurrentRuntimeMetadata();
    return resolveProviderRequestEndpoint({
      request,
      defaultEndpoint,
      protocolClient: this.protocolClient,
      runtimeMetadata,
      familyProfile: this.resolveFamilyProfile(runtimeMetadata),
      legacyEndpoint: this.resolveLegacyIflowEndpoint(request)
    });
  }

  /**
   * 构造最终发送到上游的请求体，默认实现包含模型/令牌治理，可由子类覆写
   */
  protected buildHttpRequestBody(request: UnknownObject): UnknownObject {
    const runtimeMetadata = this.getCurrentRuntimeMetadata();
    return buildProviderHttpRequestBody({
      request,
      protocolClient: this.protocolClient,
      runtimeMetadata,
      familyProfile: this.resolveFamilyProfile(runtimeMetadata),
      legacyBody: this.resolveLegacyIflowRequestBody(request)
    });
  }

  private resolveFamilyProfile(runtimeMetadata?: ProviderRuntimeMetadata): ProviderFamilyProfile | undefined {
    return resolveProviderFamilyProfile({
      runtimeMetadata,
      runtimeProfile: this.getRuntimeProfile(),
      configProviderId: this.config?.config?.providerId,
      configProviderType: this.config?.config?.providerType,
      providerType: this.providerType,
      oauthProviderId: this.oauthProviderId
    });
  }

  private resolveLegacyIflowEndpoint(request: UnknownObject): string | undefined {
    return resolveLegacyIflowEndpointFromRequest({
      request,
      isIflowRuntime: this.isIflowTransportRuntime(this.getCurrentRuntimeMetadata())
    });
  }

  private resolveLegacyIflowRequestBody(request: UnknownObject): UnknownObject | undefined {
    return resolveLegacyIflowRequestBodyFromRequest({
      request,
      isIflowRuntime: this.isIflowTransportRuntime(this.getCurrentRuntimeMetadata())
    });
  }

  /**
   * 允许子类在 Hook 运行完后对头部做最终调整
   */
  protected async finalizeRequestHeaders(
    headers: Record<string, string>,
    request: UnknownObject
  ): Promise<Record<string, string>> {
    const runtimeMetadata = this.getCurrentRuntimeMetadata();
    return finalizeProviderRequestHeaders({
      headers,
      request,
      finalizeHeaders: (baseHeaders, req) => this.protocolClient.finalizeHeaders(baseHeaders, req as ProtocolRequestPayload),
      runtimeMetadata,
      familyProfile: this.resolveFamilyProfile(runtimeMetadata),
      providerType: this.providerType,
      isIflow: this.isIflowTransportRuntime(runtimeMetadata)
    });
  }

  // 私有方法
  private validateConfig(): void {
    const profile = this.serviceProfile;
    const cfg = this.config.config as ProviderConfigInternal;
    const profileKey = resolveProviderProfileKey({
      moduleType: this.type,
      providerType: this.providerType,
      providerId: typeof cfg.providerId === 'string' ? cfg.providerId : undefined
    });
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

  protected async buildRequestHeaders(): Promise<Record<string, string>> {
    const runtimeMetadata = this.getCurrentRuntimeMetadata();
    const isAntigravity = this.isAntigravityTransportRuntime(runtimeMetadata);
    const runtimeHeaders = this.getRuntimeProfile()?.headers || {};
    const isGeminiFamily = this.isGeminiFamilyTransport();
    const isIflow = this.isIflowTransportRuntime(runtimeMetadata);
    return buildProviderRequestHeaders({
      config: this.config.config,
      authProvider: this.authProvider,
      oauthProviderId: this.oauthProviderId,
      serviceProfile: this.serviceProfile,
      runtimeMetadata,
      runtimeHeaders,
      familyProfile: this.resolveFamilyProfile(runtimeMetadata),
      isGeminiFamily,
      isAntigravity,
      isIflow,
      providerType: this.providerType
    });
  }

  private isAntigravityTransportRuntime(runtimeMetadata?: ProviderRuntimeMetadata): boolean {
    return this.getRuntimeDetector().isAntigravity(runtimeMetadata);
  }

  private isIflowTransportRuntime(runtimeMetadata?: ProviderRuntimeMetadata): boolean {
    return this.getRuntimeDetector().isIflow(runtimeMetadata);
  }

  protected getEffectiveBaseUrl(): string {
    const cfg = this.config.config as ProviderConfigInternal;
    const profileKey = resolveProviderProfileKey({
      moduleType: this.type,
      providerType: this.providerType,
      providerId: typeof cfg.providerId === 'string' ? cfg.providerId : undefined
    });
    const authResourceBaseUrl = this.resolveAuthResourceBaseUrlOverride();
    return RuntimeEndpointResolver.resolveEffectiveBaseUrl({
      runtime: this.getRuntimeProfile(),
      overrideBaseUrl: authResourceBaseUrl ?? this.config.config.overrides?.baseUrl,
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

  protected createProviderContext(): ProviderContext {
    return createProviderRuntimeContext({
      runtime: this.getCurrentRuntimeMetadata(),
      serviceProfile: this.serviceProfile,
      providerType: this.providerType
    });
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

  private resolveAuthResourceBaseUrlOverride(): string | undefined {
    const cfg = this.config.config as ProviderConfigInternal & { providerId?: string };
    const providerId = typeof cfg.providerId === 'string' ? cfg.providerId.trim().toLowerCase() : '';
    if (providerId !== 'qwen') {
      return undefined;
    }

    const authReader = this.authProvider as TokenPayloadReader | null;
    if (!authReader?.getTokenPayload) {
      return undefined;
    }

    let payload: Record<string, unknown> | null = null;
    try {
      payload = authReader.getTokenPayload();
    } catch {
      return undefined;
    }
    if (!payload || typeof payload !== 'object') {
      return undefined;
    }

    const raw =
      (typeof payload.resource_url === 'string' && payload.resource_url.trim()) ||
      (typeof payload.resourceUrl === 'string' && payload.resourceUrl.trim())
        ? String((payload.resource_url ?? payload.resourceUrl)).trim()
        : '';
    if (!raw) {
      return undefined;
    }

    let baseUrl = raw;
    if (!/^https?:\/\//i.test(baseUrl)) {
      baseUrl = `https://${baseUrl}`;
    }
    baseUrl = baseUrl.replace(/\/+$/, '');
    const runtimeMetadata = this.getCurrentRuntimeMetadata();
    const isQwenWebSearchRequest =
      runtimeMetadata?.qwenWebSearch === true ||
      (runtimeMetadata?.metadata &&
        typeof runtimeMetadata.metadata === 'object' &&
        (runtimeMetadata.metadata as Record<string, unknown>).qwenWebSearch === true);
    if (!isQwenWebSearchRequest && !/\/v1$/i.test(baseUrl)) {
      baseUrl = `${baseUrl}/v1`;
    }
    return baseUrl;
  }

}
