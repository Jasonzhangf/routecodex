/**
 * Base Provider - 基础Provider抽象类
 *
 * 提供Provider的通用实现和抽象方法定义
 */

import type {
  IProviderV2,
  ProviderContext,
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
import { classifyProviderError } from './provider-error-classifier.js';
import type { ProviderErrorAugmented } from './provider-error-types.js';
import type { ProviderUsageEvent } from '@jsonstudio/llms';
import * as LlmsCore from '@jsonstudio/llms';
import { RateLimitBackoffManager, RateLimitCooldownError } from './rate-limit-manager.js';

type RequestEnvelope = UnknownObject & { data?: UnknownObject };
type StatsCenterLike = {
  recordProviderUsage(ev: ProviderUsageEvent): void;
};

function getStatsCenterSafe(): StatsCenterLike {
  const anyLlms = LlmsCore as unknown as {
    getStatsCenter?: () => StatsCenterLike | unknown;
  };
  try {
    if (anyLlms && typeof anyLlms.getStatsCenter === 'function') {
      const center = anyLlms.getStatsCenter();
      if (center && typeof (center as StatsCenterLike).recordProviderUsage === 'function') {
        return center as StatsCenterLike;
      }
    }
  } catch {
    // fall through to no-op
  }
  return {
    recordProviderUsage: () => {
      // stats center not available in this @jsonstudio/llms build
    }
  };
}

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
  protected authMode: 'apikey' | 'oauth' = 'apikey';
  protected oauthProviderId?: string;
  private lastRuntimeMetadata?: ProviderRuntimeMetadata;
  private runtimeProfile?: ProviderRuntimeProfile;
  private static rateLimitFailures: Map<string, number> = new Map();
  private static readonly RATE_LIMIT_THRESHOLD = 4;
  private static readonly rateLimitBackoff = new RateLimitBackoffManager();

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

      const endTime = Date.now();
      this.dependencies.logger?.logProviderRequest(this.id, 'request-success', {
        requestId: context.requestId,
        responseTime: endTime - context.startTime
      });
      this.resetRateLimitCounter(context.providerKey);

      return finalResponse;

    } catch (error) {
      this.errorCount++;
      if (error instanceof RateLimitCooldownError) {
        this.dependencies.logger?.logModule(this.id, 'rate-limit-skip', {
          providerKey: context.providerKey,
          model: context.model,
          message: error.message
        });
      }
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
    this.enforceRateLimitWindow(context);
    const runtimeMetadata = context.runtimeMetadata;
    const stats = getStatsCenterSafe();

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

      const endTime = Date.now();
      this.resetRateLimitCounter(context.providerKey, context.model);
      try {
        const usage = this.extractUsageTokensFromResponse(finalResponse);
        const event: ProviderUsageEvent = {
          requestId: context.requestId,
          timestamp: endTime,
          providerKey: context.providerKey || runtimeMetadata?.providerKey || this.getRuntimeProfile()?.providerKey || this.providerType,
          runtimeKey: this.getRuntimeProfile()?.runtimeKey,
          providerType: context.providerType,
          modelId: context.model,
          routeName: context.routeName,
          entryEndpoint: typeof context.metadata?.entryEndpoint === 'string' ? context.metadata.entryEndpoint : undefined,
          success: true,
          latencyMs: endTime - context.startTime,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens
        };
        stats.recordProviderUsage(event);
      } catch {
        // ignore stats errors
      }

      return finalResponse;
    } catch (error) {
      this.errorCount++;
      if (error instanceof RateLimitCooldownError) {
        this.dependencies.logger?.logModule(this.id, 'rate-limit-skip', {
          providerKey: context.providerKey,
          model: context.model,
          message: error.message
        });
      }
      const endTime = Date.now();
      try {
        const event: ProviderUsageEvent = {
          requestId: context.requestId,
          timestamp: endTime,
          providerKey: context.providerKey || runtimeMetadata?.providerKey || this.getRuntimeProfile()?.providerKey || this.providerType,
          runtimeKey: this.getRuntimeProfile()?.runtimeKey,
          providerType: context.providerType,
          modelId: context.model,
          routeName: context.routeName,
          entryEndpoint: typeof context.metadata?.entryEndpoint === 'string' ? context.metadata.entryEndpoint : undefined,
          success: false,
          latencyMs: endTime - context.startTime
        };
        stats.recordProviderUsage(event);
      } catch {
        // ignore stats errors
      }
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

  private extractUsageTokensFromResponse(finalResponse: UnknownObject): {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  } {
    if (!finalResponse || typeof finalResponse !== 'object') {
      return {};
    }
    const container = finalResponse as { metadata?: unknown; usage?: unknown };
    const meta = (container.metadata && typeof container.metadata === 'object')
      ? (container.metadata as { usage?: unknown })
      : undefined;
    const usageNode = meta && meta.usage && typeof meta.usage === 'object'
      ? meta.usage as Record<string, unknown>
      : (container.usage && typeof container.usage === 'object'
        ? container.usage as Record<string, unknown>
        : undefined);

    if (!usageNode) {
      return {};
    }

    const readNumber = (value: unknown): number | undefined => {
      if (typeof value !== 'number') {
        return undefined;
      }
      if (!Number.isFinite(value)) {
        return undefined;
      }
      return value;
    };

    const promptTokens =
      readNumber(usageNode.prompt_tokens) ??
      readNumber(usageNode.promptTokens) ??
      readNumber(usageNode.input_tokens) ??
      readNumber(usageNode.inputTokens);

    const completionTokens =
      readNumber(usageNode.completion_tokens) ??
      readNumber(usageNode.completionTokens) ??
      readNumber(usageNode.output_tokens) ??
      readNumber(usageNode.outputTokens);

    let totalTokens =
      readNumber(usageNode.total_tokens) ??
      readNumber(usageNode.totalTokens);

    if (totalTokens === undefined && (promptTokens !== undefined || completionTokens !== undefined)) {
      totalTokens = (promptTokens ?? 0) + (completionTokens ?? 0);
    }

    return { promptTokens, completionTokens, totalTokens };
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
    const runtimeProfile = this.getRuntimeProfile();
    const classification = classifyProviderError({
      error,
      context,
      detectDailyLimit: (messageLower, upstreamLower) => this.isDailyLimitRateLimit(messageLower, upstreamLower),
      registerRateLimitFailure: this.registerRateLimitFailure.bind(this),
      forceRateLimitFailure: this.forceRateLimitFailure.bind(this),
      authMode: this.authMode
    });
    const augmentedError = classification.error;
    const msg = classification.message;
    const statusCode = classification.statusCode;
    const upstreamCode = classification.upstreamCode;
    const upstreamMessage = classification.upstreamMessage;
    const providerKey = context.providerKey || runtimeProfile?.providerKey;

    if (!classification.isRateLimit && providerKey) {
      this.resetRateLimitCounter(providerKey, context.model);
    }

    if (classification.isRateLimit && providerKey) {
      const backoffInfo = BaseProvider.rateLimitBackoff.record429(providerKey, context.model);
      this.dependencies.logger?.logModule(this.id, 'rate-limit-429-backoff', {
        providerKey,
        model: context.model,
        consecutive429: backoffInfo.consecutive,
        cooldownMs: backoffInfo.cooldownMs,
        seriesBlacklisted: backoffInfo.seriesBlacklisted
      });
    }

    const affectsHealth = classification.affectsHealth;
    const recoverable = classification.forceFatalRateLimit ? false : classification.recoverable;

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
      providerKey: providerKey,
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
    if (!augmentedError.requestId) {
      augmentedError.requestId = context.requestId;
    }
    augmentedError.providerKey = context.providerKey;
    augmentedError.providerId = context.providerId;
    augmentedError.providerType = context.providerType;
    augmentedError.providerFamily = context.providerFamily;
    augmentedError.routeName = context.routeName;
    augmentedError.details = {
      ...(augmentedError.details || {}),
      ...enrichedDetails,
      providerKey: enrichedDetails.providerKey,
      providerType: context.providerType,
      providerFamily: context.providerFamily,
      routeName: context.routeName,
      status: statusCode,
      requestId: context.requestId
    };

    emitProviderError({
      error: augmentedError,
      stage: 'provider.http',
      runtime: buildRuntimeFromProviderContext(context),
      dependencies: this.dependencies,
      statusCode,
      recoverable,
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

  private enforceRateLimitWindow(context: ProviderContext): void {
    const cooldownError = BaseProvider.rateLimitBackoff.buildThrottleError(context);
    if (cooldownError) {
      throw cooldownError;
    }
  }

  private getRateLimitBucketKey(providerKey?: string, model?: string): string | undefined {
    if (!providerKey) {
      return undefined;
    }
    const runtimeProfile = this.getRuntimeProfile();
    const providerId = runtimeProfile?.providerId || this.config.config.providerId;
    if (providerId === 'antigravity' && model) {
      return `${providerKey}::${model}`;
    }
    return providerKey;
  }

  private registerRateLimitFailure(providerKey?: string, model?: string): boolean {
    const bucketKey = this.getRateLimitBucketKey(providerKey, model);
    if (!bucketKey) {
      return false;
    }
    const current = BaseProvider.rateLimitFailures.get(bucketKey) ?? 0;
    const next = current + 1;
    BaseProvider.rateLimitFailures.set(bucketKey, next);
    // 调试：记录当前 key 的第几次 429 命中，方便观察是否触发熔断
    if (this.dependencies.logger) {
      this.dependencies.logger.logModule(this.id, 'rate-limit-429', {
        providerKey: bucketKey,
        hitCount: next
      });
    }
    if (next >= BaseProvider.RATE_LIMIT_THRESHOLD) {
      BaseProvider.rateLimitFailures.set(bucketKey, 0);
      return true;
    }
    return false;
  }

  private resetRateLimitCounter(providerKey?: string, model?: string): void {
    const bucketKey = this.getRateLimitBucketKey(providerKey, model);
    if (!bucketKey) {
      return;
    }
    BaseProvider.rateLimitFailures.delete(bucketKey);
    BaseProvider.rateLimitBackoff.reset(providerKey, model);
  }

  private forceRateLimitFailure(providerKey?: string, model?: string): void {
    const bucketKey = this.getRateLimitBucketKey(providerKey, model);
    if (!bucketKey) {
      return;
    }
    BaseProvider.rateLimitFailures.set(bucketKey, BaseProvider.RATE_LIMIT_THRESHOLD);
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
