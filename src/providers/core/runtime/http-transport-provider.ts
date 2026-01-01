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

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { BaseProvider } from './base-provider.js';
import { HttpClient } from '../utils/http-client.js';
import { DynamicProfileLoader, ServiceProfileValidator } from '../config/service-profiles.js';
import { ApiKeyAuthProvider } from '../../auth/apikey-auth.js';
import { OAuthAuthProvider } from '../../auth/oauth-auth.js';
import { logOAuthDebug } from '../../auth/oauth-logger.js';
import { TokenFileAuthProvider } from '../../auth/tokenfile-auth.js';
import { ensureValidOAuthToken, handleUpstreamInvalidOAuthToken } from '../../auth/oauth-lifecycle.js';
import { fetchAntigravityProjectId } from '../../auth/antigravity-userinfo-helper.js';
import {
  attachProviderSseSnapshotStream,
  writeProviderSnapshot
} from '../utils/snapshot-writer.js';
import type { IAuthProvider } from '../../auth/auth-interface.js';
import type { ApiKeyAuth, OAuthAuth, OpenAIStandardConfig } from '../api/provider-config.js';
import type { ProviderContext, ProviderError, ProviderRuntimeProfile, ServiceProfile, ProviderType } from '../api/provider-types.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import { attachProviderRuntimeMetadata, extractProviderRuntimeMetadata } from './provider-runtime-metadata.js';
import {
  buildVisionSnapshotPayload,
  shouldCaptureVisionDebug,
  summarizeVisionMessages
} from './vision-debug-utils.js';
import type { ProviderRuntimeMetadata } from './provider-runtime-metadata.js';
import type { HttpProtocolClient, ProtocolRequestPayload } from '../../../client/http-protocol-client.js';
import { OpenAIChatProtocolClient } from '../../../client/openai/chat-protocol-client.js';
import { HttpRequestExecutor, type HttpRequestExecutorDeps, type PreparedHttpRequest } from './http-request-executor.js';
import type { ProviderErrorAugmented } from './provider-error-types.js';
import { extractStatusCodeFromError } from './provider-error-classifier.js';

type ProtocolClient = HttpProtocolClient<ProtocolRequestPayload>;
type OAuthAuthExtended = OAuthAuth & { rawType?: string; oauthProviderId?: string; tokenFile?: string };
type OAuthAwareAuthProvider = IAuthProvider & {
  getOAuthClient?: () => { loadToken?: () => void };
};
type MetadataContainer = { metadata?: Record<string, unknown> };
type ResponseRecord = Record<string, unknown> & {
  data?: ResponseRecord;
  headers?: Record<string, unknown>;
  status?: number;
  model?: string;
  usage?: UnknownObject;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

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

const DEFAULT_USER_AGENT = 'codex_cli_rs/0.73.0 (Mac OS 15.6.1; arm64) iTerm.app/3.6.5';


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
        const extensions = this.getConfigExtensions();
        const auth = providerConfig.auth;
        const usesTokenFile = this.authProvider instanceof TokenFileAuthProvider;
        if (this.normalizeAuthMode(auth.type) === 'oauth') {
          const oauthAuth = auth as OAuthAuthExtended;
          const oauthProviderId = this.oauthProviderId || this.ensureOAuthProviderId(oauthAuth, extensions);
          const forceReauthorize = false;
          const tokenFileHint = oauthAuth.tokenFile ?? '(default)';
          logOAuthDebug(
            `[OAuth] [init] provider=${oauthProviderId} type=${auth.type} tokenFile=${tokenFileHint} forceReauth=${forceReauthorize}`
          );
          this.dependencies.logger?.logModule?.(this.id, 'oauth-init-start', {
            providerType: oauthProviderId,
            tokenFile: tokenFileHint,
            forceReauthorize
          });
          try {
            await ensureValidOAuthToken(oauthProviderId, oauthAuth, {
              forceReacquireIfRefreshFails: true,
              openBrowser: true,
              forceReauthorize
            });
            if (this.oauthProviderId === 'antigravity') {
              await this.ensureAntigravityProjectMetadata(oauthAuth);
            }
            logOAuthDebug('[OAuth] [init] ensureValid OK');
            try {
              if (this.authProvider instanceof TokenFileAuthProvider) {
                // 令牌文件可能在 ensureValidOAuthToken 中被创建/更新，重新加载一次
                await this.authProvider.initialize();
              } else {
                (this.authProvider as OAuthAwareAuthProvider).getOAuthClient?.()?.loadToken?.();
              }
            } catch {
              // ignore
            }
            this.dependencies.logger?.logModule?.(this.id, 'oauth-init-success', {
              providerType: oauthProviderId
            });
          } catch (error) {
            const err = error as { message?: string };
            const msg = err?.message ? String(err.message) : String(error);
            console.error(`[OAuth] [init] ensureValid ERROR: ${msg}`);
            this.dependencies.logger?.logModule?.(this.id, 'oauth-init-error', {
              providerType: oauthProviderId,
              error: msg
            });
            throw error;
          }
        } else {
          try {
            await this.authProvider.validateCredentials();
          } catch {
            // ignore
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

    // Feature flag: 优先/强制使用 config-core 输出的 provider 行为字段
    const useConfigCoreEnv = String(
      process.env.ROUTECODEX_USE_CONFIG_CORE_PROVIDER_DEFAULTS ||
      process.env.RCC_USE_CONFIG_CORE_PROVIDER_DEFAULTS ||
      ''
    ).trim().toLowerCase();
    const forceConfigCoreDefaults =
      useConfigCoreEnv === '1' ||
      useConfigCoreEnv === 'true' ||
      useConfigCoreEnv === 'yes' ||
      useConfigCoreEnv === 'on';

    const baseFromCfg = (cfg.baseUrl || cfg.overrides?.baseUrl || '').trim();
    const endpointFromCfg = (cfg.overrides?.endpoint || cfg.endpoint || '').trim();
    const defaultModelFromCfg = (cfg.overrides?.defaultModel || cfg.defaultModel || '').trim();
    const timeoutFromCfg = cfg.overrides?.timeout ?? cfg.timeout;
    const maxRetriesFromCfg = cfg.overrides?.maxRetries ?? cfg.maxRetries;
    const headersFromCfg = (cfg.overrides?.headers || cfg.headers) as Record<string, string> | undefined;
    const authCapsFromCfg = cfg.authCapabilities;

    const hasConfigCoreProfile =
      !!baseFromCfg ||
      !!endpointFromCfg ||
      !!defaultModelFromCfg ||
      typeof timeoutFromCfg === 'number' ||
      typeof maxRetriesFromCfg === 'number' ||
      !!authCapsFromCfg ||
      !!headersFromCfg;

    // 先从 service-profiles 取出基础 profile（用于补全缺失字段/校验）
    const baseProfile =
      DynamicProfileLoader.buildServiceProfile(profileKey) ||
      DynamicProfileLoader.buildServiceProfile(this.providerType);

    // 如果 config-core 已提供字段，或强制要求使用 config-core，则以 config-core 为主
    if (hasConfigCoreProfile || forceConfigCoreDefaults) {
      if (forceConfigCoreDefaults) {
        // 严格模式下，关键字段缺失直接 Fail Fast
        if (!baseFromCfg) {
          throw new Error(
            `Provider config-core defaults missing baseUrl for providerId=${profileKey}`
          );
        }
        if (!endpointFromCfg && !baseProfile?.defaultEndpoint) {
          throw new Error(
            `Provider config-core defaults missing endpoint for providerId=${profileKey}`
          );
        }
      }

      const defaultBaseUrl =
        baseFromCfg ||
        baseProfile?.defaultBaseUrl ||
        'https://api.openai.com/v1';

      const defaultEndpoint =
        endpointFromCfg ||
        baseProfile?.defaultEndpoint ||
        '/chat/completions';

      const defaultModel =
        (defaultModelFromCfg && defaultModelFromCfg.length > 0)
          ? defaultModelFromCfg
          : (baseProfile?.defaultModel ?? '');

      const genericRequiredAuth: string[] = [];
      const genericOptionalAuth: string[] = ['apikey', 'oauth'];

      const requiredAuth =
        authCapsFromCfg?.required && authCapsFromCfg.required.length
          ? authCapsFromCfg.required
          : (baseProfile?.requiredAuth ?? genericRequiredAuth);

      const optionalAuth =
        authCapsFromCfg?.optional && authCapsFromCfg.optional.length
          ? authCapsFromCfg.optional
          : (baseProfile?.optionalAuth ?? genericOptionalAuth);

      const mergedHeaders: Record<string, string> = {
        ...(baseProfile?.headers || {}),
        ...(headersFromCfg || {})
      };

      const timeout =
        typeof timeoutFromCfg === 'number'
          ? timeoutFromCfg
          // 默认 Provider 请求超时时间：500s
          : (baseProfile?.timeout ?? 500000);

      const maxRetries =
        typeof maxRetriesFromCfg === 'number'
          ? maxRetriesFromCfg
          : (baseProfile?.maxRetries ?? 3);

      return {
        defaultBaseUrl,
        defaultEndpoint,
        defaultModel,
        requiredAuth,
        optionalAuth,
        headers: mergedHeaders,
        timeout,
        maxRetries,
        hooks: baseProfile?.hooks,
        features: baseProfile?.features,
        extensions: {
          ...(baseProfile?.extensions || {}),
          protocol: (cfg as { protocol?: string }).protocol || (baseProfile?.extensions as Record<string, unknown> | undefined)?.protocol
        }
      };
    }

    // 未提供 config-core provider 行为字段时，保持原有 service-profiles 行为
    if (baseProfile) {
      return baseProfile;
    }

    throw new Error(`Unknown providerType='${this.providerType}' (no service profile registered)`);
  }

  protected createAuthProvider(): IAuthProvider {
    const auth = this.config.config.auth;
    const extensions = this.getConfigExtensions();
    const authMode = this.normalizeAuthMode(auth.type);
    this.authMode = authMode;
    const resolvedOAuthProviderId =
      authMode === 'oauth'
        ? this.ensureOAuthProviderId(auth as OAuthAuthExtended, extensions)
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
    if (authMode === 'apikey') {
      return new ApiKeyAuthProvider(auth as ApiKeyAuth);
    } else if (authMode === 'oauth') {
      const oauthAuth = auth as OAuthAuthExtended;
      const oauthProviderId = resolvedOAuthProviderId ?? serviceProfileKey;
      this.oauthProviderId = oauthProviderId;
      // For providers like Qwen/iflow/Gemini CLI where public OAuth client may not be available,
      // allow reading tokens produced by external login tools (CLIProxyAPI) via token file.
      const useTokenFile =
        (
          oauthProviderId === 'qwen' ||
          oauthProviderId === 'iflow' ||
          this.type === 'gemini-cli-http-provider'
        ) &&
        !oauthAuth.clientId &&
        !oauthAuth.tokenUrl &&
        !oauthAuth.deviceCodeUrl;
      if (useTokenFile) {
        return new TokenFileAuthProvider(oauthAuth);
      }
      return new OAuthAuthProvider(oauthAuth, oauthProviderId);
    } else {
      throw new Error(`Unsupported auth type: ${auth.type}`);
    }
  }

  protected createHttpClient(): void {
    const profile = this.serviceProfile;
    const effectiveBase = this.getEffectiveBaseUrl();
    const envTimeout = Number(process.env.ROUTECODEX_PROVIDER_TIMEOUT_MS || process.env.RCC_PROVIDER_TIMEOUT_MS || NaN);
    const effectiveTimeout = Number.isFinite(envTimeout) && envTimeout > 0
      ? envTimeout
      // 默认 Provider 请求超时时间：500s（可被 env / overrides 覆盖）
      : (this.config.config.overrides?.timeout ?? profile.timeout ?? 500000);
    const envRetries = Number(process.env.ROUTECODEX_PROVIDER_RETRIES || process.env.RCC_PROVIDER_RETRIES || NaN);
    const effectiveRetries = Number.isFinite(envRetries) && envRetries >= 0
      ? envRetries
      : (this.config.config.overrides?.maxRetries ?? profile.maxRetries ?? 3);

    const overrideHeaders =
      this.config.config.overrides?.headers ||
      (this.config.config as { headers?: Record<string, string> }).headers ||
      undefined;
    this.httpClient = new HttpClient({
      baseUrl: effectiveBase,
      timeout: effectiveTimeout,
      maxRetries: effectiveRetries,
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
      buildHttpRequestBody: this.buildHttpRequestBody.bind(this),
      prepareSseRequestBody: this.prepareSseRequestBody.bind(this),
      getEntryEndpointFromPayload: this.getEntryEndpointFromPayload.bind(this),
      getClientRequestIdFromContext: this.getClientRequestIdFromContext.bind(this),
      wrapUpstreamSseResponse: this.wrapUpstreamSseResponse.bind(this),
      getHttpRetryLimit: () => this.getHttpRetryLimit(),
      shouldRetryHttpError: this.shouldRetryHttpError.bind(this),
      delayBeforeHttpRetry: this.delayBeforeHttpRetry.bind(this),
      tryRecoverOAuthAndReplay: this.tryRecoverOAuthAndReplay.bind(this),
      normalizeHttpError: this.normalizeHttpError.bind(this)
    };
  }

  protected async preprocessRequest(request: UnknownObject): Promise<UnknownObject> {
    const context = this.createProviderContext();
    const runtimeMetadata = context.runtimeMetadata;
    const headersFromRequest = this.normalizeClientHeaders((request as MetadataContainer)?.metadata?.clientHeaders);
    const headersFromRuntime = this.normalizeClientHeaders(
      runtimeMetadata?.metadata && typeof runtimeMetadata.metadata === 'object'
        ? (runtimeMetadata.metadata as Record<string, unknown>).clientHeaders
        : undefined
    );
    const effectiveClientHeaders = headersFromRequest ?? headersFromRuntime;
    if (effectiveClientHeaders) {
      if (runtimeMetadata) {
        if (!runtimeMetadata.metadata || typeof runtimeMetadata.metadata !== 'object') {
          runtimeMetadata.metadata = {};
        }
        (runtimeMetadata.metadata as Record<string, unknown>).clientHeaders = effectiveClientHeaders;
      }
    }

    const ensureRuntimeMetadata = (payload: UnknownObject): void => {
      if (!runtimeMetadata || !payload || typeof payload !== 'object') {
        return;
      }
      attachProviderRuntimeMetadata(payload as Record<string, unknown>, runtimeMetadata);
    };

    // 初始请求预处理
    const runtime = this.getRuntimeProfile();
    let processedRequest: UnknownObject = { ...request };
    ensureRuntimeMetadata(processedRequest);
    // 记录入站原始模型，便于响应阶段还原（不影响上游请求体）
    try {
      const requestCarrier = request as MetadataContainer & {
        model?: unknown;
        entryEndpoint?: string;
        stream?: boolean;
      };
      const inboundModel = typeof requestCarrier?.model === 'string' ? requestCarrier.model : undefined;
      const entryEndpoint =
        typeof requestCarrier?.metadata?.entryEndpoint === 'string'
          ? requestCarrier.metadata.entryEndpoint
          : requestCarrier?.entryEndpoint;
      const streamFlag = typeof requestCarrier?.metadata?.stream === 'boolean'
        ? requestCarrier.metadata.stream
        : requestCarrier?.stream;
    const processedMetadata = (processedRequest as MetadataContainer).metadata ?? {};
    (processedRequest as MetadataContainer).metadata = {
      ...processedMetadata,
      ...(entryEndpoint ? { entryEndpoint } : {}),
      ...(typeof streamFlag === 'boolean' ? { stream: !!streamFlag } : {}),
      ...(effectiveClientHeaders ? { clientHeaders: effectiveClientHeaders } : {}),
      __origModel: inboundModel
    };
    } catch { /* ignore */ }
    this.logVisionDebug('preprocess', processedRequest);
    await this.captureVisionDebugSnapshot('provider-preprocess-debug', processedRequest);
    return processedRequest;
  }

  protected async postprocessResponse(response: unknown, context: ProviderContext): Promise<UnknownObject> {
    const runtime = this.getRuntimeProfile();
    const processingTime = Date.now() - context.startTime;

    let processedResponse = response;
    const originalRecord = this.asResponseRecord(response);
    const processedRecord = this.asResponseRecord(processedResponse);

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
        model: context.model ?? this.extractModel(processedRecord) ?? this.extractModel(originalRecord),
        usage: this.extractUsage(processedRecord) ?? this.extractUsage(originalRecord)
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

  protected wantsUpstreamSse(_request: UnknownObject, _context: ProviderContext): boolean {
    return false;
  }

  protected applyStreamModeHeaders(headers: Record<string, string>, wantsSse: boolean): Record<string, string> {
    const normalized = { ...headers };
    const acceptKey = Object.keys(normalized).find((key) => key.toLowerCase() === 'accept');
    if (wantsSse) {
      if (acceptKey) {
        delete normalized[acceptKey];
      }
      normalized['Accept'] = 'text/event-stream';
      return normalized;
    }
    if (!acceptKey) {
      normalized['Accept'] = 'application/json';
    }
    return normalized;
  }

  protected prepareSseRequestBody(_body: UnknownObject, _context: ProviderContext): void {
    // default no-op
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
    return 3;
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
      const providerAuth = this.config.config.auth;
      if (this.normalizeAuthMode(providerAuth.type) !== 'oauth') {
        return undefined;
      }
      const shouldRetry = await handleUpstreamInvalidOAuthToken(
        this.oauthProviderId || this.providerType,
        providerAuth as OAuthAuthExtended,
        error
      );
      if (!shouldRetry) {
        return undefined;
      }
      const retryHeaders = await this.buildRequestHeaders();
      let finalRetryHeaders = await this.finalizeRequestHeaders(retryHeaders, processedRequest);
      finalRetryHeaders = this.applyStreamModeHeaders(finalRetryHeaders, requestInfo.wantsSse);
      if (requestInfo.wantsSse) {
        const upstreamStream = await this.httpClient.postStream(requestInfo.endpoint, requestInfo.body, finalRetryHeaders);
        const streamForHost = captureSse
          ? attachProviderSseSnapshotStream(upstreamStream, {
            requestId: context.requestId,
            headers: finalRetryHeaders,
            url: requestInfo.targetUrl,
            entryEndpoint: requestInfo.entryEndpoint,
            clientRequestId: requestInfo.clientRequestId,
            extra: { retry: true }
          })
          : upstreamStream;
        const wrapped = await this.wrapUpstreamSseResponse(streamForHost, context);
        if (!captureSse) {
          try {
            await writeProviderSnapshot({
              phase: 'provider-response',
              requestId: context.requestId,
              data: { mode: 'sse', retry: true },
              headers: finalRetryHeaders,
              url: requestInfo.targetUrl,
              entryEndpoint: requestInfo.entryEndpoint,
              clientRequestId: requestInfo.clientRequestId
            });
          } catch { /* non-blocking */ }
        }
        return wrapped;
      }
      const response = await this.httpClient.post(requestInfo.endpoint, requestInfo.body, finalRetryHeaders);
      try {
        await writeProviderSnapshot({
          phase: 'provider-response',
          requestId: context.requestId,
          data: response,
          headers: finalRetryHeaders,
          url: requestInfo.targetUrl,
          entryEndpoint: requestInfo.entryEndpoint,
          clientRequestId: requestInfo.clientRequestId
        });
      } catch { /* non-blocking */ }
      return response;
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
        entryEndpoint: requestInfo.entryEndpoint ?? this.getEntryEndpointFromPayload(processedRequest),
        clientRequestId: requestInfo.clientRequestId ?? this.getClientRequestIdFromContext(context)
      });
    } catch { /* non-blocking */ }

    return normalized;
  }

  /**
   * 为特定请求确定最终 endpoint（默认使用配置值，可由子类覆写）
   */
  protected resolveRequestEndpoint(request: UnknownObject, defaultEndpoint: string): string {
    const metadataNode =
      (request as MetadataContainer)?.metadata &&
      typeof (request as MetadataContainer).metadata === 'object'
        ? ((request as MetadataContainer).metadata as Record<string, unknown>)
        : undefined;
    const isIflowWebSearch =
      metadataNode?.iflowWebSearch === true;
    if (isIflowWebSearch) {
      const entryEndpoint =
        typeof metadataNode?.entryEndpoint === 'string' && metadataNode.entryEndpoint.trim()
          ? metadataNode.entryEndpoint.trim()
          : undefined;
      return entryEndpoint || '/chat/retrieve';
    }
    return this.protocolClient.resolveEndpoint(
      request as ProtocolRequestPayload,
      defaultEndpoint
    );
  }

  /**
   * 构造最终发送到上游的请求体，默认实现包含模型/令牌治理，可由子类覆写
   */
  protected buildHttpRequestBody(request: UnknownObject): UnknownObject {
    const metadataNode =
      (request as MetadataContainer)?.metadata &&
      typeof (request as MetadataContainer).metadata === 'object'
        ? ((request as MetadataContainer).metadata as Record<string, unknown>)
        : undefined;
    const isIflowWebSearch =
      metadataNode?.iflowWebSearch === true;
    if (isIflowWebSearch) {
      const dataNode = (request as { data?: UnknownObject }).data;
      if (dataNode && typeof dataNode === 'object') {
        return dataNode as UnknownObject;
      }
      return {};
    }
    return this.protocolClient.buildRequestBody(request as ProtocolRequestPayload);
  }

  /**
   * 允许子类在 Hook 运行完后对头部做最终调整
   */
  protected async finalizeRequestHeaders(
    headers: Record<string, string>,
    request: UnknownObject
  ): Promise<Record<string, string>> {
    return await this.protocolClient.finalizeHeaders(
      headers,
      request as ProtocolRequestPayload
    );
  }

  // 私有方法
  private validateConfig(): void {
    const profile = this.serviceProfile;
    const cfg = this.config.config as ProviderConfigInternal;
    const profileKey = this.resolveProfileKey(cfg);
    const auth = this.config.config.auth;
    const authMode = this.normalizeAuthMode(auth.type);

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
    const inboundClientHeaders = this.extractClientHeaders(runtimeMetadata);
    const normalizedClientHeaders = this.normalizeCodexClientHeaders(inboundClientHeaders);

    // 服务特定头部
    const serviceHeaders = this.serviceProfile.headers || {};

    // 配置覆盖头部
    const overrideHeaders = this.config.config.overrides?.headers || {};
    const runtimeHeaders = this.getRuntimeProfile()?.headers || {};

    // OAuth：请求前确保令牌有效（提前刷新）
    try {
      const auth = this.config.config.auth;
      if (this.normalizeAuthMode(auth.type) === 'oauth') {
        const oauthAuth = auth as OAuthAuthExtended;
        const oauthProviderId = this.oauthProviderId || this.ensureOAuthProviderId(oauthAuth);
        logOAuthDebug('[OAuth] [headers] ensureValid start (openBrowser=true, forceReauth=false)');
        try {
          await ensureValidOAuthToken(oauthProviderId, oauthAuth, {
            forceReacquireIfRefreshFails: true,
            openBrowser: true,
            forceReauthorize: false
          });
          logOAuthDebug('[OAuth] [headers] ensureValid OK');
        } catch (error) {
          const err = error as { message?: string };
          const msg = err?.message ? String(err.message) : String(error);
          console.error(`[OAuth] [headers] ensureValid ERROR: ${msg}`);
          throw error;
        }
        try {
          (this.authProvider as OAuthAwareAuthProvider).getOAuthClient?.()?.loadToken?.();
        } catch {
          // ignore
        }
      }
    } catch {
      // bubble up in authHeaders build below
    }

    // 认证头部（如为 OAuth，若当前无有效 token 则尝试拉取/刷新一次再取 headers）
    let authHeaders: Record<string, string> = {};
    try {
      authHeaders = this.authProvider?.buildHeaders() || {};
    } catch (error) {
      const err = error as { message?: string };
      const msg = err?.message ? String(err.message) : String(error);
      console.error(`[OAuth] [headers] buildHeaders() failed after single ensureValid: ${msg}`);
      throw error;
    }

    let finalHeaders: Record<string, string> = {
      ...baseHeaders,
      ...serviceHeaders,
      ...overrideHeaders,
      ...runtimeHeaders,
      ...authHeaders
    };

    // 保留客户端 Accept；无则默认为 application/json
    const clientAccept = normalizedClientHeaders ? this.findHeaderValue(normalizedClientHeaders, 'Accept') : undefined;
    if (clientAccept) {
      this.assignHeader(finalHeaders, 'Accept', clientAccept);
    } else if (!this.findHeaderValue(finalHeaders, 'Accept')) {
      this.assignHeader(finalHeaders, 'Accept', 'application/json');
    }

    // Header priority:
    // - user/provider config (overrides/runtime) wins
    // - otherwise inherit from inbound client headers
    // - otherwise fall back to defaults
    const uaFromConfig = this.findHeaderValue({ ...overrideHeaders, ...runtimeHeaders }, 'User-Agent');
    const uaFromService = this.findHeaderValue(serviceHeaders, 'User-Agent');
    const resolvedUa = uaFromConfig ?? inboundUserAgent ?? uaFromService ?? DEFAULT_USER_AGENT;
    this.assignHeader(finalHeaders, 'User-Agent', resolvedUa);

    // originator: do not invent one; only forward from config or inbound client
    const originatorFromConfig = this.findHeaderValue({ ...overrideHeaders, ...runtimeHeaders }, 'originator');
    const originatorFromService = this.findHeaderValue(serviceHeaders, 'originator');
    const resolvedOriginator = originatorFromConfig ?? inboundOriginator ?? originatorFromService;
    if (resolvedOriginator) {
      this.assignHeader(finalHeaders, 'originator', resolvedOriginator);
    }

    if (normalizedClientHeaders) {
      const conversationId = this.findHeaderValue(normalizedClientHeaders, 'conversation_id');
      if (conversationId) {
        this.assignHeader(finalHeaders, 'conversation_id', conversationId);
      }
      const sessionId = this.findHeaderValue(normalizedClientHeaders, 'session_id');
      if (sessionId) {
        this.assignHeader(finalHeaders, 'session_id', sessionId);
      }
    }

    if (this.isCodexUaMode()) {
      this.ensureCodexSessionHeaders(finalHeaders, runtimeMetadata);
    }

    return finalHeaders;
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
    const entryEndpoint = this.getEntryEndpointFromRuntime(runtime);

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

  private normalizeCodexClientHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
    if (!headers) {
      return undefined;
    }
    if (!this.isCodexUaMode()) {
      return headers;
    }
    const normalizedHeaders = { ...headers };
    this.copyHeaderValue(normalizedHeaders, headers, 'anthropic-session-id', 'session_id');
    this.copyHeaderValue(normalizedHeaders, headers, 'anthropic-conversation-id', 'conversation_id');
    this.copyHeaderValue(normalizedHeaders, headers, 'anthropic-user-agent', 'User-Agent');
    this.copyHeaderValue(normalizedHeaders, headers, 'anthropic-originator', 'originator');
    return normalizedHeaders;
  }

  private copyHeaderValue(
    target: Record<string, string>,
    source: Record<string, string>,
    from: string,
    to: string
  ): void {
    if (this.findHeaderValue(target, to)) {
      return;
    }
    const value = this.findHeaderValue(source, from);
    if (value) {
      target[to] = value;
    }
  }

  private findHeaderValue(headers: Record<string, string>, target: string): string | undefined {
    const lowered = target.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === lowered && typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return undefined;
  }

  private assignHeader(headers: Record<string, string>, target: string, value: string): void {
    if (!value || !value.trim()) {
      return;
    }
    const lowered = target.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === lowered) {
        headers[key] = value;
        return;
      }
    }
    headers[target] = value;
  }

  private ensureCodexSessionHeaders(
    headers: Record<string, string>,
    runtimeMetadata?: ProviderRuntimeMetadata
  ): void {
    this.setHeaderIfMissing(headers, 'session_id', this.buildCodexIdentifier('session', runtimeMetadata));
    this.setHeaderIfMissing(
      headers,
      'conversation_id',
      this.buildCodexIdentifier('conversation', runtimeMetadata)
    );
  }

  private setHeaderIfMissing(
    headers: Record<string, string>,
    target: string,
    value: string
  ): void {
    if (this.findHeaderValue(headers, target)) {
      return;
    }
    this.assignHeader(headers, target, value);
  }

  private buildCodexIdentifier(
    kind: 'session' | 'conversation',
    runtimeMetadata?: ProviderRuntimeMetadata
  ): string {
    const fallbackId = runtimeMetadata?.metadata && typeof runtimeMetadata.metadata === 'object'
      ? (runtimeMetadata.metadata as Record<string, unknown>).clientRequestId
      : undefined;
    const requestId = runtimeMetadata?.requestId ?? fallbackId;
    const routeName = runtimeMetadata?.routeName;
    const suffix = (requestId ?? `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
      .toString()
      .replace(/[^A-Za-z0-9_-]/g, '_');
    const parts = ['codex_cli', kind, suffix];
    if (routeName) {
      parts.push(routeName.replace(/[^A-Za-z0-9_-]/g, '_'));
    }
    return this.enforceCodexIdentifierLength(parts.join('_'));
  }

  private enforceCodexIdentifierLength(value: string): string {
    if (value.length <= CODEX_IDENTIFIER_MAX_LENGTH) {
      return value;
    }
    const hash = createHash('sha256').update(value).digest('hex').slice(0, 10);
    const keep = Math.max(1, CODEX_IDENTIFIER_MAX_LENGTH - hash.length - 1);
    return `${value.slice(0, keep)}_${hash}`;
  }

  protected getEffectiveBaseUrl(): string {
    const runtime = this.getRuntimeProfile();
    const runtimeEndpoint = this.pickRuntimeBaseUrl(runtime);
    return (
      runtimeEndpoint ||
      runtime?.baseUrl ||
      this.config.config.overrides?.baseUrl ||
      this.config.config.baseUrl ||
      this.serviceProfile.defaultBaseUrl
    );
  }

  protected getEffectiveEndpoint(): string {
    const runtime = this.getRuntimeProfile();
    const runtimeEndpoint =
      runtime?.endpoint && !this.looksLikeAbsoluteUrl(runtime.endpoint)
        ? runtime.endpoint
        : undefined;
    return (
      runtimeEndpoint ||
      this.config.config.overrides?.endpoint ||
      this.serviceProfile.defaultEndpoint
    );
  }

  private pickRuntimeBaseUrl(runtime?: ProviderRuntimeProfile): string | undefined {
    if (!runtime) {
      return undefined;
    }
    if (typeof runtime.baseUrl === 'string' && runtime.baseUrl.trim()) {
      return runtime.baseUrl.trim();
    }
    if (typeof runtime.endpoint === 'string' && this.looksLikeAbsoluteUrl(runtime.endpoint)) {
      return runtime.endpoint.trim();
    }
    return undefined;
  }

  private looksLikeAbsoluteUrl(value?: string): boolean {
    if (!value) {
      return false;
    }
    const trimmed = value.trim();
    return /^https?:\/\//i.test(trimmed) || trimmed.startsWith('//');
  }

  // （工具自动修复辅助函数已删除）
  private getConfigExtensions(): Record<string, unknown> {
    const extensions = this.config.config.extensions;
    return extensions && typeof extensions === 'object'
      ? extensions as Record<string, unknown>
      : {};
  }

  private getEntryEndpointFromPayload(payload: UnknownObject): string | undefined {
    const runtimeMeta = extractProviderRuntimeMetadata(payload as Record<string, unknown>);
    const metadata = (runtimeMeta && typeof runtimeMeta.metadata === 'object')
      ? (runtimeMeta.metadata as Record<string, unknown>)
      : (payload as MetadataContainer).metadata;
    if (metadata && typeof metadata.entryEndpoint === 'string' && metadata.entryEndpoint.trim()) {
      return metadata.entryEndpoint;
    }
    return undefined;
  }

  private getEntryEndpointFromRuntime(runtime?: ProviderRuntimeMetadata): string | undefined {
    if (!runtime || !runtime.metadata || typeof runtime.metadata !== 'object') {
      return undefined;
    }
    const meta = runtime.metadata as Record<string, unknown>;
    const value = meta.entryEndpoint;
    return typeof value === 'string' && value.trim().length ? value : undefined;
  }

  private asResponseRecord(value: unknown): ResponseRecord {
    if (isRecord(value)) {
      return value as ResponseRecord;
    }
    return {};
  }

  private extractModel(record: ResponseRecord): string | undefined {
    if (typeof record.model === 'string' && record.model.trim()) {
      return record.model;
    }
    if (record.data && typeof record.data.model === 'string' && record.data.model.trim()) {
      return record.data.model;
    }
    return undefined;
  }

  private extractUsage(record: ResponseRecord): UnknownObject | undefined {
    if (record.usage && typeof record.usage === 'object') {
      return record.usage as UnknownObject;
    }
    if (record.data && record.data.usage && typeof record.data.usage === 'object') {
      return record.data.usage as UnknownObject;
    }
    return undefined;
  }

  private getClientRequestIdFromContext(context: ProviderContext): string | undefined {
    const fromMetadata = this.extractClientId(context.metadata);
    if (fromMetadata) {
      return fromMetadata;
    }
    const runtimeMeta = context.runtimeMetadata?.metadata;
    return this.extractClientId(runtimeMeta);
  }

  private extractClientId(source: Record<string, unknown> | undefined): string | undefined {
    if (!source || typeof source !== 'object') {
      return undefined;
    }
    const value = (source as Record<string, unknown>).clientRequestId;
    if (typeof value === 'string' && value.trim().length) {
      return value.trim();
    }
    return undefined;
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
    const direct = typeof config?.providerId === 'string' && config.providerId.trim()
      ? config.providerId.trim().toLowerCase()
      : '';
    return direct || this.providerType;
  }

  private normalizeAuthMode(type: unknown): 'apikey' | 'oauth' {
    return typeof type === 'string' && type.toLowerCase().includes('oauth') ? 'oauth' : 'apikey';
  }

  private resolveOAuthProviderId(type: unknown): string | undefined {
    if (typeof type !== 'string') {
      return undefined;
    }
    const match = type.toLowerCase().match(/^([a-z0-9._-]+)-oauth$/);
    return match ? match[1] : undefined;
  }

  private ensureOAuthProviderId(auth: OAuthAuthExtended, extensions?: Record<string, unknown>): string {
    const fromExtension =
      typeof extensions?.oauthProviderId === 'string' && extensions.oauthProviderId.trim()
        ? extensions.oauthProviderId.trim()
        : undefined;
    if (fromExtension) {
      return fromExtension;
    }
    const fromAuthField =
      typeof auth?.oauthProviderId === 'string' && auth.oauthProviderId.trim()
        ? auth.oauthProviderId.trim()
        : undefined;
    if (fromAuthField) {
      return fromAuthField;
    }
    const providerId = this.resolveOAuthProviderId(auth?.rawType ?? auth?.type);
    if (providerId) {
      return providerId;
    }
    const fallback = this.resolveOAuthProviderId(auth?.type);
    if (fallback) {
      return fallback;
    }
    throw new Error(
      `OAuth auth.type must be declared as "<provider>-oauth" (received ${typeof auth?.rawType === 'string' ? auth.rawType : auth?.type ?? 'unknown'})`
    );
  }

  private ensureOAuthProviderIdLegacy(type: unknown): string {
    const providerId = this.resolveOAuthProviderId(type);
    if (!providerId) {
      throw new Error(
        `OAuth auth.type must be declared as "<provider>-oauth" (received ${typeof type === 'string' ? type : 'unknown'})`
      );
    }
    return providerId;
  }

  private extractClientHeaders(source?: Record<string, unknown> | ProviderRuntimeMetadata): Record<string, string> | undefined {
    const normalize = (value: unknown): Record<string, string> | undefined => {
      return this.normalizeClientHeaders(value);
    };
    if (!source || typeof source !== 'object') {
      return undefined;
    }
    const candidates: unknown[] = [];
    const metadataNode = (source as { metadata?: unknown }).metadata;
    if (metadataNode && typeof metadataNode === 'object') {
      const headersNode = (metadataNode as Record<string, unknown>).clientHeaders;
      if (headersNode) {
        candidates.push(headersNode);
      }
    }
    const directNode = (source as { clientHeaders?: unknown }).clientHeaders;
    if (directNode) {
      candidates.push(directNode);
    }
    for (const candidate of candidates) {
      const normalized = normalize(candidate);
      if (normalized) {
        return normalized;
      }
    }
    return undefined;
  }

  private normalizeClientHeaders(value: unknown): Record<string, string> | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const normalized: Record<string, string> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (typeof raw === 'string' && raw.trim()) {
        normalized[key] = raw;
      }
    }
    return Object.keys(normalized).length ? normalized : undefined;
  }

  private async ensureAntigravityProjectMetadata(oauthAuth: OAuthAuthExtended): Promise<void> {
    const tokenFile = typeof oauthAuth?.tokenFile === 'string' ? oauthAuth.tokenFile.trim() : '';
    if (!tokenFile) {
      return;
    }
    const tokenPath = tokenFile.startsWith('~/')
      ? tokenFile.replace(/^~\//, `${process.env.HOME || ''}/`)
      : tokenFile;
    let raw: string;
    try {
      raw = await fs.readFile(tokenPath, 'utf-8');
    } catch {
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (this.extractProjectIdFromTokenSnapshot(parsed)) {
      return;
    }
    const accessToken = this.extractAccessTokenFromSnapshot(parsed);
    if (!accessToken) {
      return;
    }
    const baseOverride = (oauthAuth as { antigravityApiBase?: string }).antigravityApiBase;
    const apiBaseHint = baseOverride || this.getEffectiveBaseUrl();
    const projectId = await fetchAntigravityProjectId(accessToken, apiBaseHint);
    if (!projectId) {
      logOAuthDebug('[OAuth] Antigravity: unable to resolve project_id for token file');
      return;
    }
    parsed.project_id = projectId;
    parsed.projectId = projectId;
    const projectsNode = (parsed as { projects?: { projectId: string }[] }).projects;
    if (!Array.isArray(projectsNode) || !projectsNode.length) {
      (parsed as { projects?: { projectId: string }[] }).projects = [{ projectId }];
    }
    await fs.writeFile(tokenPath, JSON.stringify(parsed, null, 2));
    logOAuthDebug(`[OAuth] Antigravity: persisted project_id=${projectId} for ${tokenPath}`);
  }

  private extractAccessTokenFromSnapshot(snapshot: Record<string, unknown>): string | undefined {
    const lower = (snapshot as { access_token?: unknown }).access_token;
    const upper = (snapshot as { AccessToken?: unknown }).AccessToken;
    const value =
      typeof lower === 'string'
        ? lower
        : typeof upper === 'string'
          ? upper
          : undefined;
    if (value && value.trim()) {
      return value.trim();
    }
    return undefined;
  }

  private extractProjectIdFromTokenSnapshot(snapshot: Record<string, unknown>): string | undefined {
    const directNode = (snapshot as { project_id?: unknown }).project_id;
    const direct = typeof directNode === 'string' ? directNode : undefined;
    if (direct && direct.trim()) {
      return direct.trim();
    }
    const camelNode = (snapshot as { projectId?: unknown }).projectId;
    const camel = typeof camelNode === 'string' ? camelNode : undefined;
    if (camel && camel.trim()) {
      return camel.trim();
    }
    if (Array.isArray((snapshot as { projects?: UnknownObject[] }).projects)) {
      for (const entry of (snapshot as { projects?: UnknownObject[] }).projects ?? []) {
        if (entry && typeof entry === 'object' && typeof (entry as { projectId?: unknown }).projectId === 'string') {
          const candidate = String((entry as { projectId?: unknown }).projectId);
          if (candidate.trim()) {
            return candidate.trim();
          }
        }
      }
    }
    return undefined;
  }
}
const CODEX_IDENTIFIER_MAX_LENGTH = 64;
