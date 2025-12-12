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
import { DynamicProfileLoader, ServiceProfileValidator } from '../config/service-profiles.js';
import { ApiKeyAuthProvider } from '../../auth/apikey-auth.js';
import { OAuthAuthProvider } from '../../auth/oauth-auth.js';
import { TokenFileAuthProvider } from '../../auth/tokenfile-auth.js';
import { ensureValidOAuthToken, handleUpstreamInvalidOAuthToken } from '../../auth/oauth-lifecycle.js';
import { createHookSystemIntegration, HookSystemIntegration } from '../hooks/hooks-integration.js';
import { writeProviderSnapshot } from '../utils/snapshot-writer.js';
import type { IAuthProvider } from '../../auth/auth-interface.js';
import type { ApiKeyAuth, OAuthAuth, OpenAIStandardConfig } from '../api/provider-config.js';
import type { ProviderContext, ProviderError, ProviderRuntimeProfile, ServiceProfile, ProviderType } from '../api/provider-types.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import { ProviderComposite } from '../composite/provider-composite.js';
import { attachProviderRuntimeMetadata } from './provider-runtime-metadata.js';
import type { HttpProtocolClient, ProtocolRequestPayload } from '../../../client/http-protocol-client.js';
import { OpenAIChatProtocolClient } from '../../../client/openai/chat-protocol-client.js';

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
  __sse_stream?: unknown;
  model?: string;
  usage?: UnknownObject;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
type ProviderErrorAugmented = ProviderError & {
  code?: string;
  retryable?: boolean;
  status?: number;
  response?: {
    data?: {
      error?: {
        code?: string;
        message?: string;
      };
    };
  };
  details?: Record<string, unknown>;
  providerFamily?: string;
  requestId?: string;
  providerKey?: string;
  providerId?: string;
  providerType?: string;
  routeName?: string;
};

type ProviderConfigInternal = OpenAIStandardConfig['config'] & {
  endpoint?: string;
  defaultModel?: string;
  headers?: Record<string, string>;
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
  protected hookSystemIntegration: HookSystemIntegration;
  protected protocolClient: ProtocolClient;
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

    // 创建认证提供者
    this.authProvider = this.createAuthProvider();

    // 初始化Hook系统集成
    this.hookSystemIntegration = this.initializeHookSystem();
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
        if (this.normalizeAuthMode(auth.type) === 'oauth') {
          const oauthAuth = auth as OAuthAuthExtended;
          const oauthProviderId = this.ensureOAuthProviderId(oauthAuth, extensions);
          const forceReauthorize = false;
          const tokenFileHint = oauthAuth.tokenFile ?? '(default)';
          console.log(`[OAuth] [init] provider=${oauthProviderId} type=${auth.type} tokenFile=${tokenFileHint} forceReauth=${forceReauthorize}`);
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
            console.log('[OAuth] [init] ensureValid OK');
            try {
              if (this.authProvider instanceof TokenFileAuthProvider) {
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
              providerType: this.providerType,
              error: msg
            });
            throw error;
          }
          try {
            (this.authProvider as OAuthAwareAuthProvider).getOAuthClient?.()?.loadToken?.();
          } catch {
            // ignore
          }
        } else {
          try {
            await this.authProvider.validateCredentials();
          } catch {
            // ignore
          }
        }
      }

      // 初始化新的Hook系统集成
      await this.hookSystemIntegration.initialize();

      // 设置调试配置（向后兼容）
      this.configureHookDebugging();

      this.dependencies.logger?.logModule(this.id, 'provider-hook-system-initialized', {
        providerType: this.providerType,
        integrationEnabled: true
      });
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

  /**
   * 初始化Hook系统集成
   */
  private initializeHookSystem(): HookSystemIntegration {
    try {
      const integration = createHookSystemIntegration(
        this.dependencies,
        this.id,
        {
          enabled: true,
          debugMode: true, // Provider v2默认启用调试模式
          snapshotEnabled: true,
          migrationMode: true // 迁移现有Hooks
        }
      );

      this.dependencies.logger?.logModule(this.id, 'hook-system-integration-created', {
        providerId: this.id
      });

      return integration;
    } catch (error) {
      this.dependencies.logger?.logModule(this.id, 'hook-system-integration-failed', {
        error: error instanceof Error ? error.message : String(error)
      });

      // 创建兼容的空实现，避免系统崩溃
      return {
        getBidirectionalHookManager: () => ({
          registerHook: () => {},
          unregisterHook: () => {},
          executeHookChain: async () => ({ data: {}, metrics: {} }),
          setDebugConfig: () => {}
        }),
        setDebugConfig: () => {},
        initialize: async () => {},
        getStats: () => ({ enabled: false }),
        healthCheck: async () => ({ healthy: true }),
        start: async () => {},
        stop: async () => {},
        shutdown: async () => {}
      } as unknown as HookSystemIntegration;
    }
  }

  /**
   * 配置Hook调试（保持向后兼容）
   */
  private configureHookDebugging(): void {
    try {
      // 设置调试配置（使用统一Hook系统的阶段字符串）
      const debugConfig = {
        enabled: true,
        level: 'verbose',
        maxDataSize: 1024 * 64, // 64KB 单次输出上限，避免过大控制台噪声
        stages: [
          'request_preprocessing',
          'request_validation',
          'authentication',
          'http_request',
          'http_response',
          'response_validation',
          'response_postprocessing',
          'error_handling'
        ],
        outputFormat: 'structured',
        outputTargets: ['console'],
        performanceThresholds: {
          maxHookExecutionTime: 500,    // 单个Hook 500ms告警
          maxTotalExecutionTime: 5000,  // 阶段总时长 5s 告警
          maxDataSize: 1024 * 256       // 256KB 数据告警
        }
      };

      this.hookSystemIntegration.setDebugConfig(debugConfig);

      this.dependencies.logger?.logModule(this.id, 'provider-debug-hooks-configured', {
        providerType: this.providerType
      });
    } catch (error) {
      this.dependencies.logger?.logModule(this.id, 'provider-debug-hooks-error', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
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
          : (baseProfile?.timeout ?? 300000);

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
    const providerIdForAuth = authMode === 'oauth'
      ? this.ensureOAuthProviderId(auth as OAuthAuthExtended, extensions)
      : this.providerType;

    // 验证认证配置（按 providerIdForAuth 选择服务档案）
    const validation = ServiceProfileValidator.validateServiceProfile(
      providerIdForAuth,
      authMode
    );

    if (!validation.isValid) {
      throw new Error(
        `Invalid auth configuration for ${providerIdForAuth}: ${validation.errors.join(', ')}`
      );
    }

    // 根据认证类型创建对应的认证提供者
    if (authMode === 'apikey') {
      return new ApiKeyAuthProvider(auth as ApiKeyAuth);
    } else if (authMode === 'oauth') {
      const oauthAuth = auth as OAuthAuthExtended;
      // For providers like Qwen where public OAuth client may not be available,
      // allow reading tokens produced by external login tools (CLIProxyAPI)
      const useTokenFile =
        (providerIdForAuth === 'qwen' || providerIdForAuth === 'iflow') &&
        !oauthAuth.clientId &&
        !oauthAuth.tokenUrl &&
        !oauthAuth.deviceCodeUrl;
      if (useTokenFile) {
        return new TokenFileAuthProvider(oauthAuth);
      }
      return new OAuthAuthProvider(oauthAuth, providerIdForAuth);
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
      : (this.config.config.overrides?.timeout ?? profile.timeout ?? 300000);
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

  protected async preprocessRequest(request: UnknownObject): Promise<UnknownObject> {
    const context = this.createProviderContext();
    const runtimeMetadata = context.runtimeMetadata;

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
        __origModel: inboundModel
      };
    } catch { /* ignore */ }
    // 流式开关：基础 Provider 统一移除入口层的 stream 标记，
    // 具体协议（如 Responses/Anthropic）的真实流控由各自独立 Provider 处理
    try {
      // 统一：所有入口均移除 stream=true（Provider 始终走非流式），SSE 由上层合成
      const requestBody = processedRequest as { stream?: boolean };
      if (requestBody.stream === true) {
        delete requestBody.stream;
      }
    } catch { /* ignore */ }

    // 获取Hook管理器（新的统一系统）
    const hookManager = this.getHookManager();

    // 🔍 Hook 1: 请求预处理阶段
    const preprocessResult = await hookManager.executeHookChain(
      'request_preprocessing',
      'request',
      processedRequest,
      context
    );

    processedRequest = preprocessResult.data as UnknownObject;
    ensureRuntimeMetadata(processedRequest);

    // 🔍 Hook 2: 请求验证阶段
    const validationResult = await hookManager.executeHookChain(
      'request_validation',
      'request',
      processedRequest,
      context
    );

    processedRequest = validationResult.data as UnknownObject;
    ensureRuntimeMetadata(processedRequest);

    // Provider 层不再修改工具 schema；统一入口在 llmswitch-core/兼容层

    // 新增：ProviderComposite.compat.request（协议敏感；Fail Fast）
    try {
      const compatProfile = (runtime?.compatibilityProfile || '').toLowerCase();
      const shouldRunCompat = compatProfile !== 'none';
      if (shouldRunCompat) {
        ensureRuntimeMetadata(processedRequest);
        processedRequest = await ProviderComposite.applyRequest(processedRequest, {
          providerType: runtime?.providerType || this.providerType,
          providerFamily: runtime?.providerFamily || runtime?.providerId || runtime?.providerKey,
          dependencies: this.dependencies
        });
        ensureRuntimeMetadata(processedRequest);
      }
    } catch (e) {
      // 暴露问题，不兜底
      this.dependencies.logger?.logModule?.(this.id, 'compat-request-error', {
        error: e instanceof Error ? e.message : String(e)
      });
      throw e;
    }

    return processedRequest;
  }

  protected async postprocessResponse(response: unknown, context: ProviderContext): Promise<UnknownObject> {
    const runtime = this.getRuntimeProfile();
    // 流式短路：若上游仍返回 SSE，则统一包装为 __sse_responses，交由 HTTP 层原样透传
    try {
      const responseRecord = this.asResponseRecord(response);
      if (responseRecord.__sse_stream) {
        return { __sse_responses: responseRecord.__sse_stream };
      }
      if (responseRecord.data?.__sse_stream) {
        return { __sse_responses: responseRecord.data.__sse_stream };
      }
    } catch {
      // ignore
    }
    const processingTime = Date.now() - context.startTime;

    let processedResponse = response;

    // 获取Hook管理器（新的统一系统）
    const hookManager = this.getHookManager();

    // 🔍 Hook 3: HTTP响应阶段
    const httpResponseResult = await hookManager.executeHookChain(
      'http_response',
      'response',
      processedResponse,
      context
    );

    processedResponse = httpResponseResult.data;

    // 🔍 Hook 4: 响应验证阶段
    const validationResult = await hookManager.executeHookChain(
      'response_validation',
      'response',
      processedResponse,
      context
    );

    processedResponse = validationResult.data;

    // 🔍 Hook 5: 响应后处理阶段
    const postprocessResult = await hookManager.executeHookChain(
      'response_postprocessing',
      'response',
      processedResponse,
      context
    );

    processedResponse = postprocessResult.data;

    // 新增：ProviderComposite.compat.response（在封装/模型名还原之前）
    try {
      const compatProfile = (runtime?.compatibilityProfile || '').toLowerCase();
      const shouldRunCompat = compatProfile !== 'none';
      if (shouldRunCompat) {
        processedResponse = await ProviderComposite.applyResponse(processedResponse, undefined, {
          providerType: runtime?.providerType || this.providerType,
          providerFamily: runtime?.providerFamily || runtime?.providerId || runtime?.providerKey,
          dependencies: this.dependencies,
          runtime: context.runtimeMetadata
        });
      }
    } catch (e) {
      this.dependencies.logger?.logModule?.(this.id, 'compat-response-error', {
        error: e instanceof Error ? e.message : String(e)
      });
      throw e;
    }

    const processedRecord = this.asResponseRecord(processedResponse);
    const originalRecord = this.asResponseRecord(response);

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
        usage: this.extractUsage(processedRecord) ?? this.extractUsage(originalRecord),
        hookMetrics: {
          httpResponse: httpResponseResult.metrics,
          validation: validationResult.metrics,
          postprocess: postprocessResult.metrics
        }
      }
    } as UnknownObject;
  }

  protected async sendRequestInternal(request: UnknownObject): Promise<unknown> {
    const context = this.createProviderContext();
    // 获取Hook管理器（新的统一系统）
    const hookManager = this.getHookManager();

    // 🔍 Hook 8: HTTP请求阶段
    const httpRequestResult = await hookManager.executeHookChain(
      'http_request',
      'request',
      request,
      context
    );

    const processedRequest = httpRequestResult.data as UnknownObject;
    const wantsSse = this.wantsUpstreamSse(processedRequest, context);

    // 仅传入 endpoint，让 HttpClient 按 baseUrl 进行拼接；避免 full URL 再次拼接导致 /https:/ 重复
    const defaultEndpoint = this.getEffectiveEndpoint();
    const endpoint = this.resolveRequestEndpoint(processedRequest, defaultEndpoint);
    const headers = await this.buildRequestHeaders();
    let finalHeaders = await this.finalizeRequestHeaders(headers, processedRequest);
    finalHeaders = this.applyStreamModeHeaders(finalHeaders, wantsSse);
    const targetUrl = `${this.getEffectiveBaseUrl().replace(/\/$/, '')}/${endpoint.startsWith('/') ? endpoint.slice(1) : endpoint}`;

    // Flatten request body to standard OpenAI Chat JSON
    const finalBody = this.buildHttpRequestBody(processedRequest);
    if (wantsSse) {
      this.prepareSseRequestBody(finalBody, context);
    }

    const entryEndpoint = this.getEntryEndpointFromPayload(processedRequest);

    const clientRequestId = this.getClientRequestIdFromContext(context);

    // 快照：provider-request（默认开启，脱敏headers）
    try {
      await writeProviderSnapshot({
        phase: 'provider-request',
        requestId: context.requestId,
        data: finalBody,
        headers: finalHeaders,
        url: targetUrl,
        entryEndpoint,
        clientRequestId
      });
    } catch { /* non-blocking */ }

    // 发送HTTP请求（根据是否需要 SSE 决定传输模式）
    let response: unknown;
    try {
      if (wantsSse) {
        const stream = await this.httpClient.postStream(endpoint, finalBody, finalHeaders);
        response = await this.wrapUpstreamSseResponse(stream, context);
        try {
          await writeProviderSnapshot({
            phase: 'provider-response',
            requestId: context.requestId,
            data: { mode: 'sse' },
            headers: finalHeaders,
            url: targetUrl,
            entryEndpoint,
            clientRequestId
          });
        } catch { /* non-blocking */ }
      } else {
        response = await this.httpClient.post(endpoint, finalBody, finalHeaders);
        try {
          await writeProviderSnapshot({
            phase: 'provider-response',
            requestId: context.requestId,
            data: response,
            headers: finalHeaders,
            url: targetUrl,
            entryEndpoint,
            clientRequestId
          });
        } catch { /* non-blocking */ }
      }
    } catch (error) {
      // OAuth token 失效：尝试刷新/重获并重试一次
      try {
        const providerAuth = this.config.config.auth;
        if (this.normalizeAuthMode(providerAuth.type) === 'oauth') {
          const shouldRetry = await handleUpstreamInvalidOAuthToken(
            this.providerType,
            providerAuth as OAuthAuthExtended,
            error
          );
          if (shouldRetry) {
            const retryHeaders = await this.buildRequestHeaders();
            let finalRetryHeaders = await this.finalizeRequestHeaders(retryHeaders, processedRequest);
            finalRetryHeaders = this.applyStreamModeHeaders(finalRetryHeaders, wantsSse);
            if (wantsSse) {
              const stream = await this.httpClient.postStream(endpoint, finalBody, finalRetryHeaders);
              const wrapped = await this.wrapUpstreamSseResponse(stream, context);
              try {
                await writeProviderSnapshot({
                  phase: 'provider-response',
                  requestId: context.requestId,
                  data: { mode: 'sse', retry: true },
                  headers: finalRetryHeaders,
                  url: targetUrl,
                  entryEndpoint,
                  clientRequestId
                });
              } catch { /* non-blocking */ }
              return wrapped;
            }
            response = await this.httpClient.post(endpoint, finalBody, finalRetryHeaders);
            try {
              await writeProviderSnapshot({
                phase: 'provider-response',
                requestId: context.requestId,
                data: response,
                headers: finalRetryHeaders,
                url: targetUrl,
                entryEndpoint,
                clientRequestId
              });
            } catch { /* non-blocking */ }
            return response;
          }
        }
      } catch { /* ignore and fallthrough */ }
      // 🔍 Hook 9: 错误处理阶段
      const errorResult = await hookManager.executeHookChain(
        'error_handling',
        'error',
        { error, request: processedRequest, url: targetUrl, headers: finalHeaders },
        context
      );

      // 如果Hook处理了错误，使用Hook的返回结果
      const hookErrorData = errorResult.data as { error?: boolean } | undefined;
      if (hookErrorData && hookErrorData.error === false) {
        return hookErrorData;
      }

      // 规范化错误：补充结构化字段，移除仅文本填充的旧做法
      const normalized: ProviderErrorAugmented = error as ProviderErrorAugmented;
      try {
        // 提取状态码
        const msg = typeof normalized.message === 'string' ? normalized.message : String(normalized || '');
        const m = msg.match(/HTTP\s+(\d{3})/i);
        const parsedStatus = m ? parseInt(m[1], 10) : undefined;
        const statusCode = Number.isFinite(normalized.statusCode)
          ? Number(normalized.statusCode)
          : (Number.isFinite(normalized.status) ? Number(normalized.status) : (parsedStatus || undefined));
        if (statusCode && !Number.isNaN(statusCode)) {
          normalized.statusCode = statusCode;
          if (!normalized.status) {
            normalized.status = statusCode;
          }
          if (!normalized.code) {
            normalized.code = `HTTP_${statusCode}`;
          }
        }
        // 兼容 Manager 的 code 路径（response.data.error.code）
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
      } catch { /* keep original */ }

      // 快照：provider-error（结构化写入）
      try {
        await writeProviderSnapshot({
          phase: 'provider-error',
          requestId: context.requestId,
          data: {
            status: normalized?.statusCode ?? normalized?.status ?? null,
            code: normalized?.code ?? null,
            error: typeof normalized?.message === 'string' ? normalized.message : String(normalized || '')
          },
          headers: finalHeaders,
          url: targetUrl,
          entryEndpoint,
          clientRequestId
        });
      } catch { /* non-blocking */ }

      throw normalized;
    }

    // Provider 不处理工具修复/注入逻辑：统一收敛到 llmswitch-core 与兼容层
    // 此处不做任何自动修复/重试，保持单次请求的幂等与可观测性
    try { /* no-op */ } catch { /* ignore */ }

    return response;
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

  /**
   * 为特定请求确定最终 endpoint（默认使用配置值，可由子类覆写）
   */
  protected resolveRequestEndpoint(request: UnknownObject, defaultEndpoint: string): string {
    return this.protocolClient.resolveEndpoint(
      request as ProtocolRequestPayload,
      defaultEndpoint
    );
  }

  /**
   * 构造最终发送到上游的请求体，默认实现包含模型/令牌治理，可由子类覆写
   */
  protected buildHttpRequestBody(request: UnknownObject): UnknownObject {
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
        const oauthProviderId = this.ensureOAuthProviderId(oauthAuth);
        console.log('[OAuth] [headers] ensureValid start (openBrowser=true, forceReauth=false)');
        try {
          await ensureValidOAuthToken(oauthProviderId, oauthAuth, {
            forceReacquireIfRefreshFails: true,
            openBrowser: true,
            forceReauthorize: false
          });
          console.log('[OAuth] [headers] ensureValid OK');
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

    // 禁用上游SSE：设置 Accept 为 application/json（若未被显式覆盖）
    if (!('Accept' in finalHeaders) && !('accept' in finalHeaders)) {
      finalHeaders['Accept'] = 'application/json';
    }

    // 获取Hook管理器（新的统一系统）
    const hookManager = this.getHookManager();

    // 🔍 Hook 6: 认证阶段
    await hookManager.executeHookChain(
      'authentication',
      'auth',
      authHeaders,
      this.createProviderContext()
    );

    // 🔍 Hook 7: Headers处理阶段
    const headersResult = await hookManager.executeHookChain(
      'request_preprocessing',
      'headers',
      finalHeaders,
      this.createProviderContext()
    );

    finalHeaders = headersResult.data as Record<string, string>;

    return finalHeaders;
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

  private getHookManager() {
    return this.hookSystemIntegration.getBidirectionalHookManager();
  }

  // （工具自动修复辅助函数已删除）
  private getConfigExtensions(): Record<string, unknown> {
    const extensions = this.config.config.extensions;
    return extensions && typeof extensions === 'object'
      ? extensions as Record<string, unknown>
      : {};
  }

  private getEntryEndpointFromPayload(payload: UnknownObject): string | undefined {
    const metadata = (payload as MetadataContainer).metadata;
    if (metadata && typeof metadata.entryEndpoint === 'string') {
      return metadata.entryEndpoint;
    }
    return undefined;
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
}
