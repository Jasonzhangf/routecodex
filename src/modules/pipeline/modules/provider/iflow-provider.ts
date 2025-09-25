/**
 * iFlow Provider Implementation
 *
 * Mirrors the Qwen provider structure but targets the iFlow API and OAuth endpoints.
 */

import type { ProviderModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { ProviderConfig, AuthContext, ProviderResponse, ProviderError } from '../../types/provider-types.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';
import { createIFlowOAuth, IFlowTokenStorage } from './iflow-oauth.js';
import { DebugEventBus } from "rcc-debugcenter";

const IFLOW_API_ENDPOINT = 'https://api.iflow.cn/v1';

export class IFlowProvider implements ProviderModule {
  readonly id: string;
  readonly type = 'iflow-provider';
  readonly providerType = 'iflow';
  readonly config: ModuleConfig;

  private isInitialized = false;
  private logger: PipelineDebugLogger;
  private authContext: AuthContext | null = null;
  private healthStatus: any = null;
  private oauth: ReturnType<typeof createIFlowOAuth>;
  private tokenStorage: IFlowTokenStorage | null = null;
  private isTestMode = false;

  // Debug instrumentation
  private debugEventBus: DebugEventBus | null = null;
  private isDebugEnhanced = false;
  private providerMetrics: Map<string, any> = new Map();
  private requestHistory: any[] = [];
  private authHistory: any[] = [];
  private errorHistory: any[] = [];
  private maxHistorySize = 50;

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.id = `provider-${Date.now()}`;
    this.config = config;
    this.logger = dependencies.logger as any;
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

  private recordProviderMetric(operation: string, data: any): void {
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

  private addToRequestHistory(operation: any): void {
    this.requestHistory.push(operation);
    if (this.requestHistory.length > this.maxHistorySize) {
      this.requestHistory.shift();
    }
  }

  private addToAuthHistory(operation: any): void {
    this.authHistory.push(operation);
    if (this.authHistory.length > this.maxHistorySize) {
      this.authHistory.shift();
    }
  }

  private addToErrorHistory(operation: any): void {
    this.errorHistory.push(operation);
    if (this.errorHistory.length > this.maxHistorySize) {
      this.errorHistory.shift();
    }
  }

  private publishDebugEvent(type: string, data: any): void {
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

  getDebugStatus(): any {
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

  private getDebugInfo(): any {
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

  private getProviderMetrics(): any {
    const metrics: any = {};
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

  async processIncoming(request: any): Promise<any> {
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

  async processOutgoing(response: any): Promise<any> {
    return response;
  }

  async sendRequest(request: any): Promise<ProviderResponse> {
    return this.sendChatRequest(request);
  }

  async cleanup(): Promise<void> {
    this.isInitialized = false;
    this.authContext = null;
    this.healthStatus = null;
    this.tokenStorage = null;
  }

  getStatus(): any {
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
        details: {
          httpStatus: response.status
        }
      };
      return ok;
    } catch (error) {
      this.healthStatus = {
        status: 'unhealthy',
        timestamp: Date.now(),
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

  private async sendChatRequest(request: any): Promise<ProviderResponse> {
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
      throw this.createProviderError(error, 'network');
    }
  }

  private buildIFlowPayload(request: any): any {
    const allowedKeys: Array<keyof any> = [
      'model',
      'messages',
      'input',
      'parameters',
      'tools',
      'stream',
      'response_format',
      'user',
      'metadata'
    ];

    const payload: any = {};
    for (const key of allowedKeys) {
      if (request[key] !== undefined) {
        payload[key] = request[key];
      }
    }

    return payload;
  }

  private processResponse(response: ProviderResponse): any {
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

  private async handleProviderError(error: any, request: any): Promise<void> {
    const providerError = this.createProviderError(error, 'unknown');
    this.logger.logModule(this.id, 'provider-error', {
      error: providerError,
      request: {
        model: request?.model,
        hasMessages: Array.isArray(request?.messages),
        hasTools: Array.isArray(request?.tools)
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

  private createProviderError(error: unknown, type: string): ProviderError {
    const err = error instanceof Error ? error : new Error(String(error));
    const providerError: ProviderError = new Error(err.message) as ProviderError;
    providerError.type = type as any;
    providerError.statusCode = (error as any)?.status || (error as any)?.statusCode;
    providerError.details = (error as any)?.details || error;
    providerError.retryable = this.isRetryableError(error);
    return providerError;
  }

  private isRetryableError(error: any): boolean {
    const status = error?.status || error?.statusCode;
    if (!status) {return false;}
    return status >= 500 || status === 429;
  }
}

const DEFAULT_IFLOW_CONFIG = {
  DEVICE_CODE_ENDPOINT: 'https://api.iflow.cn/oauth/device_code',
  TOKEN_ENDPOINT: 'https://api.iflow.cn/oauth/token',
  CLIENT_ID: 'iflow-desktop-client',
  SCOPE: 'openid profile email api'
};

const DEFAULT_OAUTH_OPTIONS = {
  clientId: DEFAULT_IFLOW_CONFIG.CLIENT_ID,
  clientSecret: undefined,
  deviceCodeUrl: DEFAULT_IFLOW_CONFIG.DEVICE_CODE_ENDPOINT,
  tokenUrl: DEFAULT_IFLOW_CONFIG.TOKEN_ENDPOINT,
  scopes: DEFAULT_IFLOW_CONFIG.SCOPE.split(' ')
};
