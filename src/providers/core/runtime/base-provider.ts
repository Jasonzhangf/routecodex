/**
 * Base Provider - 基础Provider抽象类
 *
 * 提供Provider的通用实现和抽象方法定义
 */

import type {
  IProviderV2,
  ProviderContext,
  ProviderError,
  ServiceProfile,
  ProviderRuntimeProfile
} from '../api/provider-types.js';
import type { IAuthProvider } from '../../auth/auth-interface.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { UnknownObject } from '../../../types/common-types.js';
import {
  attachProviderRuntimeMetadata,
  extractProviderRuntimeMetadata,
  type ProviderRuntimeMetadata
} from './provider-runtime-metadata.js';
import {
  emitProviderError,
  buildRuntimeFromProviderContext
} from '../utils/provider-error-reporter.js';
import {
  normalizeProviderFamily,
  normalizeProviderType,
  providerTypeToProtocol
} from '../utils/provider-type-utils.js';

type RequestEnvelope = UnknownObject & { data?: UnknownObject };

type ProviderErrorAugmented = ProviderError & {
  code?: string;
  retryable?: boolean;
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

/**
 * 基础Provider抽象类
 *
 * 为所有Provider实现提供通用逻辑和抽象方法定义
 */
export abstract class BaseProvider implements IProviderV2 {
  readonly id: string;
  readonly abstract type: string;
  readonly providerType: string;
  readonly config: OpenAIStandardConfig;

  protected dependencies: ModuleDependencies;
  protected isInitialized = false;
  protected requestCount = 0;
  protected errorCount = 0;
  protected lastActivity: number = Date.now();
  private lastRuntimeMetadata?: ProviderRuntimeMetadata;
  private runtimeProfile?: ProviderRuntimeProfile;
  private static rateLimitFailures: Map<string, number> = new Map();
  private static readonly RATE_LIMIT_THRESHOLD = 4;

  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    this.id = `provider-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.config = config;
    this.providerType = config.config.providerType;
    this.dependencies = dependencies;
  }

  public setRuntimeProfile(runtime: ProviderRuntimeProfile): void {
    this.runtimeProfile = runtime;
  }

  protected getRuntimeProfile(): ProviderRuntimeProfile | undefined {
    return this.runtimeProfile;
  }

  // 抽象方法 - 子类必须实现
  protected abstract getServiceProfile(): ServiceProfile;
  protected abstract createAuthProvider(): IAuthProvider;
  protected abstract preprocessRequest(request: UnknownObject): UnknownObject | Promise<UnknownObject>;
  protected abstract postprocessResponse(response: unknown, context: ProviderContext): UnknownObject | Promise<UnknownObject>;

  // 通用实现方法
  async initialize(): Promise<void> {
    try {
      this.dependencies.logger?.logModule(this.id, 'initialization-start');

      // 子类可以重写此方法进行初始化
      await this.onInitialize();

      this.isInitialized = true;
      this.lastActivity = Date.now();

      this.dependencies.logger?.logModule(this.id, 'initialization-complete', {
        providerType: this.providerType
      });
    } catch (error) {
      this.dependencies.logger?.logModule(this.id, 'initialization-error', { error });
      throw error;
    }
  }

  async processIncoming(request: UnknownObject): Promise<UnknownObject> {
    if (!this.isInitialized) {
      throw new Error('Provider is not initialized');
    }

    const context = this.createContext(request);
    const runtimeMetadata = context.runtimeMetadata;

    try {
      this.requestCount++;
      this.lastActivity = Date.now();

      this.dependencies.logger?.logProviderRequest(this.id, 'request-start', {
        providerType: this.providerType,
        requestId: context.requestId,
        model: context.model
      });

      // 预处理请求
      const processedRequest = await this.preprocessRequest(request);
      this.reattachRuntimeMetadata(processedRequest, runtimeMetadata);

      // 发送请求 (子类实现)
      const response = await this.sendRequest(processedRequest);

      // 后处理响应
      const finalResponse = await this.postprocessResponse(response, context);

      this.dependencies.logger?.logProviderRequest(this.id, 'request-success', {
        requestId: context.requestId,
        responseTime: Date.now() - context.startTime
      });
      this.resetRateLimitCounter(context.providerKey);

      return finalResponse;

    } catch (error) {
      this.errorCount++;
      this.handleRequestError(error, context);
      throw error;
    }
  }

  async processOutgoing(response: UnknownObject): Promise<UnknownObject> {
    return response;
  }

  // 实现ProviderModule接口要求的公共sendRequest方法
  async sendRequest(request: unknown): Promise<unknown> {
    if (!this.isInitialized) {
      throw new Error('Provider is not initialized');
    }

    const context = this.createContext(request as UnknownObject);
    const runtimeMetadata = context.runtimeMetadata;

    try {
      this.requestCount++;
      this.lastActivity = Date.now();

      // 预处理请求
      const processedRequest = await this.preprocessRequest(request as UnknownObject);
      this.reattachRuntimeMetadata(processedRequest, runtimeMetadata);

      // 发送请求 (子类实现)
      const response = await this.sendRequestInternal(processedRequest);

      // 后处理响应
      const finalResponse = await this.postprocessResponse(response, context);

      this.resetRateLimitCounter(context.providerKey);

      return finalResponse;
    } catch (error) {
      this.errorCount++;
      this.handleRequestError(error, context);
      throw error;
    }
  }

  async checkHealth(): Promise<boolean> {
    try {
      const profile = this.getServiceProfile();
      const url = `${profile.defaultBaseUrl}/models`;

      // 子类可以重写健康检查逻辑
      return await this.performHealthCheck(url);
    } catch (error) {
      this.dependencies.logger?.logModule(this.id, 'health-check-error', { error });
      return false;
    }
  }

  async cleanup(): Promise<void> {
    try {
      this.isInitialized = false;

      // 子类可以重写清理逻辑
      await this.onCleanup();

      this.dependencies.logger?.logModule(this.id, 'cleanup-complete');
    } catch (error) {
      this.dependencies.logger?.logModule(this.id, 'cleanup-error', { error });
      throw error;
    }
  }

  // 获取Provider状态
  getStatus(): {
    id: string;
    type: string;
    providerType: string;
    isInitialized: boolean;
    requestCount: number;
    errorCount: number;
    lastActivity: number;
  } {
    return {
      id: this.id,
      type: this.type,
      providerType: this.providerType,
      isInitialized: this.isInitialized,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      lastActivity: this.lastActivity
    };
  }

  // 受保护的模板方法 - 子类可以重写
  protected async onInitialize(): Promise<void> {
    // 默认实现为空，子类可以重写
  }

  protected async onCleanup(): Promise<void> {
    // 默认实现为空，子类可以重写
  }

  protected abstract sendRequestInternal(request: UnknownObject): Promise<unknown>;

  protected async performHealthCheck(_url: string): Promise<boolean> {
    // 默认健康检查实现
    return true; // 子类可以重写
  }

  // 私有辅助方法
  protected getCurrentRuntimeMetadata(): ProviderRuntimeMetadata | undefined {
    return this.lastRuntimeMetadata;
  }

  private createContext(request: UnknownObject): ProviderContext {
    const runtimeMetadata = extractProviderRuntimeMetadata(request);
    this.lastRuntimeMetadata = runtimeMetadata;
    const runtimeProfile = this.getRuntimeProfile();
    const payload = this.unwrapRequestPayload(request);
    const runtimeModel = typeof runtimeMetadata?.target?.model === 'string'
      ? runtimeMetadata.target.model
      : undefined;
    const payloadModel = typeof payload.model === 'string' ? payload.model : undefined;
    const providerType = normalizeProviderType(
      runtimeMetadata?.providerType ||
      runtimeProfile?.providerType ||
      this.providerType
    );
    const providerFamily = normalizeProviderFamily(
      runtimeMetadata?.providerFamily,
      runtimeMetadata?.providerId,
      runtimeMetadata?.providerKey,
      runtimeProfile?.providerFamily,
      runtimeProfile?.providerId,
      this.config.config.providerId,
      this.config.config.providerType
    );
    const providerProtocol =
      runtimeMetadata?.providerProtocol ||
      providerTypeToProtocol(providerType);
    const context: ProviderContext = {
      requestId: runtimeMetadata?.requestId || `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      providerType,
      providerFamily,
      startTime: Date.now(),
      model: payloadModel ?? runtimeModel,
      hasTools: this.hasTools(payload),
      metadata: runtimeMetadata?.metadata || {},
      providerId: runtimeMetadata?.providerId || runtimeMetadata?.providerKey || runtimeProfile?.providerId,
      providerKey: runtimeMetadata?.providerKey || runtimeProfile?.providerKey,
      providerProtocol,
      routeName: runtimeMetadata?.routeName,
      target: runtimeMetadata?.target,
      runtimeMetadata,
      pipelineId: runtimeMetadata?.pipelineId
    };
    return context;
  }

  private reattachRuntimeMetadata(payload: UnknownObject, metadata?: ProviderRuntimeMetadata): void {
    if (!metadata || !payload || typeof payload !== 'object') {
      return;
    }
    const target = this.hasDataEnvelope(payload) && payload.data && typeof payload.data === 'object'
      ? payload.data
      : payload;
    attachProviderRuntimeMetadata(target as Record<string, unknown>, metadata);
  }

  private handleRequestError(error: unknown, context: ProviderContext): void {
    const now = Date.now();
    const err: ProviderError = (error instanceof Error ? error : new Error(String(error))) as ProviderError;
    const msg = typeof err.message === 'string' ? err.message : String(error ?? 'unknown error');

    // 1) 提取状态码：优先 err.statusCode；否则从 message 中提取第一个 "HTTP <3xx>" 数字
    let statusCode: number | undefined = err.statusCode;
    if (!statusCode) {
      try {
        const m = msg.match(/HTTP\s+(\d{3})/i);
        if (m) {
          statusCode = parseInt(m[1], 10);
        }
      } catch { /* ignore */ }
    }
    const augmentedError = err as ProviderErrorAugmented;
    const upstream = augmentedError.response?.data;
    const upstreamCode = augmentedError.code || upstream?.error?.code;
    const upstreamMessage = upstream?.error?.message;
    const upstreamMessageLower = typeof upstreamMessage === 'string' ? upstreamMessage.toLowerCase() : '';

    const statusText = String(statusCode ?? '');
    const msgLower = msg.toLowerCase();
    const isNetworkError = !statusCode && looksLikeNetworkTransportError(augmentedError, msgLower);

    // 2) 429 限流：可恢复 + 连续 4 次熔断
    const isRateLimit = statusText.includes('429') || msgLower.includes('429');
    const isDailyLimit429 = isRateLimit && this.isDailyLimitRateLimit(msgLower, upstreamMessageLower);

    // 3) 可恢复池：目前仅 400、429
    const isClient400 = statusText.includes('400') || msgLower.includes('400');
    const isExplicitRecoverable = isRateLimit || isClient400;

    // 4) 不可恢复：401 / 402 / 500 / 524 以及所有不在可恢复池里的
    const is401 = statusText.includes('401') || msgLower.includes('401');
    const is402 = statusText.includes('402') || msgLower.includes('402');
    const is500 = statusText.includes('500') || msgLower.includes('500');
    const is524 = statusText.includes('524') || msgLower.includes('524');

    let recoverable = isExplicitRecoverable;
    if (isNetworkError) {
      recoverable = true;
    }
    if (is401 || is402 || is500 || is524) {
      recoverable = false;
    }
    const runtimeProfile = this.getRuntimeProfile();
    const providerKey = context.providerKey || runtimeProfile?.providerKey;

    // 5) 是否影响健康：除非可恢复，一律影响健康
    let affectsHealth = !recoverable;
    if (isRateLimit && recoverable) {
      // rate-limit 由熔断计数器决定是否升级为健康问题
      affectsHealth = false;
    }
    let forceFatalRateLimit = false;
    if (isRateLimit) {
      if (isDailyLimit429) {
        this.forceRateLimitFailure(providerKey);
      }
      const escalated = this.registerRateLimitFailure(providerKey);
      affectsHealth = escalated;
      forceFatalRateLimit = escalated;
      if (escalated) {
        recoverable = false;
      } else {
        recoverable = true;
      }
      if (isDailyLimit429) {
        affectsHealth = true;
        recoverable = false;
        forceFatalRateLimit = true;
      }
    } else if (providerKey) {
      this.resetRateLimitCounter(providerKey);
    }

    // 统一错误日志
    this.dependencies.logger?.logModule(this.id, 'request-error', {
      requestId: context.requestId,
      error: msg,
      statusCode,
      upstreamCode,
      upstreamMessage,
      providerType: context.providerType,
      providerFamily: context.providerFamily,
      providerId: context.providerId,
      providerProtocol: context.providerProtocol,
      providerKey: context.providerKey || runtimeProfile?.providerKey,
      runtimeKey: runtimeProfile?.runtimeKey,
      processingTime: now - context.startTime
    });

    const enrichedDetails = {
      providerId: this.id,
      providerKey,
      providerType: context.providerType,
      providerFamily: context.providerFamily,
      routeName: context.routeName,
      runtimeKey: runtimeProfile?.runtimeKey,
      upstreamCode,
      upstreamMessage,
      requestContext: context.runtimeMetadata,
      meta: augmentedError.details
    };
    const enrichedError = augmentedError;
    if (!enrichedError.requestId) {
      enrichedError.requestId = context.requestId;
    }
    enrichedError.providerKey = context.providerKey;
    enrichedError.providerId = context.providerId;
    enrichedError.providerType = context.providerType;
    enrichedError.providerFamily = context.providerFamily;
    enrichedError.routeName = context.routeName;
    enrichedError.details = {
      ...(enrichedError.details || {}),
      ...enrichedDetails,
      providerKey: enrichedDetails.providerKey,
      providerType: context.providerType,
      providerFamily: context.providerFamily,
      routeName: context.routeName,
      status: statusCode,
      requestId: context.requestId
    };

    emitProviderError({
      error: err,
      stage: 'provider.http',
      runtime: buildRuntimeFromProviderContext(context),
      dependencies: this.dependencies,
      statusCode,
      recoverable: forceFatalRateLimit ? false : recoverable,
      affectsHealth,
      details: enrichedDetails
    });
  }

  private unwrapRequestPayload(request: UnknownObject): Record<string, unknown> {
    if (this.hasDataEnvelope(request) && request.data && typeof request.data === 'object') {
      return request.data as Record<string, unknown>;
    }
    return request as Record<string, unknown>;
  }

  protected hasDataEnvelope(value: UnknownObject): value is RequestEnvelope {
    return Boolean(value && typeof value === 'object' && 'data' in value);
  }

  private hasTools(payload: Record<string, unknown>): boolean {
    const tools = payload['tools'];
    if (Array.isArray(tools)) {
      return tools.length > 0;
    }
    return Boolean(tools);
  }

  private registerRateLimitFailure(providerKey?: string): boolean {
    if (!providerKey) {
      return false;
    }
    const current = BaseProvider.rateLimitFailures.get(providerKey) ?? 0;
    const next = current + 1;
    BaseProvider.rateLimitFailures.set(providerKey, next);
    // 调试：记录当前 key 的第几次 429 命中，方便观察是否触发熔断
    if (this.dependencies.logger) {
      this.dependencies.logger.logModule(this.id, 'rate-limit-429', {
        providerKey,
        hitCount: next
      });
    }
    if (next >= BaseProvider.RATE_LIMIT_THRESHOLD) {
      BaseProvider.rateLimitFailures.set(providerKey, 0);
      return true;
    }
    return false;
  }

  private resetRateLimitCounter(providerKey?: string): void {
    if (!providerKey) {
      return;
    }
    BaseProvider.rateLimitFailures.delete(providerKey);
  }

  private forceRateLimitFailure(providerKey?: string): void {
    if (!providerKey) {
      return;
    }
    BaseProvider.rateLimitFailures.set(providerKey, BaseProvider.RATE_LIMIT_THRESHOLD);
  }

  private isDailyLimitRateLimit(messageLower: string, upstreamLower?: string): boolean {
    const haystack = `${messageLower} ${upstreamLower ?? ''}`;
    return (
      haystack.includes('daily cost limit') ||
      haystack.includes('daily quota') ||
      haystack.includes('quota has been exhausted') ||
      haystack.includes('quota exceeded') ||
      haystack.includes('费用限制') ||
      haystack.includes('每日费用限制')
    );
  }
}

const NETWORK_ERROR_CODE_SET = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNABORTED'
]);

function looksLikeNetworkTransportError(error: ProviderErrorAugmented, msgLower: string): boolean {
  const code = typeof error.code === 'string' ? error.code : undefined;
  if (code && NETWORK_ERROR_CODE_SET.has(code)) {
    return true;
  }
  const hints = [
    'fetch failed',
    'network timeout',
    'socket hang up',
    'client network socket disconnected',
    'tls handshake timeout',
    'unable to verify the first certificate',
    'network error',
    'temporarily unreachable'
  ];
  return hints.some((hint) => msgLower.includes(hint));
}
