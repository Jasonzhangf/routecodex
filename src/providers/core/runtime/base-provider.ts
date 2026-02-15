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
import type { ProviderRuntimeMetadata } from './provider-runtime-metadata.js';
import {
  emitProviderError,
  buildRuntimeFromProviderContext
} from '../utils/provider-error-reporter.js';
import { classifyProviderError } from './provider-error-classifier.js';
import { getStatsCenterSafe as getStatsCenterSafeFromBridge } from '../../../modules/llmswitch/bridge.js';
import type { ProviderUsageEvent } from '../../../modules/llmswitch/bridge.js';
import { RateLimitCooldownError } from './rate-limit-manager.js';
import {
  createProviderContext,
  extractUsageTokensFromResponse,
  hasDataEnvelope,
  reattachRuntimeMetadata,
  truncateLogMessage
} from './base-provider-runtime-helpers.js';
import {
  buildSeriesCooldownDetail,
  isDailyLimitRateLimitMessage,
  parseDurationToMs as parseSeriesCooldownDurationToMs,
  SERIES_COOLDOWN_DETAIL_KEY,
  type SeriesCooldownDetail
} from './base-provider-series-cooldown.js';

type StatsCenterLike = {
  recordProviderUsage(ev: ProviderUsageEvent): void;
};

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

  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    // Internal unique id; do not use it as a log prefix (it's not human-readable).
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

  protected getLogId(): string {
    const runtime = this.getRuntimeProfile();
    const runtimeKey =
      runtime && typeof runtime.runtimeKey === 'string' && runtime.runtimeKey.trim()
        ? runtime.runtimeKey.trim()
        : '';
    const providerId =
      runtime && typeof runtime.providerId === 'string' && runtime.providerId.trim()
        ? runtime.providerId.trim()
        : typeof this.config?.config?.providerId === 'string' && this.config.config.providerId.trim()
          ? this.config.config.providerId.trim()
          : '';
    if (runtimeKey) {
      return `provider:${runtimeKey}`;
    }
    if (providerId) {
      return `provider:${providerId}`;
    }
    return `provider:${this.providerType || 'unknown'}`;
  }

  // 抽象方法 - 子类必须实现
  protected abstract getServiceProfile(): ServiceProfile;
  protected abstract createAuthProvider(): IAuthProvider;
  protected abstract preprocessRequest(request: UnknownObject): UnknownObject | Promise<UnknownObject>;
  protected abstract postprocessResponse(response: unknown, _context: ProviderContext): UnknownObject | Promise<UnknownObject>;

  // 通用实现方法
  async initialize(): Promise<void> {
    try {
      const logId = this.getLogId();
      this.dependencies.logger?.logModule(logId, 'initialization-start');

      // 子类可以重写此方法进行初始化
      await this.onInitialize();

      this.isInitialized = true;
      this.lastActivity = Date.now();

      this.dependencies.logger?.logModule(logId, 'initialization-complete', {
        providerType: this.providerType
      });
    } catch (error) {
      this.dependencies.logger?.logModule(this.getLogId(), 'initialization-error', { error });
      throw error;
    }
  }

  async processIncoming(request: UnknownObject): Promise<UnknownObject> {
    if (!this.isInitialized) {
      throw new Error('Provider is not initialized');
    }

    const context = this.createContext(request);
    const runtimeMetadata = context.runtimeMetadata;

    this.requestCount++;
    this.lastActivity = Date.now();

    this.dependencies.logger?.logProviderRequest(this.getLogId(), 'request-start', {
      providerType: this.providerType,
      requestId: context.requestId,
      model: context.model
    });

    // 预处理请求
    const processedRequest = await this.preprocessRequest(request);
    reattachRuntimeMetadata(processedRequest, runtimeMetadata);

    // 发送请求 (子类实现)
    const response = await this.sendRequest(processedRequest);

    // 后处理响应
    const finalResponse = await this.postprocessResponse(response, context);

    const endTime = Date.now();
    this.dependencies.logger?.logProviderRequest(this.getLogId(), 'request-success', {
      requestId: context.requestId,
      responseTime: endTime - context.startTime
    });
    this.resetRateLimitCounter(context.providerKey);

    return finalResponse;
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
    const stats = getStatsCenterSafeFromBridge() as StatsCenterLike;

    try {
      this.requestCount++;
      this.lastActivity = Date.now();

      // 预处理请求
      const processedRequest = await this.preprocessRequest(request as UnknownObject);
      reattachRuntimeMetadata(processedRequest, runtimeMetadata);

      // 发送请求 (子类实现)
      const response = await this.sendRequestInternal(processedRequest);

      // 后处理响应
      const finalResponse = await this.postprocessResponse(response, context);

      const endTime = Date.now();
      this.resetRateLimitCounter(context.providerKey, context.model);
      try {
        const usage = extractUsageTokensFromResponse(finalResponse);
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
        this.dependencies.logger?.logModule(this.getLogId(), 'rate-limit-skip', {
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
      this.dependencies.logger?.logModule(this.getLogId(), 'health-check-error', { error });
      return false;
    }
  }

  async cleanup(): Promise<void> {
    try {
      this.isInitialized = false;

      // 子类可以重写清理逻辑
      await this.onCleanup();

      this.dependencies.logger?.logModule(this.getLogId(), 'cleanup-complete');
    } catch (error) {
      this.dependencies.logger?.logModule(this.getLogId(), 'cleanup-error', { error });
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
    const runtimeProfile = this.getRuntimeProfile();
    const { context, runtimeMetadata } = createProviderContext({
      request,
      providerType: this.providerType,
      runtimeProfile,
      configProviderId: this.config.config.providerId,
      configProviderType: this.config.config.providerType
    });
    this.lastRuntimeMetadata = runtimeMetadata;
    return context;
  }

  private handleRequestError(error: unknown, _context: ProviderContext): void {
    const now = Date.now();
    const runtimeProfile = this.getRuntimeProfile();
    const classification = classifyProviderError({
      error,
      context: _context,
      detectDailyLimit: (messageLower, upstreamLower) => isDailyLimitRateLimitMessage(messageLower, upstreamLower),
      registerRateLimitFailure: this.registerRateLimitFailure.bind(this),
      forceRateLimitFailure: this.forceRateLimitFailure.bind(this),
      authMode: this.authMode
    });
    const augmentedError = classification.error;
    const msg = classification.message;
    const statusCode = classification.statusCode;
    const upstreamCode = classification.upstreamCode;
    const upstreamMessage = classification.upstreamMessage;
    const providerKey = _context.providerKey || runtimeProfile?.providerKey;

    if (!classification.isRateLimit && providerKey) {
      this.resetRateLimitCounter(providerKey, _context.model);
    }

    let seriesCooldownDetail: SeriesCooldownDetail | null = null;
    if (classification.isRateLimit && providerKey) {
      // 仅负责从上游错误中提取配额冷却信息，并通过 virtualRouterSeriesCooldown
      // 提供给 llmswitch-core 的 VirtualRouter。具体的 alias / series 冷却与重路由
      // 逻辑完全由 VirtualRouterEngine 处理，Provider 层不再维护独立的 backoff 状态。
      seriesCooldownDetail = buildSeriesCooldownDetail(
        augmentedError,
        _context,
        runtimeProfile,
        providerKey
      );
    }

    const affectsHealth = classification.affectsHealth;
    const recoverable = classification.forceFatalRateLimit ? false : classification.recoverable;

    const logErrorMessage = typeof msg === 'string' ? truncateLogMessage(msg) : msg;
    const logUpstreamMessage =
      typeof upstreamMessage === 'string' ? truncateLogMessage(upstreamMessage) : upstreamMessage;

    this.dependencies.logger?.logModule(this.getLogId(), 'request-error', {
      requestId: _context.requestId,
      error: logErrorMessage,
      statusCode,
      upstreamCode,
      upstreamMessage: logUpstreamMessage,
      providerType: _context.providerType,
      providerFamily: _context.providerFamily,
      providerId: _context.providerId,
      providerProtocol: _context.providerProtocol,
      providerKey: providerKey,
      runtimeKey: runtimeProfile?.runtimeKey,
      processingTime: now - _context.startTime
    });

    const enrichedDetails = {
      providerId: this.id,
      providerKey,
      providerType: _context.providerType,
      providerFamily: _context.providerFamily,
      routeName: _context.routeName,
      runtimeKey: runtimeProfile?.runtimeKey,
      upstreamCode,
      upstreamMessage,
      requestContext: _context.runtimeMetadata,
      meta: augmentedError.details,
      ...(seriesCooldownDetail ? { [SERIES_COOLDOWN_DETAIL_KEY]: seriesCooldownDetail } : {})
    };
    if (!augmentedError.requestId) {
      augmentedError.requestId = _context.requestId;
    }
    augmentedError.providerKey = _context.providerKey;
    augmentedError.providerId = _context.providerId;
    augmentedError.providerType = _context.providerType;
    augmentedError.providerFamily = _context.providerFamily;
    augmentedError.routeName = _context.routeName;
    augmentedError.details = {
      ...(augmentedError.details || {}),
      ...enrichedDetails,
      providerKey: enrichedDetails.providerKey,
      providerType: _context.providerType,
      providerFamily: _context.providerFamily,
      routeName: _context.routeName,
      status: statusCode,
      requestId: _context.requestId
    };

    emitProviderError({
      error: augmentedError,
      stage: 'provider.http',
      runtime: buildRuntimeFromProviderContext(_context),
      dependencies: this.dependencies,
      statusCode,
      recoverable,
      affectsHealth,
      details: enrichedDetails
    });
  }

  private enforceRateLimitWindow(_context: ProviderContext): void {
    // 冷却窗口治理收敛到 llmswitch-core VirtualRouter。
    // Provider 层不在此处主动拦截请求，避免与 VirtualRouter 的健康状态重复。
  }

  protected hasDataEnvelope(value: UnknownObject): value is UnknownObject & { data?: UnknownObject } { return hasDataEnvelope(value); }

  private getRateLimitBucketKey(providerKey?: string, model?: string): string | undefined {
    if (!providerKey) {
      return undefined;
    }
    const runtimeProfile = this.getRuntimeProfile();
    const providerIdRaw = runtimeProfile?.providerId || this.config.config.providerId;
    const providerId = typeof providerIdRaw === 'string' ? providerIdRaw.trim().toLowerCase() : '';
    // 对 Gemini CLI 系列（gemini-cli / antigravity）按「providerKey+model」粒度计数，
    // 避免同一模型系列下所有 alias 被一次 429 牵连。
    if ((providerId === 'antigravity' ||
      providerId === 'gemini-cli' ||
      providerId.startsWith('antigravity.') ||
      providerId.startsWith('gemini-cli.')) && model) {
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
      this.dependencies.logger.logModule(this.getLogId(), 'rate-limit-429', {
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
  }

  private forceRateLimitFailure(providerKey?: string, model?: string): void {
    const bucketKey = this.getRateLimitBucketKey(providerKey, model);
    if (!bucketKey) {
      return;
    }
    BaseProvider.rateLimitFailures.set(bucketKey, BaseProvider.RATE_LIMIT_THRESHOLD);
  }

  // Kept for compatibility with existing tests/introspection helpers.
  private static parseDurationToMs(value?: string): number | null {
    return parseSeriesCooldownDurationToMs(value);
  }
}
