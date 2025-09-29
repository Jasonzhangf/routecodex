/**
 * iFlow Provider Implementation
 *
 * Mirrors the Qwen provider structure but targets the iFlow API and OAuth endpoints.
 */

import type { ProviderModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { ProviderConfig, AuthContext, ProviderResponse, ProviderError } from '../../types/provider-types.js';
import type { UnknownObject } from '../../../../types/common-types.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';
import { createIFlowOAuth, IFlowTokenStorage } from './iflow-oauth.js';
import { DebugEventBus } from "rcc-debugcenter";

const IFLOW_API_ENDPOINT = 'https://apis.iflow.cn/v1';

export class IFlowProvider implements ProviderModule {
  readonly id: string;
  readonly type = 'iflow-provider';
  readonly providerType = 'iflow';
  readonly config: ModuleConfig;

  private isInitialized = false;
  private logger: PipelineDebugLogger;
  private authContext: AuthContext | null = null;
  private healthStatus: {
    status: 'healthy' | 'unhealthy';
    timestamp: number;
    responseTime: number;
    details: Record<string, unknown>;
  } | null = null;
  private oauth: ReturnType<typeof createIFlowOAuth>;
  private tokenStorage: IFlowTokenStorage | null = null;
  private isTestMode = false;

  // Debug instrumentation
  private debugEventBus: DebugEventBus | null = null;
  private isDebugEnhanced = false;
  private providerMetrics: Map<string, { values: unknown[]; lastUpdated: number }> = new Map();
  private requestHistory: UnknownObject[] = [];
  private authHistory: UnknownObject[] = [];
  private errorHistory: UnknownObject[] = [];
  private maxHistorySize = 50;

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.id = `provider-${Date.now()}`;
    this.config = config;
    this.logger = dependencies.logger as PipelineDebugLogger;
    this.oauth = createIFlowOAuth(this.getOAuthOptions());
    this.initializeDebugEnhancements();
  }

  private initializeDebugEnhancements(): void {
    try {
      this.debugEventBus = DebugEventBus.getInstance();
      this.isDebugEnhanced = true;
      console.log('iFlow Provider debug enhancements initialized');
    } catch (error) {
      console.warn('Failed to initialize iFlow Provider debug enhancements:', error);
      this.isDebugEnhanced = false;
    }
  }

  private recordProviderMetric(operation: string, data: unknown): void {
    if (!this.providerMetrics.has(operation)) {
      this.providerMetrics.set(operation, { values: [], lastUpdated: Date.now() });
    }
    const metric = this.providerMetrics.get(operation)!;
    metric.values.push(data);
    metric.lastUpdated = Date.now();
    if (metric.values.length > 50) {
      metric.values.shift();
    }
  }

  private addToRequestHistory(operation: UnknownObject): void {
    this.requestHistory.push(operation);
    if (this.requestHistory.length > this.maxHistorySize) {
      this.requestHistory.shift();
    }
  }

  private addToAuthHistory(operation: UnknownObject): void {
    this.authHistory.push(operation);
    if (this.authHistory.length > this.maxHistorySize) {
      this.authHistory.shift();
    }
  }

  private addToErrorHistory(operation: UnknownObject): void {
    this.errorHistory.push(operation);
    if (this.errorHistory.length > this.maxHistorySize) {
      this.errorHistory.shift();
    }
  }

  private publishDebugEvent(type: string, data: UnknownObject): void {
    if (!this.isDebugEnhanced || !this.debugEventBus) {return;}
    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'iflow-provider',
        operationId: type,
        timestamp: Date.now(),
        type: "start",
        position: 'middle',
        data: {
          ...data,
          providerId: this.id,
          source: 'iflow-provider'
        }
      });
    } catch {
      // ignore publish failures
    }
  }

  getDebugStatus(): UnknownObject {
    const base = {
      id: this.id,
      type: this.type,
      providerType: this.providerType,
      isInitialized: this.isInitialized,
      healthStatus: this.healthStatus,
      hasAuth: !!this.authContext,
      hasToken: !!this.tokenStorage,
      isEnhanced: this.isDebugEnhanced
    };

    if (!this.isDebugEnhanced) {
      return base;
    }

    return {
      ...base,
      debugInfo: this.getDebugInfo(),
      providerMetrics: this.getProviderMetrics(),
      requestHistory: [...this.requestHistory.slice(-10)],
      authHistory: [...this.authHistory.slice(-5)],
      errorHistory: [...this.errorHistory.slice(-5)]
    };
  }

  private getDebugInfo(): UnknownObject {
    return {
      providerId: this.id,
      enhanced: this.isDebugEnhanced,
      eventBusAvailable: !!this.debugEventBus,
      requestHistorySize: this.requestHistory.length,
      authHistorySize: this.authHistory.length,
      errorHistorySize: this.errorHistory.length,
      providerMetricsSize: this.providerMetrics.size,
      maxHistorySize: this.maxHistorySize,
      apiEndpoint: this.getAPIEndpoint()
    };
  }

  private getProviderMetrics(): Record<string, { count: number; lastUpdated: number; recentValues: unknown[] }> {
    const metrics: Record<string, { count: number; lastUpdated: number; recentValues: unknown[] }> = {};
    for (const [operation, metric] of this.providerMetrics.entries()) {
      metrics[operation] = {
        count: metric.values.length,
        lastUpdated: metric.lastUpdated,
        recentValues: metric.values.slice(-5)
      };
    }
    return metrics;
  }

  private getOAuthOptions() {
    const providerConfig = this.config.config as ProviderConfig;
    const oauthConfig = providerConfig.auth?.oauth || {};
    return {
      tokenFile: oauthConfig.tokenFile || this.getTokenFile(),
      clientId: oauthConfig.clientId || DEFAULT_OAUTH_OPTIONS.clientId,
      clientSecret: oauthConfig.clientSecret || DEFAULT_OAUTH_OPTIONS.clientSecret,
      deviceCodeUrl: oauthConfig.deviceCodeUrl || DEFAULT_OAUTH_OPTIONS.deviceCodeUrl,
      tokenUrl: oauthConfig.tokenUrl || DEFAULT_OAUTH_OPTIONS.tokenUrl,
      authUrl: oauthConfig.authUrl || DEFAULT_OAUTH_OPTIONS.authUrl,
      scopes: oauthConfig.scopes || DEFAULT_OAUTH_OPTIONS.scopes
    };
  }

  private getTokenFile(): string {
    const providerConfig = this.config.config as ProviderConfig;
    if (providerConfig.auth?.oauth?.tokenFile) {
      return providerConfig.auth.oauth.tokenFile;
    }
    return process.env.HOME ? `${process.env.HOME}/.iflow/oauth_creds.json` : './iflow-token.json';
  }

  async initialize(): Promise<void> {
    const startTime = Date.now();
    const initId = `init_${Date.now()}_${Math.random().toString(36).substring(2)}`;

    if (this.isDebugEnhanced) {
      this.recordProviderMetric('initialization_start', { initId, timestamp: startTime });
    }

    try {
      await this.initializeAuth();
      await this.checkHealth();
      this.isInitialized = true;

      if (this.isDebugEnhanced) {
        const totalTime = Date.now() - startTime;
        this.recordProviderMetric('initialization_success', { initId, totalTime });
        this.addToAuthHistory({ initId, operation: 'initialize', success: true, totalTime });
      }

    } catch (error) {
      if (this.isDebugEnhanced) {
        const totalTime = Date.now() - startTime;
        this.recordProviderMetric('initialization_error', {
          initId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
        this.addToErrorHistory({
          initId,
          operation: 'initialize',
          error,
          totalTime
        });
      }
      throw error;
    }
  }

  private async initializeAuth(): Promise<void> {
    this.tokenStorage = await this.oauth.loadToken();

    if (!this.tokenStorage || this.tokenStorage.isExpired()) {
      try {
        const storage = await this.oauth.completeOAuthFlow(true);
        this.tokenStorage = storage;
      } catch (error) {
        throw new Error(`iFlow authentication failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.authContext = {
      type: 'oauth',
      token: this.tokenStorage.access_token,
      credentials: {
        accessToken: this.tokenStorage.access_token,
        refreshToken: this.tokenStorage.refresh_token,
        tokenType: this.tokenStorage.token_type,
        expiresAt: this.tokenStorage.expires_at
      },
      metadata: {
        provider: 'iflow',
        initialized: Date.now(),
        hasToken: !!this.tokenStorage.access_token
      }
    };

    if (this.isDebugEnhanced) {
      this.recordProviderMetric('auth_initialized', {
        expiresAt: this.tokenStorage.expires_at,
        hasRefreshToken: !!this.tokenStorage.refresh_token
      });
      this.addToAuthHistory({
        operation: 'initializeAuth',
        expiresAt: this.tokenStorage.expires_at
      });
    }
  }

  async processIncoming(request: Record<string, unknown>): Promise<UnknownObject> {
    if (!this.isInitialized) {
      throw new Error('iFlow Provider is not initialized');
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2)}`;
    const startTime = Date.now();

    if (this.isDebugEnhanced) {
      this.recordProviderMetric('request_start', { requestId, model: request?.model });
      this.addToRequestHistory({ requestId, request, timestamp: startTime });
    }

    try {
      await this.ensureValidToken();
      const response = await this.sendChatRequest(request);
      const processedResponse = this.processResponse(response);

      if (this.isDebugEnhanced) {
        const totalTime = Date.now() - startTime;
        this.recordProviderMetric('request_success', { requestId, totalTime, status: response.status });
      }

      return processedResponse;

    } catch (error) {
      if (this.isDebugEnhanced) {
        const totalTime = Date.now() - startTime;
        this.recordProviderMetric('request_error', {
          requestId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
        this.addToErrorHistory({ requestId, error, request, totalTime });
      }

      await this.handleProviderError(error, request);
      throw error;
    }
  }

  async processOutgoing(response: UnknownObject): Promise<UnknownObject> {
    return response;
  }

  async sendRequest(request: Record<string, unknown>): Promise<ProviderResponse> {
    return this.sendChatRequest(request);
  }

  async cleanup(): Promise<void> {
    this.isInitialized = false;
    this.authContext = null;
    this.healthStatus = null;
    this.tokenStorage = null;
  }

  getStatus(): {
    id: string;
    type: string;
    providerType: string;
    isInitialized: boolean;
    healthStatus: {
      status: 'healthy' | 'unhealthy';
      timestamp: number;
      responseTime: number;
      details: Record<string, unknown>;
    } | null;
    requestMetrics: { requestCount: number; errorCount: number };
    authStatus: string;
    debugEnhanced: boolean;
  } {
    return {
      id: this.id,
      type: this.type,
      providerType: this.providerType,
      isInitialized: this.isInitialized,
      healthStatus: this.healthStatus,
      requestMetrics: {
        requestCount: this.requestHistory.length,
        errorCount: this.errorHistory.length
      },
      authStatus: this.authContext ? 'authenticated' : 'unauthenticated',
      debugEnhanced: this.isDebugEnhanced
    };
  }

  async checkHealth(): Promise<boolean> {
    const started = Date.now();
    try {
      await this.ensureValidToken();
      const response = await fetch(`${this.getAPIEndpoint()}/models`, {
        headers: {
          'Authorization': this.oauth.getAuthorizationHeader(),
          'Content-Type': 'application/json'
        }
      });
      const ok = response.ok;
      this.healthStatus = {
        status: ok ? 'healthy' : 'unhealthy',
        timestamp: Date.now(),
        responseTime: Date.now() - started,
        details: {
          httpStatus: response.status
        }
      };
      return ok;
    } catch (error) {
      this.healthStatus = {
        status: 'unhealthy',
        timestamp: Date.now(),
        responseTime: 0,
        details: {
          error: error instanceof Error ? error.message : String(error)
        }
      };
      return false;
    }
  }

  setTestMode(enabled: boolean): void {
    this.isTestMode = enabled;
  }

  private async ensureValidToken(): Promise<void> {
    if (!this.tokenStorage || this.tokenStorage.isExpired()) {
      if (this.isTestMode) {
        throw new Error('Test mode: No valid iFlow token available. Please authenticate first.');
      }

      try {
        if (this.tokenStorage?.refresh_token) {
          try {
            await this.oauth.refreshTokensWithRetry(this.tokenStorage.refresh_token);
            this.tokenStorage = this.oauth.getToken();
          } catch (refreshError) {
            this.recordTokenRefreshFailure(refreshError);
            const storage = await this.oauth.completeOAuthFlow(true);
            this.tokenStorage = storage;
          }
        } else {
          const storage = await this.oauth.completeOAuthFlow(true);
          this.tokenStorage = storage;
        }

        if (this.authContext && this.tokenStorage) {
          this.authContext.token = this.tokenStorage.access_token;
          if (this.authContext.metadata) {
            this.authContext.metadata.lastUpdated = Date.now();
            this.authContext.metadata.hasToken = true;
          }
        }

      } catch (error) {
        this.addToErrorHistory({
          operation: 'ensureValidToken',
          error,
          timestamp: Date.now()
        });
        throw new Error(`iFlow authentication failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private recordTokenRefreshFailure(error: unknown): void {
    if (!this.isDebugEnhanced) {return;}
    this.recordProviderMetric('token_refresh_failed', {
      error: error instanceof Error ? error.message : String(error),
      timestamp: Date.now()
    });
    this.addToAuthHistory({
      operation: 'token_refresh_failed',
      error,
      timestamp: Date.now()
    });
  }

  private getAPIEndpoint(): string {
    const providerConfig = this.config.config as ProviderConfig;
    return providerConfig.baseUrl || IFLOW_API_ENDPOINT;
  }

  private async sendChatRequest(request: Record<string, unknown>): Promise<ProviderResponse> {
    const startTime = Date.now();
    const httpRequestId = `http_${Date.now()}_${Math.random().toString(36).substring(2)}`;
    const endpoint = `${this.getAPIEndpoint()}/chat/completions`;

    if (this.isDebugEnhanced) {
      this.publishDebugEvent('http_request_start', {
        httpRequestId,
        endpoint,
        model: request?.model
      });
    }

    try {
      const payload = this.buildIFlowPayload(request);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': this.oauth.getAuthorizationHeader(),
          'User-Agent': 'RouteCodex/1.0.0'
        },
        body: JSON.stringify(payload)
      });

      const elapsed = Date.now() - startTime;

      // On 401, attempt refresh and retry; if still 401 then complete OAuth flow and final retry
      if (response.status === 401) {
        try {
          if (this.tokenStorage?.refresh_token) {
            try {
              await this.oauth.refreshTokensWithRetry(this.tokenStorage.refresh_token);
              this.tokenStorage = this.oauth.getToken();
            } catch (refreshErr) {
              this.recordTokenRefreshFailure(refreshErr);
              const storage = await this.oauth.completeOAuthFlow(true);
              this.tokenStorage = storage;
            }
          } else {
            const storage = await this.oauth.completeOAuthFlow(true);
            this.tokenStorage = storage;
          }

          if (this.authContext && this.tokenStorage) {
            this.authContext.token = this.tokenStorage.access_token;
          }

          const retry = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': this.oauth.getAuthorizationHeader(),
              'User-Agent': 'RouteCodex/1.0.0'
            },
            body: JSON.stringify(payload)
          });

          if (!retry.ok) {
            const text = await retry.text();
            throw new Error(`iFlow API error after reauth: ${retry.status} ${retry.statusText} - ${text}`);
          }

          const dataRetry = await retry.json();
          return {
            data: dataRetry,
            status: retry.status,
            headers: Object.fromEntries(retry.headers.entries()),
            metadata: {
              requestId: `http_${Date.now()}_${Math.random().toString(36).substring(2)}`,
              processingTime: Date.now() - startTime,
              tokensUsed: dataRetry?.usage?.total_tokens,
              model: dataRetry?.model || request?.model
            }
          };
        } catch (reauthErr) {
          // fall-through to error mapping below
          this.addToErrorHistory({ operation: 'reauth_failed', error: reauthErr, timestamp: Date.now() });
        }
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`iFlow API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data = await response.json();

      if (this.isDebugEnhanced) {
        this.publishDebugEvent('http_request_success', {
          httpRequestId,
          status: response.status,
          elapsed
        });
      }

      return {
        data,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        metadata: {
          requestId: httpRequestId,
          processingTime: elapsed,
          tokensUsed: data?.usage?.total_tokens,
          model: data?.model || request?.model
        }
      };
    } catch (error) {
      if (this.isDebugEnhanced) {
        const elapsed = Date.now() - startTime;
        this.publishDebugEvent('http_request_error', {
          httpRequestId,
          error: error instanceof Error ? error.message : String(error),
          elapsed
        });
      }
      const provErr = this.createProviderError(error, 'network');
      // Attach provider context for routing error payload
      (provErr as any).details = {
        ...(provErr as any).details || {},
        provider: {
          vendor: 'iflow',
          baseUrl: this.getAPIEndpoint(),
          moduleType: this.type,
        }
      };
      throw provErr;
    }
  }

  private buildIFlowPayload(request: Record<string, unknown>): Record<string, unknown> {
    const allowedKeys = [
      'model',
      'messages',
      'input',
      'parameters',
      'tools',
      'stream',
      'response_format',
      'user',
      'metadata'
    ] as const;

    const payload: Record<string, unknown> = {};
    for (const key of allowedKeys) {
      if (key in request && request[key] !== undefined) {
        payload[key] = request[key];
      }
    }

    return payload;
  }

  private processResponse(response: ProviderResponse): UnknownObject {
    return {
      ...response.data,
      _providerMetadata: {
        provider: 'iflow',
        processingTime: response.metadata?.processingTime,
        tokensUsed: response.metadata?.tokensUsed,
        timestamp: Date.now()
      }
    };
  }

  private async handleProviderError(error: unknown, request: unknown): Promise<void> {
    const providerError = this.createProviderError(error, 'unknown');
    this.logger.logModule(this.id, 'provider-error', {
      error: providerError,
      request: {
        model: (request as { model?: string })?.model,
        hasMessages: Array.isArray((request as { messages?: unknown[] })?.messages),
        hasTools: Array.isArray((request as { tools?: unknown[] })?.tools)
      }
    });

    await this.dependencies.errorHandlingCenter.handleError({
      type: 'provider-error',
      message: providerError.message,
      details: {
        providerId: this.id,
        request,
        error: providerError
      },
      timestamp: Date.now()
    });
  }

  private createProviderError(error: unknown, type: ProviderError['type']): ProviderError {
    const err = error instanceof Error ? error : new Error(String(error));
    const providerError: ProviderError = new Error(err.message) as ProviderError;
    providerError.type = type;
    const errLike = error as { status?: number; statusCode?: number; details?: Record<string, unknown> };
    providerError.statusCode = errLike?.status ?? errLike?.statusCode;
    providerError.details = (errLike?.details as Record<string, unknown> | undefined) ?? {};
    providerError.retryable = this.isRetryableError(error);
    return providerError;
  }

  private isRetryableError(error: unknown): boolean {
    const errLike = error as { status?: number; statusCode?: number };
    const status = errLike?.status ?? errLike?.statusCode;
    if (!status) {return false;}
    return status >= 500 || status === 429;
  }
}

const DEFAULT_IFLOW_CONFIG = {
  // Prefer iflow.cn host for OAuth; provider will fall back between device_code and device/code
  DEVICE_CODE_ENDPOINT: 'https://iflow.cn/oauth/device/code',
  TOKEN_ENDPOINT: 'https://iflow.cn/oauth/token',
  AUTHORIZATION_ENDPOINT: 'https://iflow.cn/oauth',
  CLIENT_ID: 'iflow-desktop-client',
  SCOPE: 'openid profile email api'
};

const DEFAULT_OAUTH_OPTIONS = {
  clientId: DEFAULT_IFLOW_CONFIG.CLIENT_ID,
  clientSecret: undefined,
  deviceCodeUrl: DEFAULT_IFLOW_CONFIG.DEVICE_CODE_ENDPOINT,
  tokenUrl: DEFAULT_IFLOW_CONFIG.TOKEN_ENDPOINT,
  authUrl: DEFAULT_IFLOW_CONFIG.AUTHORIZATION_ENDPOINT,
  scopes: DEFAULT_IFLOW_CONFIG.SCOPE.split(' ')
};
