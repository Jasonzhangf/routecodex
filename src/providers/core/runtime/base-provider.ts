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
import { getStatsCenterSafe as getStatsCenterSafeFromBridge } from '../../../modules/llmswitch/bridge.js';
import type { ProviderUsageEvent } from '../../../modules/llmswitch/bridge.js';
import { RateLimitCooldownError } from './rate-limit-manager.js';

type RequestEnvelope = UnknownObject & { data?: UnknownObject };
type StatsCenterLike = {
  recordProviderUsage(ev: ProviderUsageEvent): void;
};

const SERIES_COOLDOWN_DETAIL_KEY = 'virtualRouterSeriesCooldown' as const;
const SERIES_COOLDOWN_PROVIDER_IDS = new Set(['antigravity', 'gemini-cli']);
const SERIES_COOLDOWN_MAX_MS = 3 * 60 * 60_000;
type ModelSeriesName = 'claude' | 'gemini-pro' | 'gemini-flash' | 'default';
type SeriesCooldownDetail = {
  scope: 'model-series';
  providerId: string;
  providerKey?: string;
  model?: string;
  series: Exclude<ModelSeriesName, 'default'>;
  cooldownMs: number;
  quotaResetDelay?: string;
  source?: string;
  expiresAt?: number;
};
type QuotaDelayExtraction = {
  delay: string;
  source: 'quota_reset_delay' | 'quota_exhausted_fallback' | 'capacity_exhausted_fallback';
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
  protected authMode: 'apikey' | 'oauth' = 'apikey';
  protected oauthProviderId?: string;
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
  protected abstract postprocessResponse(response: unknown, _context: ProviderContext): UnknownObject | Promise<UnknownObject>;

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

  private handleRequestError(error: unknown, _context: ProviderContext): void {
    const now = Date.now();
    const runtimeProfile = this.getRuntimeProfile();
    const classification = classifyProviderError({
      error,
      context: _context,
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
    const providerKey = _context.providerKey || runtimeProfile?.providerKey;

    if (!classification.isRateLimit && providerKey) {
      this.resetRateLimitCounter(providerKey, _context.model);
    }

    let seriesCooldownDetail: SeriesCooldownDetail | null = null;
    if (classification.isRateLimit && providerKey) {
      // 仅负责从上游错误中提取配额冷却信息，并通过 virtualRouterSeriesCooldown
      // 提供给 llmswitch-core 的 VirtualRouter。具体的 alias / series 冷却与重路由
      // 逻辑完全由 VirtualRouterEngine 处理，Provider 层不再维护独立的 backoff 状态。
      seriesCooldownDetail = BaseProvider.buildSeriesCooldownDetail(
        augmentedError,
        _context,
        runtimeProfile,
        providerKey
      );
    }

    const affectsHealth = classification.affectsHealth;
    const recoverable = classification.forceFatalRateLimit ? false : classification.recoverable;

    const logErrorMessage = typeof msg === 'string' ? this.truncateLogMessage(msg) : msg;
    const logUpstreamMessage =
      typeof upstreamMessage === 'string' ? this.truncateLogMessage(upstreamMessage) : upstreamMessage;

    this.dependencies.logger?.logModule(this.id, 'request-error', {
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

  private enforceRateLimitWindow(_context: ProviderContext): void {
    // 冷却窗口治理收敛到 llmswitch-core VirtualRouter。
    // Provider 层不在此处主动拦截请求，避免与 VirtualRouter 的健康状态重复。
  }

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
  }

  private forceRateLimitFailure(providerKey?: string, model?: string): void {
    const bucketKey = this.getRateLimitBucketKey(providerKey, model);
    if (!bucketKey) {
      return;
    }
    BaseProvider.rateLimitFailures.set(bucketKey, BaseProvider.RATE_LIMIT_THRESHOLD);
  }

  private static buildSeriesCooldownDetail(
    error: ProviderErrorAugmented,
    _context: ProviderContext,
    runtimeProfile?: ProviderRuntimeProfile,
    providerKey?: string
  ): SeriesCooldownDetail | null {
    const normalizedProviderId = BaseProvider.normalizeSeriesProviderId(
      runtimeProfile?.providerId || _context.providerId,
      providerKey
    );
    if (!normalizedProviderId) {
      return null;
    }
    const topLevelId = BaseProvider.extractTopLevelProviderId(normalizedProviderId);
    if (!topLevelId || !SERIES_COOLDOWN_PROVIDER_IDS.has(topLevelId.toLowerCase())) {
      return null;
    }
    const extracted = BaseProvider.extractQuotaResetDelayWithSource(error);
    if (!extracted) {
      return null;
    }
    const rawDelay = extracted.delay;
    const cooldownMs = BaseProvider.parseDurationToMs(rawDelay);
    if (!cooldownMs || cooldownMs <= 0) {
      return null;
    }
    const cappedCooldownMs = Math.min(cooldownMs, SERIES_COOLDOWN_MAX_MS);
    const modelId = BaseProvider.resolveContextModel(_context, runtimeProfile, providerKey);
    const series = BaseProvider.resolveModelSeries(modelId);
    if (!modelId || series === 'default') {
      return null;
    }
    return {
      scope: 'model-series',
      providerId: normalizedProviderId,
      providerKey,
      model: modelId,
      series,
      cooldownMs: cappedCooldownMs,
      quotaResetDelay: rawDelay,
      source: extracted.source,
      expiresAt: Date.now() + cappedCooldownMs
    };
  }

  private static extractQuotaResetDelayWithSource(error: ProviderErrorAugmented): QuotaDelayExtraction | null {
    if (!error) {
      return null;
    }
    const response = error.response as { data?: unknown } | undefined;
    const textSources: string[] = [];
    const objectSources: Record<string, unknown>[] = [];
    const rawData = response?.data;
    const dataNode = BaseProvider.normalizeObjectCandidate(rawData);
    if (dataNode) {
      objectSources.push(dataNode);
      const errBlock = BaseProvider.normalizeObjectCandidate((dataNode as { error?: unknown })?.error);
      if (errBlock) {
        objectSources.push(errBlock);
        const details = (errBlock as { details?: unknown })?.details;
        if (Array.isArray(details)) {
          for (const detail of details) {
            const normalizedDetail = BaseProvider.normalizeObjectCandidate(detail);
            if (normalizedDetail) {
              objectSources.push(normalizedDetail);
            }
          }
        }
        const errMessage = (errBlock as { message?: unknown })?.message;
        if (typeof errMessage === 'string') {
          textSources.push(errMessage);
        }
      }
    } else if (typeof rawData === 'string') {
      textSources.push(rawData);
    }
    if (error && typeof error === 'object') {
      objectSources.push(error as unknown as Record<string, unknown>);
    }
    if (typeof error.message === 'string') {
      textSources.push(error.message);
    }
    const upstreamMessage = (error as { upstreamMessage?: string }).upstreamMessage;
    if (typeof upstreamMessage === 'string') {
      textSources.push(upstreamMessage);
    }
    for (const source of objectSources) {
      const candidate = BaseProvider.extractQuotaDelayFromObject(source);
      if (candidate) {
        return { delay: candidate, source: 'quota_reset_delay' };
      }
    }
    for (const text of textSources) {
      const candidate = BaseProvider.extractQuotaDelayFromString(text);
      if (candidate) {
        return { delay: candidate, source: 'quota_reset_delay' };
      }
    }
    // 若未在结构化字段中发现 quotaResetDelay / quotaResetTimeStamp，
    // 则根据常见文案模式做一次保守的回退解析，给出一个近似的冷却窗口，
    // 以便 VirtualRouter 至少可以对整条系列做一次降温，而不是在明显「额度耗尽」
    // 的情况下持续命中上游 429。
    const fallback = BaseProvider.extractFallbackQuotaDelayFromTexts(textSources);
    if (fallback) {
      return fallback;
    }
    return null;
  }

  private static extractQuotaDelayFromObject(source: unknown): string | undefined {
    if (!source || typeof source !== 'object') {
      return undefined;
    }
    const record = source as Record<string, unknown>;
    const directDelay = record.quotaResetDelay;
    if (typeof directDelay === 'string' && directDelay.trim().length) {
      return directDelay.trim();
    }
    const metadata = record.metadata;
    if (metadata && typeof metadata === 'object') {
      const metaDelay = (metadata as Record<string, unknown>).quotaResetDelay;
      if (typeof metaDelay === 'string' && metaDelay.trim().length) {
        return metaDelay.trim();
      }
      const metaResetTs = (metadata as Record<string, unknown>).quotaResetTimeStamp;
      if (typeof metaResetTs === 'string' && metaResetTs.trim().length) {
        const ttlMs = BaseProvider.computeTtlFromTimestamp(metaResetTs.trim());
        if (ttlMs && ttlMs > 0) {
          return `${Math.round(ttlMs / 1000)}s`;
        }
      }
    }
    const directResetTs = record.quotaResetTimeStamp;
    if (typeof directResetTs === 'string' && directResetTs.trim().length) {
      const ttlMs = BaseProvider.computeTtlFromTimestamp(directResetTs.trim());
      if (ttlMs && ttlMs > 0) {
        return `${Math.round(ttlMs / 1000)}s`;
      }
    }
    return undefined;
  }

  private static computeTtlFromTimestamp(value?: string): number | null {
    if (!value || typeof value !== 'string') {
      return null;
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    const now = Date.now();
    const diff = parsed - now;
    if (!Number.isFinite(diff) || diff <= 0) {
      return null;
    }
    return Math.round(diff);
  }

  private static parseDurationToMs(value?: string): number | null {
    if (!value || typeof value !== 'string') {
      return null;
    }
    const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/gi;
    let totalMs = 0;
    let matched = false;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) !== null) {
      matched = true;
      const amount = Number.parseFloat(match[1]);
      if (!Number.isFinite(amount)) {
        continue;
      }
      const unit = match[2].toLowerCase();
      if (unit === 'ms') {
        totalMs += amount;
      } else if (unit === 'h') {
        totalMs += amount * 3_600_000;
      } else if (unit === 'm') {
        totalMs += amount * 60_000;
      } else if (unit === 's') {
        totalMs += amount * 1_000;
      }
    }
    if (!matched) {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds)) {
        totalMs = seconds * 1_000;
        matched = true;
      }
    }
    if (!matched || totalMs <= 0) {
      return null;
    }
    return Math.round(totalMs);
  }

  private static normalizeSeriesProviderId(providerId?: string, providerKey?: string): string | undefined {
    const aliasFromKey = BaseProvider.extractProviderAliasId(providerKey);
    if (aliasFromKey) {
      return aliasFromKey;
    }
    const aliasFromId = BaseProvider.extractProviderAliasId(providerId);
    if (aliasFromId) {
      return aliasFromId;
    }
    const topFromKey = BaseProvider.extractTopLevelProviderId(providerKey);
    if (topFromKey) {
      return topFromKey;
    }
    return BaseProvider.extractTopLevelProviderId(providerId);
  }

  private static normalizeObjectCandidate(value: unknown): Record<string, unknown> | null {
    if (!value) {
      return null;
    }
    if (typeof value === 'object') {
      return value as Record<string, unknown>;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
    return null;
  }

  private static extractQuotaDelayFromString(text: string): string | undefined {
    if (typeof text !== 'string' || !text) {
      return undefined;
    }
    const match = text.match(/quotaResetDelay["']?\s*[:=]\s*"([^"]+)"/i);
    if (match && match[1]) {
      const normalized = match[1].trim();
      return normalized.length ? normalized : undefined;
    }
    return undefined;
  }

  private static extractFallbackQuotaDelayFromTexts(texts: string[]): QuotaDelayExtraction | null {
    if (!Array.isArray(texts) || texts.length === 0) {
      return null;
    }
    const haystack = texts.join(' ').toLowerCase();
    if (!haystack) {
      return null;
    }

    // Antigravity / Gemini CLI: capacity exhausted (not quota depleted).
    // Example: "No capacity available for model ..." with reason "MODEL_CAPACITY_EXHAUSTED".
    // This is typically short-lived; apply a short series cooldown to avoid hammering every alias.
    if (
      haystack.includes('no capacity available') ||
      haystack.includes('model_capacity_exhausted') ||
      haystack.includes('model capacity exhausted')
    ) {
      const envValue =
        (process.env.ROUTECODEX_RL_CAPACITY_COOLDOWN || process.env.RCC_RL_CAPACITY_COOLDOWN || '').trim();
      return {
        delay: envValue.length ? envValue : '30s',
        source: 'capacity_exhausted_fallback'
      };
    }

    // 针对常见的「额度/余额耗尽」类 429 文案给出保守的冷却时间，
    // 用于 series 级别的降温，避免在明显 quota 用尽时持续命中上游：
    // - Gemini: "Resource has been exhausted (e.g. check quota)."
    // - 通用: "quota has been exhausted" / "quota exceeded"
    // - GLM: "余额不足或无可用资源包"
    if (
      haystack.includes('resource has been exhausted') ||
      haystack.includes('resource exhausted') ||
      haystack.includes('quota has been exhausted') ||
      haystack.includes('quota exceeded') ||
      haystack.includes('余额不足') ||
      haystack.includes('无可用资源包')
    ) {
      // 默认按 5 分钟冷却整条系列，具体 TTL 只作为「第一时间」的保护，
      // 真正的长周期拉黑/恢复由 daemon/QuotaManager 结合 VirtualRouter 健康状态统一管理。
      // 若存在 ROUTECODEX_RL_DEFAULT_QUOTA_COOLDOWN / RCC_RL_DEFAULT_QUOTA_COOLDOWN，
      // 则优先采用该环境变量，支持按部署环境调节冷却窗口（例如 1m / 30m / 2h）。
      const envValue =
        (process.env.ROUTECODEX_RL_DEFAULT_QUOTA_COOLDOWN || process.env.RCC_RL_DEFAULT_QUOTA_COOLDOWN || '').trim();
      return {
        delay: envValue.length ? envValue : '5m',
        source: 'quota_exhausted_fallback'
      };
    }

    return null;
  }

  private static extractTopLevelProviderId(source?: string): string | undefined {
    if (!source || typeof source !== 'string') {
      return undefined;
    }
    const trimmed = source.trim();
    if (!trimmed) {
      return undefined;
    }
    const firstDot = trimmed.indexOf('.');
    if (firstDot <= 0) {
      return trimmed;
    }
    return trimmed.slice(0, firstDot);
  }

  private static extractProviderAliasId(source?: string): string | undefined {
    if (!source || typeof source !== 'string') {
      return undefined;
    }
    const trimmed = source.trim();
    if (!trimmed) {
      return undefined;
    }
    const segments = trimmed.split('.');
    if (segments.length >= 2 && segments[0] && segments[1]) {
      return `${segments[0]}.${segments[1]}`;
    }
    return undefined;
  }

  private static resolveContextModel(
    _context: ProviderContext,
    runtimeProfile?: ProviderRuntimeProfile,
    providerKey?: string
  ): string | undefined {
    if (typeof _context.model === 'string' && _context.model.trim().length) {
      return _context.model.trim();
    }
    const target = _context.target;
    if (target && typeof target === 'object') {
      const candidate =
        (target as { clientModelId?: string }).clientModelId ||
        (target as { modelId?: string }).modelId;
      if (typeof candidate === 'string' && candidate.trim().length) {
        return candidate.trim();
      }
    }
    if (runtimeProfile?.defaultModel && runtimeProfile.defaultModel.trim().length) {
      return runtimeProfile.defaultModel.trim();
    }
    if (providerKey) {
      return BaseProvider.deriveModelIdFromProviderKey(providerKey);
    }
    return undefined;
  }

  private static deriveModelIdFromProviderKey(providerKey?: string): string | undefined {
    if (!providerKey) {
      return undefined;
    }
    const firstDot = providerKey.indexOf('.');
    if (firstDot <= 0 || firstDot === providerKey.length - 1) {
      return undefined;
    }
    const remainder = providerKey.slice(firstDot + 1);
    const secondDot = remainder.indexOf('.');
    if (secondDot <= 0 || secondDot === remainder.length - 1) {
      const trimmed = remainder.trim();
      return trimmed || undefined;
    }
    const finalPart = remainder.slice(secondDot + 1).trim();
    return finalPart || undefined;
  }

  private static resolveModelSeries(model?: string): ModelSeriesName {
    if (!model) {
      return 'default';
    }
    const lower = model.toLowerCase();
    if (lower.includes('claude') || lower.includes('opus')) {
      return 'claude';
    }
    if (lower.includes('flash')) {
      return 'gemini-flash';
    }
    if (lower.includes('gemini') || lower.includes('pro')) {
      return 'gemini-pro';
    }
    return 'default';
  }

  private isDailyLimitRateLimit(messageLower: string, upstreamLower?: string): boolean {
    const haystack = `${messageLower} ${upstreamLower ?? ''}`;
    // Capacity exhausted != daily quota exhausted. Avoid marking it as a hard daily limit.
    if (
      haystack.includes('no capacity available') ||
      haystack.includes('model_capacity_exhausted') ||
      haystack.includes('model capacity exhausted')
    ) {
      return false;
    }
    return (
      haystack.includes('daily cost limit') ||
      haystack.includes('daily quota') ||
      haystack.includes('quota has been exhausted') ||
      haystack.includes('quota exceeded') ||
      haystack.includes('resource has been exhausted') ||
      haystack.includes('resource exhausted') ||
      haystack.includes('resource_exhausted') ||
      haystack.includes('费用限制') ||
      haystack.includes('每日费用限制') ||
      haystack.includes('余额不足') ||
      haystack.includes('无可用资源包')
    );
  }

  private truncateLogMessage(value: string, maxLength: number = 400): string {
    if (!value || value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, maxLength - 3)}...`;
  }
}
