/**
 * Qwen Provider Implementation
 *
 * Complete rewrite based on CLIProxyAPI's Qwen client implementation
 * Using exact OAuth flow, API endpoints, and token format
 */

import type { ProviderModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { SharedPipelineRequest } from '../../../../types/shared-dtos.js';
import type {
  ProviderConfig,
  AuthContext,
  ProviderResponse,
  ProviderError,
  ProviderRequestOptions,
} from '../../types/provider-types.js';
import type { UnknownObject } from '../../../../types/common-types.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';
import { createQwenOAuth, QwenTokenStorage } from './qwen-oauth.js';
import { DebugEventBus } from "rcc-debugcenter";

// API Endpoint - EXACT copy from CLIProxyAPI
const QWEN_API_ENDPOINT = "https://portal.qwen.ai/v1";

/**
 * Qwen Provider Module - Complete rewrite based on CLIProxyAPI
 */
export class QwenProvider implements ProviderModule {
  readonly id: string;
  readonly type = 'qwen-provider';
  readonly providerType = 'qwen';
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
  private oauth: ReturnType<typeof createQwenOAuth>;
  private tokenStorage: QwenTokenStorage | null = null;
  private isTestMode: boolean = false;

  // Debug enhancement properties
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

    // Initialize OAuth with CLIProxyAPI-compatible settings
    this.oauth = createQwenOAuth({
      tokenFile: this.getTokenFile()
    });

    // Initialize debug enhancements
    this.initializeDebugEnhancements();
  }

  /**
   * Initialize debug enhancements
   */
  private initializeDebugEnhancements(): void {
    try {
      this.debugEventBus = DebugEventBus.getInstance();
      this.isDebugEnhanced = true;
      console.log('Qwen Provider debug enhancements initialized');
    } catch (error) {
      console.warn('Failed to initialize Qwen Provider debug enhancements:', error);
      this.isDebugEnhanced = false;
    }
  }

  /**
   * Record provider metric
   */
  private recordProviderMetric(operation: string, data: unknown): void {
    if (!this.providerMetrics.has(operation)) {
      this.providerMetrics.set(operation, {
        values: [],
        lastUpdated: Date.now()
      });
    }

    const metric = this.providerMetrics.get(operation)!;
    metric.values.push(data);
    metric.lastUpdated = Date.now();

    // Keep only last 50 measurements
    if (metric.values.length > 50) {
      metric.values.shift();
    }
  }

  /**
   * Add to request history
   */
  private addToRequestHistory(operation: UnknownObject): void {
    this.requestHistory.push(operation);

    // Keep only recent history
    if (this.requestHistory.length > this.maxHistorySize) {
      this.requestHistory.shift();
    }
  }

  /**
   * Add to auth history
   */
  private addToAuthHistory(operation: UnknownObject): void {
    this.authHistory.push(operation);

    // Keep only recent history
    if (this.authHistory.length > this.maxHistorySize) {
      this.authHistory.shift();
    }
  }

  /**
   * Add to error history
   */
  private addToErrorHistory(operation: UnknownObject): void {
    this.errorHistory.push(operation);

    // Keep only recent history
    if (this.errorHistory.length > this.maxHistorySize) {
      this.errorHistory.shift();
    }
  }

  /**
   * Publish debug event
   */
  private publishDebugEvent(type: string, data: UnknownObject): void {
    if (!this.isDebugEnhanced || !this.debugEventBus) {return;}

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'qwen-provider',
        operationId: type,
        timestamp: Date.now(),
        type: "start",
        position: 'middle',
        data: {
          ...data,
          providerId: this.id,
          source: 'qwen-provider'
        }
      });
    } catch (error) {
      // Silent fail if debug event bus is not available
    }
  }

  /**
   * Get debug status with enhanced information
   */
  getDebugStatus(): UnknownObject {
    const baseStatus = {
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
      return baseStatus;
    }

    return {
      ...baseStatus,
      debugInfo: this.getDebugInfo(),
      providerMetrics: this.getProviderMetrics(),
      requestHistory: [...this.requestHistory.slice(-10)], // Last 10 requests
      authHistory: [...this.authHistory.slice(-5)], // Last 5 auth operations
      errorHistory: [...this.errorHistory.slice(-5)] // Last 5 errors
    };
  }

  /**
   * Get detailed debug information
   */
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

  /**
   * Get provider metrics
   */
  private getProviderMetrics(): Record<string, { count: number; lastUpdated: number; recentValues: unknown[] }> {
    const metrics: Record<string, { count: number; lastUpdated: number; recentValues: unknown[] }> = {};

    for (const [operation, metric] of this.providerMetrics.entries()) {
      metrics[operation] = {
        count: metric.values.length,
        lastUpdated: metric.lastUpdated,
        recentValues: metric.values.slice(-5) // Last 5 values
      };
    }

    return metrics;
  }

  /**
   * Get token file path
   */
  private getTokenFile(): string {
    const providerConfig = this.config.config as ProviderConfig;
    if (providerConfig.auth?.oauth?.tokenFile) {
      return providerConfig.auth.oauth.tokenFile;
    }
    return process.env.HOME ? `${process.env.HOME}/.qwen/oauth_creds.json` : './qwen-token.json';
  }

  /**
   * Initialize the provider
   */
  async initialize(): Promise<void> {
    const startTime = Date.now();
    const initId = `init_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Debug: Record initialization start
    if (this.isDebugEnhanced) {
      this.recordProviderMetric('initialization_start', {
        initId,
        config: this.config,
        providerType: this.providerType,
        timestamp: startTime
      });
      this.publishDebugEvent('initialization_start', {
        initId,
        config: this.config,
        providerType: this.providerType,
        timestamp: startTime
      });
    }

    try {
      this.logger.logModule(this.id, 'initializing', {
        config: this.config,
        providerType: this.providerType
      });

      // Validate configuration
      this.validateConfig();

      // Initialize OAuth and load token
      await this.initializeAuth();

      // Perform initial health check
      await this.checkHealth();

      this.isInitialized = true;
      this.logger.logModule(this.id, 'initialized');

      const totalTime = Date.now() - startTime;

      // Debug: Record initialization completion
      if (this.isDebugEnhanced) {
        this.recordProviderMetric('initialization_complete', {
          initId,
          success: true,
          totalTime,
          hasAuth: !!this.authContext,
          hasToken: !!this.tokenStorage
        });
        this.publishDebugEvent('initialization_complete', {
          initId,
          success: true,
          totalTime,
          hasAuth: !!this.authContext,
          hasToken: !!this.tokenStorage
        });
      }

    } catch (error) {
      const totalTime = Date.now() - startTime;

      // Debug: Record initialization failure
      if (this.isDebugEnhanced) {
        this.recordProviderMetric('initialization_failed', {
          initId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
        this.publishDebugEvent('initialization_failed', {
          initId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
      }

      this.logger.logModule(this.id, 'initialization-error', { error });
      throw error;
    }
  }

  /**
   * Process incoming request - Send to Qwen provider
   */
  // Overload: accept SharedPipelineRequest at the boundary
  async processIncoming(request: SharedPipelineRequest): Promise<unknown>;
  async processIncoming(request: UnknownObject): Promise<unknown>;
  async processIncoming(request: SharedPipelineRequest | UnknownObject): Promise<unknown> {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    if (!this.isInitialized) {
      throw new Error('Qwen Provider is not initialized');
    }

    // Debug: Record request processing start
    if (this.isDebugEnhanced) {
      const hasMessages = this.extractHasMessages(request);
      const hasTools = this.extractHasTools(request);
      const model = this.extractModel(request);
      this.recordProviderMetric('request_start', {
        requestId,
        requestType: typeof request,
        hasMessages,
        hasTools,
        model,
        timestamp: startTime
      });
      this.publishDebugEvent('request_start', {
        requestId,
        request: (this.isSharedPipelineRequest(request) ? (request as SharedPipelineRequest).data : request) as UnknownObject,
        timestamp: startTime
      });
    }

    try {
      this.logger.logProviderRequest(this.id, 'request-start', {
        endpoint: this.getAPIEndpoint(),
        method: 'POST',
        hasAuth: !!this.tokenStorage
      });

      // Ensure we have a valid token
      await this.ensureValidToken();

      // Send HTTP request using CLIProxyAPI logic
      const payload = this.isSharedPipelineRequest(request)
        ? ((request as SharedPipelineRequest).data as UnknownObject)
        : (request as UnknownObject);
      const response = await this.sendChatRequest(payload);

      // Process response
      const processedResponse = this.processResponse(response);

      const totalTime = Date.now() - startTime;

      // Debug: Record request completion
      if (this.isDebugEnhanced) {
        const choices = (processedResponse as { choices?: unknown[] }).choices;
        const hasChoices = Array.isArray(choices) && choices.length > 0;
        const choiceCount = Array.isArray(choices) ? choices.length : 0;
        this.recordProviderMetric('request_complete', {
          requestId,
          success: true,
          totalTime,
          responseStatus: response.status,
          hasChoices,
          choiceCount
        });
        this.addToRequestHistory({
          requestId,
          request: payload,
          response: processedResponse,
          startTime,
          endTime: Date.now(),
          totalTime,
          success: true
        });
        this.publishDebugEvent('request_complete', {
          requestId,
          success: true,
          totalTime,
          response: processedResponse
        });
      }

      this.logger.logProviderRequest(this.id, 'request-success', {
        responseTime: response.metadata?.processingTime,
        status: response.status
      });

      return processedResponse;

    } catch (error) {
      const totalTime = Date.now() - startTime;

      // Debug: Record request failure
      if (this.isDebugEnhanced) {
        this.recordProviderMetric('request_failed', {
          requestId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
        this.addToErrorHistory({
          requestId,
          error,
          request,
          startTime,
          endTime: Date.now(),
          totalTime,
          operation: 'processIncoming'
        });
        this.publishDebugEvent('request_failed', {
          requestId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
      }

      await this.handleProviderError(error, request);
      throw error;
    }
  }

  /**
   * Process outgoing response - Not typically used for providers
   */
  async processOutgoing(response: unknown): Promise<unknown> {
    // For providers, outgoing response processing is usually minimal
    // as they are the final stage in the pipeline
    return response;
  }

  /**
   * Send request to provider
   */
  // Overload: accept SharedPipelineRequest at the boundary
  async sendRequest(request: SharedPipelineRequest | UnknownObject, options?: ProviderRequestOptions): Promise<unknown>;
  async sendRequest(request: SharedPipelineRequest | UnknownObject, _options?: ProviderRequestOptions): Promise<unknown> {
    if (this.isSharedPipelineRequest(request)) {
      return this.processIncoming(request);
    }
    return this.processIncoming(request as UnknownObject);
  }

  /**
   * Check provider health
   */
  async checkHealth(): Promise<boolean> {
    try {
      const startTime = Date.now();

      // Perform health check request
      const healthCheck = await this.performHealthCheck();

      const responseTime = Date.now() - startTime;
      this.healthStatus = {
        status: healthCheck.isHealthy ? 'healthy' : 'unhealthy',
        timestamp: Date.now(),
        responseTime,
        details: healthCheck.details
      };

      this.logger.logProviderRequest(this.id, 'health-check', this.healthStatus);

      return healthCheck.isHealthy;

    } catch (error) {
      this.healthStatus = {
        status: 'unhealthy',
        timestamp: Date.now(),
        responseTime: 0,
        details: {
          error: error instanceof Error ? error.message : String(error),
          connectivity: 'disconnected'
        }
      };

      this.logger.logProviderRequest(this.id, 'health-check', { error });
      return false;
    }
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'cleanup-start');

      // Reset state
      this.isInitialized = false;
      this.authContext = null;
      this.healthStatus = null;
      this.tokenStorage = null;

      this.logger.logModule(this.id, 'cleanup-complete');

    } catch (error) {
      this.logger.logModule(this.id, 'cleanup-error', { error });
      throw error;
    }
  }

  /**
   * Get provider status
   */
  getStatus(): {
    id: string;
    type: string;
    providerType: string;
    isInitialized: boolean;
    authStatus: string;
    healthStatus: {
      status: 'healthy' | 'unhealthy';
      timestamp: number;
      responseTime: number;
      details: Record<string, unknown>;
    } | null;
    lastActivity: number;
  } {
    return {
      id: this.id,
      type: this.type,
      providerType: this.providerType,
      isInitialized: this.isInitialized,
      authStatus: this.tokenStorage ? 'authenticated' : 'unauthenticated',
      healthStatus: this.healthStatus,
      lastActivity: Date.now()
    };
  }

  /**
   * Get provider metrics
   */
  async getMetrics(): Promise<{ requestCount: number; successCount: number; errorCount: number; averageResponseTime: number; timestamp: number }> {
    return {
      requestCount: 0, // Would track actual requests
      successCount: 0,
      errorCount: 0,
      averageResponseTime: 0,
      timestamp: Date.now()
    };
  }

  /**
   * Validate provider configuration
   */
  private validateConfig(): void {
    if (!this.config.type || this.config.type !== 'qwen-provider') {
      throw new Error('Invalid Provider type configuration');
    }

    const providerConfig = this.config.config as ProviderConfig;
    if (!providerConfig.baseUrl && !providerConfig.auth?.oauth) {
      throw new Error('Provider base URL or OAuth configuration is required');
    }

    this.logger.logModule(this.id, 'config-validation-success', {
      type: this.config.type,
      baseUrl: providerConfig.baseUrl,
      hasOAuth: !!providerConfig.auth?.oauth
    });
  }

  /**
   * Initialize authentication
   */
  private async initializeAuth(): Promise<void> {
    const startTime = Date.now();
    const authId = `auth_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Debug: Record auth initialization start
    if (this.isDebugEnhanced) {
      this.recordProviderMetric('auth_initialization_start', {
        authId,
        tokenFile: this.getTokenFile(),
        timestamp: startTime
      });
      this.publishDebugEvent('auth_initialization_start', {
        authId,
        tokenFile: this.getTokenFile(),
        timestamp: startTime
      });
    }

    try {
      // Load existing token
      this.tokenStorage = await this.oauth.loadToken();

      if (this.tokenStorage) {
        this.logger.logModule(this.id, 'token-loaded', {
          hasToken: !!this.tokenStorage.access_token,
          isExpired: this.tokenStorage.isExpired()
        });
      }

      // Create auth context
      this.authContext = {
        type: 'oauth',
        token: this.tokenStorage?.access_token || '',
        credentials: {
          clientId: this.oauth.constructor.name,
          tokenFile: this.getTokenFile()
        },
        metadata: {
          provider: 'qwen',
          initialized: Date.now(),
          hasToken: !!this.tokenStorage
        }
      };

      const totalTime = Date.now() - startTime;

      // Debug: Record auth initialization completion
      if (this.isDebugEnhanced) {
        this.recordProviderMetric('auth_initialization_complete', {
          authId,
          success: true,
          totalTime,
          hasToken: !!this.tokenStorage,
          isExpired: this.tokenStorage?.isExpired()
        });
        this.addToAuthHistory({
          authId,
          operation: 'initializeAuth',
          success: true,
          hasToken: !!this.tokenStorage,
          startTime,
          endTime: Date.now(),
          totalTime
        });
        this.publishDebugEvent('auth_initialization_complete', {
          authId,
          success: true,
          totalTime,
          hasToken: !!this.tokenStorage
        });
      }

    } catch (error) {
      const totalTime = Date.now() - startTime;

      // Debug: Record auth initialization failure
      if (this.isDebugEnhanced) {
        this.recordProviderMetric('auth_initialization_failed', {
          authId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
        this.addToAuthHistory({
          authId,
          operation: 'initializeAuth',
          success: false,
          error,
          startTime,
          endTime: Date.now(),
          totalTime
        });
        this.publishDebugEvent('auth_initialization_failed', {
          authId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
      }

      this.logger.logModule(this.id, 'auth-initialization-error', { error });
      throw error;
    }
  }

  /**
   * Ensure valid token
   */
  private async ensureValidToken(): Promise<void> {
    if (!this.tokenStorage || this.tokenStorage.isExpired()) {
      if (this.isTestMode) {
        throw new Error('Test mode: No valid token available. Please run authentication first.');
      }

      // Try to refresh token or start new OAuth flow
      try {
        if (this.tokenStorage && this.tokenStorage.refresh_token) {
          try {
            const newTokenData = await this.oauth.refreshTokensWithRetry(this.tokenStorage.refresh_token);
            this.oauth.updateTokenStorage(this.tokenStorage, newTokenData);
            await this.oauth.saveToken();
            this.logger.logModule(this.id, 'token-refreshed', { success: true });
          } catch (refreshError) {
            this.logger.logModule(this.id, 'token-refresh-failed', {
              error: refreshError instanceof Error ? refreshError.message : String(refreshError)
            });

            const storage = await this.oauth.completeOAuthFlow(true);
            this.tokenStorage = storage || await this.oauth.loadToken();

            if (!this.tokenStorage || !this.tokenStorage.access_token) {
              throw new Error('OAuth flow did not return a valid token');
            }

            this.logger.logModule(this.id, 'oauth-completed', { success: true, reason: 'refresh-fallback' });
          }
        } else {
          // Start new OAuth flow
          const storage = await this.oauth.completeOAuthFlow(true);
          this.tokenStorage = storage || await this.oauth.loadToken();
          this.logger.logModule(this.id, 'oauth-completed', { success: true, reason: 'no-refresh-token' });
        }

        if (this.authContext) {
          this.authContext.token = this.tokenStorage?.access_token || '';
          if (this.authContext.metadata) {
            this.authContext.metadata.hasToken = !!this.tokenStorage?.access_token;
            this.authContext.metadata.lastUpdated = Date.now();
          }
        }

      } catch (error) {
        this.logger.logModule(this.id, 'auth-error', { error });
        throw new Error(`Authentication failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Get API endpoint - EXACT copy from CLIProxyAPI logic
   */
  private getAPIEndpoint(): string {
    if (this.tokenStorage && this.tokenStorage.resource_url) {
      return `https://${this.tokenStorage.resource_url}/v1`;
    }
    const providerConfig = this.config.config as ProviderConfig;
    return providerConfig.baseUrl || QWEN_API_ENDPOINT;
  }

  /**
   * Send chat request - EXACT copy from CLIProxyAPI logic
   */
  private async sendChatRequest(request: UnknownObject): Promise<ProviderResponse> {
    const startTime = Date.now();
    const httpRequestId = `http_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const endpoint = this.getAPIEndpoint();

    // Debug: Record HTTP request start
    if (this.isDebugEnhanced) {
      this.recordProviderMetric('http_request_start', {
        httpRequestId,
        endpoint,
        model: (request as { model?: string }).model,
        hasTools: Array.isArray((request as { tools?: unknown[] }).tools) && (request as { tools?: unknown[] }).tools!.length > 0,
        timestamp: startTime
      });
      this.publishDebugEvent('http_request_start', {
        httpRequestId,
        endpoint,
        request,
        timestamp: startTime
      });
    }

    try {
      const url = `${endpoint}/chat/completions`;
      const authHeader = this.oauth.getAuthorizationHeader();
      this.logger.logProviderRequest(this.id, 'request-start', {
        model: (request as { model?: string })?.model,
        hasInput: Array.isArray((request as { input?: unknown[] })?.input),
        keys: Object.keys((request as Record<string, unknown>) || {})
      });
      console.log('[QwenProvider] sending request payload:', JSON.stringify(request));

      const payload = this.buildQwenPayload(request as Record<string, unknown>);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
          'User-Agent': 'google-api-nodejs-client/9.15.1',
          'X-Goog-Api-Client': 'gl-node/22.17.0',
          'Client-Metadata': this.getClientMetadataString(),
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const processingTime = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text();

        // Debug: Record HTTP request failure
        if (this.isDebugEnhanced) {
          this.recordProviderMetric('http_request_failed', {
            httpRequestId,
            status: response.status,
            error: errorText,
            processingTime
          });
          this.addToErrorHistory({
            httpRequestId,
            error: new Error(`HTTP ${response.status}: ${errorText}`),
            request,
            startTime,
            endTime: Date.now(),
            processingTime,
            operation: 'sendChatRequest'
          });
          this.publishDebugEvent('http_request_failed', {
            httpRequestId,
            status: response.status,
            error: errorText,
            processingTime
          });
        }

        throw this.createProviderError({
          message: `HTTP ${response.status}: ${errorText}`,
          status: response.status
        }, 'server');
      }

      const data = await response.json();
      const totalTime = Date.now() - startTime;

      // Debug: Record HTTP request success
      if (this.isDebugEnhanced) {
        this.recordProviderMetric('http_request_complete', {
          httpRequestId,
          success: true,
          totalTime,
          status: response.status,
          tokensUsed: data.usage?.total_tokens,
          hasChoices: !!data.choices,
          choiceCount: data.choices?.length || 0
        });
        this.publishDebugEvent('http_request_complete', {
          httpRequestId,
          success: true,
          totalTime,
          response: data,
          status: response.status
        });
      }

      return {
        data,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        metadata: {
          requestId: `req-${Date.now()}`,
          processingTime,
          tokensUsed: data.usage?.total_tokens,
          model: (request as { model?: string }).model || 'unknown'
        }
      };

    } catch (error) {
      const totalTime = Date.now() - startTime;

      // Debug: Record HTTP request error
      if (this.isDebugEnhanced) {
        this.recordProviderMetric('http_request_error', {
          httpRequestId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
        this.addToErrorHistory({
          httpRequestId,
          error,
          request,
          startTime,
          endTime: Date.now(),
          totalTime,
          operation: 'sendChatRequest'
        });
        this.publishDebugEvent('http_request_error', {
          httpRequestId,
          error: error instanceof Error ? error.message : String(error),
          totalTime
        });
      }

      throw this.createProviderError(error, 'network');
    }
  }

  /**
   * Build sanitized payload for Qwen API
   */
  private buildQwenPayload(request: Record<string, unknown>): Record<string, unknown> {
    type AllowedKey =
      | 'model'
      | 'messages'
      | 'input'
      | 'parameters'
      | 'tools'
      | 'stream'
      | 'response_format'
      | 'user'
      | 'metadata';

    const allowedKeys: AllowedKey[] = [
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

    const payload: Record<string, unknown> = {};
    for (const key of allowedKeys) {
      if (key in request && (request as Record<string, unknown>)[key] !== undefined) {
        payload[key] = (request as Record<string, unknown>)[key];
      }
    }

    return payload;
  }

  /**
   * Get client metadata - EXACT copy from CLIProxyAPI logic
   */
  private getClientMetadata(): Map<string, string> {
    const metadata = new Map([
      ['ideType', 'IDE_UNSPECIFIED'],
      ['platform', 'PLATFORM_UNSPECIFIED'],
      ['pluginType', 'GEMINI']
    ]);
    return metadata;
  }

  /**
   * Get client metadata string - EXACT copy from CLIProxyAPI logic
   */
  private getClientMetadataString(): string {
    const md = this.getClientMetadata();
    const parts = [];
    for (const [k, v] of md) {
      parts.push(`${k}=${v}`);
    }
    return parts.join(',');
  }

  /**
   * Process provider response
   */
  private processResponse(response: ProviderResponse): Record<string, unknown> {
    const processedResponse = {
      ...response.data,
      _providerMetadata: {
        provider: 'qwen',
        processingTime: response.metadata?.processingTime,
        tokensUsed: response.metadata?.tokensUsed,
        timestamp: Date.now()
      }
    };

    return processedResponse;
  }

  /**
   * Perform health check
   */
  private async performHealthCheck(): Promise<{ isHealthy: boolean; details: Record<string, unknown> }> {
    try {
      // Would perform actual health check request
      // For now, simulate a health check
      const isHealthy = this.tokenStorage !== null && !this.tokenStorage.isExpired();

      return {
        isHealthy,
        details: {
          authentication: isHealthy ? 'valid' : 'invalid',
          connectivity: 'connected',
          timestamp: Date.now()
        }
      };
    } catch (error) {
      return {
        isHealthy: false,
        details: {
          authentication: 'unknown',
          connectivity: 'disconnected',
          error: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  /**
   * Handle provider errors
   */
  private async handleProviderError(error: unknown, request: unknown): Promise<void> {
    const providerError = this.createProviderError(error, 'unknown');

    this.logger.logModule(this.id, 'provider-error', {
      error: providerError,
      request: {
        model: this.extractModel(request),
        hasMessages: this.extractHasMessages(request)
      }
    });

    // Would integrate with error handling center here
    await this.dependencies.errorHandlingCenter.handleError({
      type: 'provider-error',
      message: providerError.message,
      details: {
        providerId: this.id,
        error: providerError,
        request
      },
      timestamp: Date.now()
    });
  }

  /**
   * Create provider error
   */
  private createProviderError(error: unknown, type: ProviderError['type']): ProviderError {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    const providerError: ProviderError = new Error(errorObj.message) as ProviderError;
    providerError.type = type;
    const errLike = error as { status?: number; statusCode?: number; details?: Record<string, unknown> };
    providerError.statusCode = errLike.status ?? errLike.statusCode;
    providerError.details = (errLike.details as Record<string, unknown> | undefined) ?? {};
    providerError.retryable = this.isErrorRetryable(type);

    return providerError;
  }

  /**
   * Check if error is retryable
   */
  private isErrorRetryable(errorType: string): boolean {
    const retryableTypes = ['network', 'timeout', 'rate_limit', 'server'];
    return retryableTypes.includes(errorType);
  }

  /**
   * Set test mode
   */
  setTestMode(enabled: boolean): void {
    this.isTestMode = enabled;
  }

  /**
   * Validate token (for testing)
   */
  async validateToken(): Promise<boolean> {
    try {
      await this.ensureValidToken();
      return this.tokenStorage !== null && !this.tokenStorage.isExpired();
    } catch (error) {
      return false;
    }
  }

  private isSharedPipelineRequest(value: unknown): value is SharedPipelineRequest {
    if (!value || typeof value !== 'object') {return false;}
    const v = value as Record<string, unknown>;
    return 'data' in v && 'route' in v && 'metadata' in v && 'debug' in v;
  }

  private extractModel(request: unknown): string | undefined {
    if (this.isSharedPipelineRequest(request)) {
      const data = request.data as UnknownObject;
      return (data as { model?: string }).model;
    }
    return (request as { model?: string })?.model;
  }

  private extractHasMessages(request: unknown): boolean {
    if (this.isSharedPipelineRequest(request)) {
      const data = request.data as UnknownObject;
      return Array.isArray((data as { messages?: unknown[] }).messages);
    }
    return Array.isArray((request as { messages?: unknown[] })?.messages);
  }

  private extractHasTools(request: unknown): boolean {
    if (this.isSharedPipelineRequest(request)) {
      const data = request.data as UnknownObject;
      return Array.isArray((data as { tools?: unknown[] }).tools) && ((data as { tools?: unknown[] }).tools?.length || 0) > 0;
    }
    return Array.isArray((request as { tools?: unknown[] })?.tools) && (((request as { tools?: unknown[] })?.tools?.length) || 0) > 0;
  }
}
