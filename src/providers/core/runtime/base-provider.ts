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
  ProviderType,
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
  protected abstract postprocessResponse(response: unknown, context: ProviderContext): unknown | Promise<any>;

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

  async processIncoming(request: UnknownObject): Promise<unknown> {
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
    const providerType = (runtimeMetadata?.providerType || this.providerType) as ProviderType;
    const runtimeProfile = this.getRuntimeProfile();
    const context: ProviderContext = {
      requestId: runtimeMetadata?.requestId || `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      providerType: (runtimeProfile?.providerType as ProviderType) || providerType,
      startTime: Date.now(),
      model: (request as any).model ?? runtimeMetadata?.target?.model,
      hasTools: !!(request as any).tools,
      metadata: runtimeMetadata?.metadata || {},
      providerId: runtimeMetadata?.providerId || runtimeMetadata?.providerKey || runtimeProfile?.providerId,
      providerKey: runtimeMetadata?.providerKey || runtimeProfile?.providerKey,
      providerProtocol: runtimeMetadata?.providerProtocol,
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
    attachProviderRuntimeMetadata(payload as Record<string, unknown>, metadata);
  }

  private handleRequestError(error: unknown, context: ProviderContext): void {
    const now = Date.now();
    const err: ProviderError = (error instanceof Error ? error : new Error(String(error))) as ProviderError;
    const msg = typeof err.message === 'string' ? err.message : String(error ?? 'unknown error');
    let statusCode: number | undefined = err.statusCode;
    if (!statusCode) {
      try {
        const m = msg.match(/HTTP\s+(\d{3})/i);
        if (m) statusCode = parseInt(m[1], 10);
      } catch { /* ignore */ }
    }
    const upstream = (err as any)?.response?.data;
    const upstreamCode = (err as any)?.code || upstream?.error?.code;
    const upstreamMessage = upstream?.error?.message;
    const isRateLimit = statusCode === 429;
    const isTransient = isRateLimit || (err as any)?.retryable === true;

    const runtimeProfile = this.getRuntimeProfile();
    const isClientError = typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500 && statusCode !== 429;
    const affectsHealth = isClientError ? false : !isTransient;

    // 统一错误日志
      this.dependencies.logger?.logModule(this.id, 'request-error', {
        requestId: context.requestId,
        error: msg,
        statusCode,
        upstreamCode,
        upstreamMessage,
        providerType: context.providerType,
        providerId: context.providerId,
        providerProtocol: context.providerProtocol,
        providerKey: context.providerKey || runtimeProfile?.providerKey,
        runtimeKey: runtimeProfile?.runtimeKey,
        processingTime: now - context.startTime
      });

    const enrichedDetails = {
      providerId: this.id,
      providerKey: context.providerKey || runtimeProfile?.providerKey,
      providerType: context.providerType,
      routeName: context.routeName,
      runtimeKey: runtimeProfile?.runtimeKey,
      upstreamCode,
      upstreamMessage,
      requestContext: context.runtimeMetadata,
      meta: (err as any)?.details
    };
    const enrichedError = err as ProviderError & Record<string, unknown>;
    if (!enrichedError.requestId) {
      enrichedError.requestId = context.requestId;
    }
    enrichedError.providerKey = context.providerKey;
    enrichedError.providerId = context.providerId;
    enrichedError.providerType = context.providerType;
    enrichedError.routeName = context.routeName;
    enrichedError.details = {
      ...(enrichedError.details || {}),
      ...enrichedDetails,
      providerKey: enrichedDetails.providerKey,
      providerType: context.providerType,
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
      recoverable: isTransient,
      affectsHealth,
      details: enrichedDetails
    });
  }
}
