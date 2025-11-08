/**
 * OpenAI Standard - 统一OpenAI标准实现
 *
 * 提供统一的OpenAI API标准兼容实现，支持多种OpenAI兼容服务
 */

import { BaseProvider } from './base-provider.js';
import { HttpClient } from '../utils/http-client.js';
import { DynamicProfileLoader, ServiceProfileValidator } from '../config/service-profiles.js';
import { ApiKeyAuthProvider } from '../auth/apikey-auth.js';
import { OAuthAuthProvider } from '../auth/oauth-auth.js';
import { createHookSystemIntegration } from '../hooks/hooks-integration.js';
import { writeProviderSnapshot } from '../utils/snapshot-writer.js';
import type { IAuthProvider } from '../auth/auth-interface.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ProviderContext, ServiceProfile, ProviderType } from '../api/provider-types.js';
import type { UnknownObject } from '../../../../../../types/common-types.js';
import type { ModuleDependencies } from '../../../../interfaces/pipeline-interfaces.js';


/**
 * OpenAI标准Provider实现
 *
 * 统一处理所有OpenAI兼容的服务，通过配置区分不同服务类型
 */
export class OpenAIStandard extends BaseProvider {
  readonly type = 'openai-standard';

  private authProvider: IAuthProvider | null = null;
  private httpClient!: HttpClient;
  private serviceProfile: ServiceProfile;
  private hookSystemIntegration: any; // Hook系统集成实例

  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    super(config, dependencies);

    // 获取服务配置档案
    this.serviceProfile = this.getServiceProfile();

    // 验证配置
    this.validateConfig();

    // 创建HTTP客户端
    this.createHttpClient();

    // 创建认证提供者
    this.authProvider = this.createAuthProvider();

    // 初始化Hook系统集成
    this.initializeHookSystem();
  }

  /**
   * 确保认证提供者完成初始化（避免 ApiKeyAuthProvider 未初始化导致的报错）
   */
  protected override async onInitialize(): Promise<void> {
    // 先调用父类可能的初始化逻辑（当前为空实现，保留可读性）
    try {
      if (this.authProvider && typeof (this.authProvider as any).initialize === 'function') {
        await (this.authProvider as any).initialize();
        // 可选的快速校验（不阻塞主流程）
        if (typeof (this.authProvider as any).validateCredentials === 'function') {
          try { await (this.authProvider as any).validateCredentials(); } catch { /* ignore */ }
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

  /**
   * 初始化Hook系统集成
   */
  private initializeHookSystem(): void {
    try {
      this.hookSystemIntegration = createHookSystemIntegration(
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
    } catch (error) {
      this.dependencies.logger?.logModule(this.id, 'hook-system-integration-failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      // 创建兼容的空实现，避免系统崩溃
      this.hookSystemIntegration = {
        getBidirectionalHookManager: () => ({
          registerHook: () => {},
          unregisterHook: () => {},
          executeHookChain: async () => ({ data: {}, metrics: {} }),
          setDebugConfig: () => {}
        }),
        setDebugConfig: () => {}
      };
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
    const profile = DynamicProfileLoader.buildServiceProfile(this.providerType);
    if (!profile) {
      throw new Error(`Unsupported provider type: ${this.providerType}`);
    }
    return profile;
  }

  protected createAuthProvider(): IAuthProvider {
    const auth = this.config.config.auth;

    // 验证认证配置
    const validation = ServiceProfileValidator.validateServiceProfile(
      this.providerType,
      auth.type
    );

    if (!validation.isValid) {
      throw new Error(
        `Invalid auth configuration for ${this.providerType}: ${validation.errors.join(', ')}`
      );
    }

    // 根据认证类型创建对应的认证提供者
    if (auth.type === 'apikey') {
      return new ApiKeyAuthProvider(auth);
    } else if (auth.type === 'oauth') {
      return new OAuthAuthProvider(auth, this.providerType);
    } else {
      throw new Error(`Unsupported auth type: ${(auth as any).type}`);
    }
  }

  protected createHttpClient(): void {
    const profile = this.serviceProfile;
    const effectiveBase = this.getEffectiveBaseUrl();
    const envTimeout = Number(process.env.ROUTECODEX_PROVIDER_TIMEOUT_MS || process.env.RCC_PROVIDER_TIMEOUT_MS || NaN);
    const effectiveTimeout = Number.isFinite(envTimeout) && envTimeout > 0
      ? envTimeout
      : (this.config.config.overrides?.timeout ?? profile.timeout ?? 60000);
    const envRetries = Number(process.env.ROUTECODEX_PROVIDER_RETRIES || process.env.RCC_PROVIDER_RETRIES || NaN);
    const effectiveRetries = Number.isFinite(envRetries) && envRetries >= 0
      ? envRetries
      : (this.config.config.overrides?.maxRetries ?? profile.maxRetries ?? 3);

    this.httpClient = new HttpClient({
      baseUrl: effectiveBase,
      timeout: effectiveTimeout,
      maxRetries: effectiveRetries,
      defaultHeaders: {
        'Content-Type': 'application/json',
        ...(profile.headers || {}),
      }
    });
  }

  protected async preprocessRequest(request: UnknownObject): Promise<UnknownObject> {
    const context = this.createProviderContext();

    // 初始请求预处理
    const pipelineModel = (this.config.config as any)?.model;
    let processedRequest: UnknownObject = { ...request };
    // 记录入站原始模型，便于响应阶段还原（不影响上游请求体）
    try {
      const inboundModel = (request as any)?.model;
      const entryEndpoint = (request as any)?.metadata?.entryEndpoint || (request as any)?.entryEndpoint;
      const streamFlag = (request as any)?.metadata?.stream ?? (request as any)?.stream;
      (processedRequest as any).metadata = {
        ...(processedRequest as any).metadata,
        ...(entryEndpoint ? { entryEndpoint } : {}),
        ...(typeof streamFlag === 'boolean' ? { stream: !!streamFlag } : {}),
        __origModel: inboundModel
      };
    } catch { /* ignore */ }
    // 发送前覆盖为流水线配置的上游模型（若存在），否则保留原值或使用默认
    (processedRequest as any).model =
      (typeof pipelineModel === 'string' && pipelineModel.trim()) ? pipelineModel.trim() :
      (processedRequest as any).model ||
      this.config.config.overrides?.defaultModel ||
      this.serviceProfile.defaultModel;

    // 流式开关：仅当非 Responses 端点时才移除 stream；Responses 端点需要真实上游流
    try {
      const entryEndpoint = String(((request as any)?.metadata?.entryEndpoint) || '');
      const isResponses = entryEndpoint === '/v1/responses';
      if ((processedRequest as any).stream === true && !isResponses) {
        delete (processedRequest as any).stream;
      }
    } catch { /* ignore */ }

    // 获取Hook管理器（新的统一系统）
    const hookManager = this.hookSystemIntegration.getBidirectionalHookManager() as any;

    // 🔍 Hook 1: 请求预处理阶段
    const preprocessResult = await hookManager.executeHookChain(
      'request_preprocessing',
      'request',
      processedRequest,
      context
    );

    processedRequest = preprocessResult.data as UnknownObject;

    // 🔍 Hook 2: 请求验证阶段
    const validationResult = await hookManager.executeHookChain(
      'request_validation',
      'request',
      processedRequest,
      context
    );

    processedRequest = validationResult.data as UnknownObject;

    // Provider 层不再修改工具 schema；统一入口在 llmswitch-core/兼容层

    return processedRequest;
  }

  protected async postprocessResponse(response: unknown, context: ProviderContext): Promise<unknown> {
    // 流式短路：保持原始流对象上行，不进入后处理链
    try {
      const r: any = response as any;
      if (r && typeof r === 'object' && r.__sse_stream) {
        return r;
      }
    } catch { /* ignore */ }
    const processingTime = Date.now() - context.startTime;

    let processedResponse = response;

    // 获取Hook管理器（新的统一系统）
    const hookManager = this.hookSystemIntegration.getBidirectionalHookManager() as any;

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

    // Normalize tool arguments for Chat non-stream responses (fix invalid stringified arrays like "[\"ls\", \"-la\"]")
    try {
      const root: any = (processedResponse as any)?.data?.data || (processedResponse as any)?.data || processedResponse;
      const tryNormalize = (fnArgs: any): any => {
        if (typeof fnArgs !== 'string') return fnArgs;
        try {
          const obj = JSON.parse(fnArgs);
          const cmd = (obj as any).command;
          if (typeof cmd === 'string') {
            const s = String(cmd).trim();
            let arr: string[] | null = null;
            // case: JSON array as string
            if ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('"[') && s.endsWith(']"'))) {
              const cleaned = s.replace(/^"|"$/g, '');
              try { arr = JSON.parse(cleaned.replace(/'/g, '"')); } catch { /* fallthrough */ }
            }
            // case: comma separated
            if (!arr && s.includes(',')) {
              arr = s.replace(/\[|\]|\"/g, '').split(',').map(x => x.trim()).filter(Boolean);
            }
            // case: whitespace separated tokens
            if (!arr && s.length) {
              const parts = s.replace(/\[|\]|\"/g, '').split(/\s+/).filter(Boolean);
              if (parts.length > 1) arr = parts;
            }
            if (arr && Array.isArray(arr)) {
              (obj as any).command = arr;
            }
          }
          return JSON.stringify(obj);
        } catch {
          return fnArgs;
        }
      };
      const normalizeMessage = (msg: any) => {
        try {
          const tcs = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
          for (const tc of tcs) {
            if (tc && tc.function) {
              tc.function.arguments = tryNormalize(tc.function.arguments);
            }
          }
        } catch { /* ignore */ }
      };
      // OpenAI Chat non-stream (chat.completion)
      if (root && Array.isArray(root?.choices)) {
        for (const ch of root.choices) {
          if (ch?.message) normalizeMessage(ch.message);
        }
      }
      // OpenAI Responses shape (output -> message content)
      if (root && Array.isArray(root?.output)) {
        for (const item of root.output) {
          if (item?.role === 'assistant' && Array.isArray(item?.content)) {
            // some implementations might carry tool calls here in variants; keep minimal
          }
        }
      }
    } catch { /* silent normalize errors */ }

    // 响应模型名还原为入站模型（仅对外展示层；上游快照保持原样）
    try {
      const root: any = (processedResponse as any)?.data?.data || (processedResponse as any)?.data || processedResponse;
      if (root && typeof root === 'object' && typeof (root as any).model === 'string') {
        const inboundModel = (context as any)?.model || (processedResponse as any)?.metadata?.__origModel;
        if (typeof inboundModel === 'string' && inboundModel.trim()) {
          (root as any).model = inboundModel.trim();
        }
      }
    } catch { /* ignore */ }

    return {
      data: (processedResponse as any).data || processedResponse,
      status: (processedResponse as any).status || (response as any).status,
      headers: (processedResponse as any).headers || (response as any).headers,
      metadata: {
        requestId: context.requestId,
        processingTime,
        providerType: this.providerType,
        // 对外暴露的 model 统一为入站模型
        model: (context as any)?.model || ((processedResponse as any).data as any)?.model || ((response as any).data as any)?.model,
        usage: ((processedResponse as any).data as any)?.usage || ((response as any).data as any)?.usage,
        hookMetrics: {
          httpResponse: httpResponseResult.metrics,
          validation: validationResult.metrics,
          postprocess: postprocessResult.metrics
        }
      }
    };
  }

  protected async sendRequestInternal(request: UnknownObject): Promise<unknown> {
    // 仅传入 endpoint，让 HttpClient 按 baseUrl 进行拼接；避免 full URL 再次拼接导致 /https:/ 重复
    const endpoint = this.getEffectiveEndpoint();
    const headers = await this.buildRequestHeaders();
    const context = this.createProviderContext();
    const targetUrl = `${this.getEffectiveBaseUrl().replace(/\/$/, '')}/${endpoint.startsWith('/') ? endpoint.slice(1) : endpoint}`;

    // 获取Hook管理器（新的统一系统）
    const hookManager = this.hookSystemIntegration.getBidirectionalHookManager() as any;

    // 🔍 Hook 8: HTTP请求阶段
    const httpRequestResult = await hookManager.executeHookChain(
      'http_request',
      'request',
      request,
      context
    );

    const processedRequest = httpRequestResult.data as UnknownObject;

    // Flatten request body to standard OpenAI Chat JSON
    const finalBody = (() => {
      const r: any = processedRequest || {};
      const dataObj: any = (r && typeof r === 'object' && 'data' in r && typeof r.data === 'object') ? r.data : r;
      const body: any = { ...dataObj };
      // Override model with provider config if specified
      const cfgModel = (this.config as any)?.config?.model;
      if (typeof cfgModel === 'string' && cfgModel.trim()) {
        body.model = cfgModel.trim();
      } else if (typeof body.model !== 'string' || !body.model) {
        // fallback to service profile default if missing
        body.model = this.serviceProfile.defaultModel;
      }
      // Resolve max_tokens according to priority:
      // 1) request.max_tokens (number > 0) or request.maxTokens (camelCase)
      // 2) provider overrides (config.config.overrides.maxTokens) if provided and > 0
      // 3) default 8192
      try {
        const reqMt = Number((dataObj as any)?.max_tokens ?? (dataObj as any)?.maxTokens ?? NaN);
        const cfgMt = Number((this.config as any)?.config?.overrides?.maxTokens ?? NaN);
        const envMt = Number(process.env.ROUTECODEX_DEFAULT_MAX_TOKENS || process.env.RCC_DEFAULT_MAX_TOKENS || NaN);
        const fallback = Number.isFinite(cfgMt) && cfgMt > 0
          ? cfgMt
          : (Number.isFinite(envMt) && envMt > 0 ? envMt : 8192);
        const effective = Number.isFinite(reqMt) && reqMt > 0 ? reqMt : fallback;
        // 写入 snake_case，兼容 OpenAI/Anthropic 端点
        (body as any).max_tokens = effective;
        // 删除 camelCase 以避免上游拒绝
        if ('maxTokens' in body) delete (body as any).maxTokens;
      } catch { /* ignore max_tokens resolution errors */ }
      // Remove metadata/envelope fields that upstream doesn't accept
      try { if ('metadata' in body) { delete body.metadata; } } catch { /* ignore */ }
      // Provider 不再按入口端点做流控或形状处理；上层已统一非流式
      return body;
    })();

    // 快照：provider-request（默认开启，脱敏headers）
    try {
      await writeProviderSnapshot({
        phase: 'provider-request',
        requestId: context.requestId,
        data: finalBody,
        headers,
        url: targetUrl
      });
    } catch { /* non-blocking */ }

    // 发送HTTP请求（统一非流式）
    let response: unknown;
    try {
      response = await this.httpClient.post(endpoint, finalBody, headers);
      // 快照：provider-response
      try {
        await writeProviderSnapshot({
          phase: 'provider-response',
          requestId: context.requestId,
          data: response,
          headers,
          url: targetUrl
        });
      } catch { /* non-blocking */ }
    } catch (error) {
      // 🔍 Hook 9: 错误处理阶段
      const errorResult = await hookManager.executeHookChain(
        'error_handling',
        'error',
        { error, request: processedRequest, url: targetUrl, headers },
        context
      );

      // 如果Hook处理了错误，使用Hook的返回结果
      if (errorResult.data && (errorResult.data as any).error === false) {
        return errorResult.data;
      }

      // 快照：provider-error（记录最小诊断信息）
      try {
        await writeProviderSnapshot({
          phase: 'provider-error',
          requestId: context.requestId,
          data: {
            message: error instanceof Error ? error.message : String(error)
          },
          headers,
          url: targetUrl
        });
      } catch { /* non-blocking */ }

      throw error;
    }

    // Provider 不处理工具修复/注入逻辑：统一收敛到 llmswitch-core 与兼容层
    // 此处不做任何自动修复/重试，保持单次请求的幂等与可观测性
    try { /* no-op */ } catch { /* ignore */ }

    return response;
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

  // 私有方法
  private validateConfig(): void {
    const profile = this.serviceProfile;
    const auth = this.config.config.auth;

    // 验证认证类型
    const supportedAuthTypes = [...profile.requiredAuth, ...profile.optionalAuth];
    if (!supportedAuthTypes.includes(auth.type)) {
      throw new Error(
        `Auth type '${auth.type}' not supported for provider '${this.providerType}'. ` +
        `Supported types: ${supportedAuthTypes.join(', ')}`
      );
    }
  }

  private buildRequestUrl(): string {
    const baseUrl = this.getEffectiveBaseUrl();
    const endpoint = this.getEffectiveEndpoint();
    return `${baseUrl}${endpoint}`;
  }

  private async buildRequestHeaders(): Promise<Record<string, string>> {
    const baseHeaders: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    // 服务特定头部
    const serviceHeaders = this.serviceProfile.headers || {};

    // 配置覆盖头部
    const overrideHeaders = this.config.config.overrides?.headers || {};

    // 认证头部
    const authHeaders = this.authProvider?.buildHeaders() || {};

    let finalHeaders: Record<string, string> = {
      ...baseHeaders,
      ...serviceHeaders,
      ...overrideHeaders,
      ...authHeaders
    };

    // 禁用上游SSE：设置 Accept 为 application/json（若未被显式覆盖）
    if (!('Accept' in finalHeaders) && !('accept' in finalHeaders)) {
      finalHeaders['Accept'] = 'application/json';
    }

    // 获取Hook管理器（新的统一系统）
    const hookManager = this.hookSystemIntegration.getBidirectionalHookManager() as any;

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

  private getEffectiveBaseUrl(): string {
    return (
      this.config.config.overrides?.baseUrl ||
      this.config.config.baseUrl ||
      this.serviceProfile.defaultBaseUrl
    );
  }

  private getEffectiveEndpoint(): string {
    return (
      this.config.config.overrides?.endpoint ||
      this.serviceProfile.defaultEndpoint
    );
  }

  // （工具自动修复辅助函数已删除）

  private createProviderContext(): ProviderContext {
    return {
      requestId: `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      providerType: this.providerType as ProviderType,
      startTime: Date.now(),
      profile: this.serviceProfile
    };
  }
}
