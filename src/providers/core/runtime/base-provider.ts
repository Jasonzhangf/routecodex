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
  emitProviderErrorAndWait,
  emitProviderSuccessAndWait,
  buildRuntimeFromProviderContext
} from '../utils/provider-error-reporter.js';
import { classifyProviderError } from './provider-error-classifier.js';
import { getStatsCenterSafe as getStatsCenterSafeFromBridge } from '../../../modules/llmswitch/bridge.js';
import type { ProviderUsageEvent } from '../../../modules/llmswitch/bridge.js';
import {
  createProviderContext,
  extractUsageTokensFromResponse,
  hasDataEnvelope,
  reattachRuntimeMetadata,
  truncateLogMessage
} from './base-provider-runtime-helpers.js';

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
  private lastRuntimeMetadata?: ProviderRuntimeMetadata;
  private runtimeProfile?: ProviderRuntimeProfile;

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
    if (runtimeMetadata && runtimeMetadata.metadata && typeof runtimeMetadata.metadata === 'object') {
      context.metadata = runtimeMetadata.metadata;
    }

    // 发送请求 (子类实现)
    const response = await this.sendRequest(processedRequest);

    // 后处理响应
    const finalResponse = await this.postprocessResponse(response, context);

    const endTime = Date.now();
    this.dependencies.logger?.logProviderRequest(this.getLogId(), 'request-success', {
      requestId: context.requestId,
      responseTime: endTime - context.startTime
    });
    await emitProviderSuccessAndWait(buildRuntimeFromProviderContext(context));

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
    let stats: StatsCenterLike | undefined;
    try {
      stats = getStatsCenterSafeFromBridge() as StatsCenterLike;
    } catch (statsError) {
      this.dependencies.logger?.logModule(this.getLogId(), 'stats-center-unavailable', { error: statsError });
    }
    let processedRequest: UnknownObject | undefined;

    try {
      this.requestCount++;
      this.lastActivity = Date.now();

      // 预处理请求
      processedRequest = await this.preprocessRequest(request as UnknownObject);
      reattachRuntimeMetadata(processedRequest, runtimeMetadata);
      if (runtimeMetadata && runtimeMetadata.metadata && typeof runtimeMetadata.metadata === 'object') {
        context.metadata = runtimeMetadata.metadata;
      }

      // 发送请求 (子类实现)
      const response = await this.sendRequestInternal(processedRequest);

      // 后处理响应
      const finalResponse = await this.postprocessResponse(response, context);

      const endTime = Date.now();
      await emitProviderSuccessAndWait(buildRuntimeFromProviderContext(context));
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
        stats?.recordProviderUsage(event);
      } catch {
        // ignore stats errors
      }

      return finalResponse;
    } catch (error) {
      this.errorCount++;
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
        stats?.recordProviderUsage(event);
      } catch {
        // ignore stats errors
      }

      await this.handleRequestError(error, context);
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
      configProviderType: this.config.config.providerType,
      configExtensions:
        this.config.config.extensions && typeof this.config.config.extensions === 'object'
          ? this.config.config.extensions as Record<string, unknown>
          : undefined
    });
    this.lastRuntimeMetadata = runtimeMetadata;
    return context;
  }

  private async handleRequestError(error: unknown, _context: ProviderContext): Promise<void> {
    const now = Date.now();
    const runtimeProfile = this.getRuntimeProfile();
    const classification = classifyProviderError({
      error
    });
    const augmentedError = classification.error;
    const msg = classification.message;
    const statusCode = classification.statusCode;
    const upstreamCode = classification.upstreamCode;
    const upstreamMessage = classification.upstreamMessage;
    const providerKey = _context.providerKey || runtimeProfile?.providerKey;

    const affectsHealth = classification.affectsHealth;
    const recoverable = classification.recoverable;

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
      meta: augmentedError.details
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

    try {
      await emitProviderErrorAndWait({
        error: augmentedError,
        stage: 'provider.http',
        runtime: buildRuntimeFromProviderContext(_context),
        dependencies: this.dependencies,
        statusCode,
        recoverable,
        affectsHealth,
        details: enrichedDetails
      });
    } catch (reportError) {
      this.dependencies.logger?.logModule(this.getLogId(), 'provider-error-report-failed', {
        requestId: _context.requestId,
        providerKey,
        runtimeKey: runtimeProfile?.runtimeKey,
        message: reportError instanceof Error ? reportError.message : String(reportError ?? 'unknown reporter error')
      });
    }
  }

  private enforceRateLimitWindow(_context: ProviderContext): void {
    // 冷却窗口治理收敛到 llmswitch-core VirtualRouter。
    // Provider 层不在此处主动拦截请求，避免与 VirtualRouter 的健康状态重复。
  }

  protected hasDataEnvelope(value: UnknownObject): value is UnknownObject & { data?: UnknownObject } { return hasDataEnvelope(value); }

  // Kept for compatibility with existing tests/introspection helpers.
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
      } else if (unit === 's') {
        totalMs += amount * 1000;
      } else if (unit === 'm') {
        totalMs += amount * 60_000;
      } else if (unit === 'h') {
        totalMs += amount * 3_600_000;
      }
    }
    if (!matched || totalMs <= 0) {
      return null;
    }
    return Math.round(totalMs);
  }
}
