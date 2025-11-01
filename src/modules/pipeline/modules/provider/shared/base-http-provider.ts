/**
 * Base HTTP Provider - 统一HTTP请求处理逻辑
 *
 * 为所有Provider提供统一的HTTP请求处理，避免重复实现
 */

import type { ProviderModule, ModuleConfig, ModuleDependencies } from '../../../interfaces/pipeline-interfaces.js';
import type { ProviderConfig, AuthContext, ProviderResponse } from '../../../types/provider-types.js';
import type { UnknownObject } from '../../../../../types/common-types.js';
import { PipelineDebugLogger } from '../../../utils/debug-logger.js';
import { buildAuthHeaders, createProviderError, isRetryableError } from './provider-helpers.js';
import { DebugEventBus } from 'rcc-debugcenter';

export abstract class BaseHttpProvider implements ProviderModule {
  readonly id: string;
  readonly abstract type: string;
  readonly abstract providerType: string;
  readonly config: ModuleConfig;

  protected isInitialized = false;
  protected logger: PipelineDebugLogger;
  protected authContext: AuthContext | null = null;
  protected baseUrl: string;
  protected headers: Record<string, string> = {};
  protected debugEventBus: DebugEventBus | null = null;
  protected isDebugEnhanced = false;
  protected maxRetries = 3;
  protected retryDelay = 1000;

  constructor(config: ModuleConfig, dependencies: ModuleDependencies) {
    this.id = `provider-${Date.now()}`;
    this.config = config;
    this.logger = dependencies.logger as PipelineDebugLogger;

    const providerConfig = this.config.config as ProviderConfig;
    this.baseUrl = providerConfig.baseUrl || this.getDefaultBaseUrl();

    this.initializeDebugEnhancements();
  }

  protected abstract getDefaultBaseUrl(): string;
  protected abstract buildEndpointUrl(path?: string): string;

  protected initializeDebugEnhancements(): void {
    try {
      this.debugEventBus = DebugEventBus.getInstance();
      this.isDebugEnhanced = true;
    } catch {
      this.debugEventBus = null;
      this.isDebugEnhanced = false;
    }
  }

  async initialize(): Promise<void> {
    const providerConfig = this.config.config as ProviderConfig;
    const auth = providerConfig.auth as any;

    // 初始化认证上下文
    if (auth && (auth.type === 'apikey' || auth.type === 'bearer') && (auth.apiKey || auth.token)) {
      const token = String(auth.apiKey || auth.token).trim();
      this.authContext = {
        type: auth.type === 'bearer' ? 'bearer' : 'apikey',
        token,
        credentials: auth
      } as AuthContext;
    } else if (auth && auth.type === 'oauth') {
      this.authContext = { type: 'oauth', token: auth.accessToken || '', credentials: auth };
    } else {
      this.authContext = null;
    }

    // 设置默认请求头
    this.headers = buildAuthHeaders(this.authContext, {
      'Content-Type': 'application/json',
      'User-Agent': 'RouteCodex/1.0'
    });

    this.isInitialized = true;
  }

  async checkHealth(): Promise<boolean> {
    try {
      const url = this.buildEndpointUrl('/models');
      const response = await fetch(url, {
        method: 'GET',
        headers: this.headers
      });
      return response.ok || response.status === 404;
    } catch {
      return false;
    }
  }

  async processIncoming(request: UnknownObject): Promise<ProviderResponse> {
    if (!this.isInitialized) {
      throw new Error('Provider is not initialized');
    }
    return this.sendRequest(request);
  }

  async processOutgoing(response: UnknownObject): Promise<UnknownObject> {
    return response;
  }

  public async sendRequest(request: UnknownObject, endpoint?: string): Promise<ProviderResponse> {
    const url = endpoint || this.buildEndpointUrl('/chat/completions');
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        this.logger.logModule(this.id, 'request', { url, attempt });

        const response = await fetch(url, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify(request)
        } as any);

        if (!response.ok) {
          const errorText = await response.text();
          throw createProviderError({
            statusCode: response.status,
            message: `HTTP ${response.status}: ${errorText}`,
            details: { url, attempt, responseText: errorText }
          }, 'server');
        }

        const data = await response.json();

        const providerResponse: ProviderResponse = {
          data,
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          metadata: {
            requestId: this.id,
            processingTime: 0,
            model: 'unknown'
          }
        };

        this.logger.logModule(this.id, 'success', {
          status: response.status,
          attempt: attempt + 1
        });

        return providerResponse;

      } catch (error) {
        lastError = error;

        if (!isRetryableError(error) || attempt === this.maxRetries) {
          this.logger.logModule(this.id, 'error', {
            error: error instanceof Error ? error.message : String(error),
            attempt: attempt + 1,
            willRetry: false
          });
          throw error;
        }

        this.logger.logModule(this.id, 'retry', {
          error: error instanceof Error ? error.message : String(error),
          attempt: attempt + 1,
          willRetry: true,
          delay: this.retryDelay * (attempt + 1)
        });

        // 指数退避
        await new Promise(resolve =>
          setTimeout(resolve, this.retryDelay * Math.pow(2, attempt))
        );
      }
    }

    throw lastError;
  }

  protected isStreamingRequest(request: UnknownObject): boolean {
    return !!(request as any).stream;
  }

  protected handleStreamingResponse(response: Response): Promise<ProviderResponse> {
    // 流式响应处理由子类实现
    throw new Error('Streaming not implemented in base provider');
  }

  async cleanup(): Promise<void> {
    this.isInitialized = false;
    this.authContext = null;
    this.headers = {};
  }
}