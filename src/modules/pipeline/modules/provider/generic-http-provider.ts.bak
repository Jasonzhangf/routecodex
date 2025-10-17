/**
 * Generic HTTP Provider Implementation
 *
 * Provides a generic HTTP client for various AI service providers
 * with configurable authentication and request handling.
 */

import type { ProviderModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { SharedPipelineRequest } from '../../../../types/shared-dtos.js';
import type {
  ProviderConfig,
  AuthContext,
  ProviderResponse,
  ProviderError,
  ProviderRequestOptions,
  APIKeyAuthConfig,
  BearerAuthConfig,
  BasicAuthConfig,
  OAuthAuthConfig,
  CustomAuthConfig,
} from '../../types/provider-types.js';
import type { UnknownObject } from '../../../../types/common-types.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';
import { DebugEventBus } from "rcc-debugcenter";
import { buildAuthHeaders, createProviderError } from './shared/provider-helpers.js';

// Simulated response types for development path
interface SimulatedChoice {
  index: number;
  message: { role: string; content: string };
  finish_reason: string;
}

interface SimulatedProviderData {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: SimulatedChoice[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface SimulatedHttpResponse {
  data: SimulatedProviderData;
  status: number;
  headers: Record<string, string>;
}

/**
 * Generic HTTP Provider Module
 */
export class GenericHTTPProvider implements ProviderModule {
  readonly id: string;
  readonly type = 'generic-http';
  readonly providerType: string;
  readonly config: ModuleConfig;

  private isInitialized = false;
  private logger: PipelineDebugLogger;
  private authContext: AuthContext | null = null;
  private httpClient: { baseUrl: string; timeout: number; headers: Record<string, string> } | null = null;
  private healthStatus: {
    status: 'healthy' | 'unhealthy';
    timestamp: number;
    responseTime: number;
    details: Record<string, unknown>;
  } | null = null;

  // Debug enhancement properties
  private debugEventBus: DebugEventBus | null = null;
  private isDebugEnhanced = false;
  private providerMetrics: Map<string, { values: unknown[]; lastUpdated: number }> = new Map();
  private requestHistory: UnknownObject[] = [];
  private errorHistory: UnknownObject[] = [];
  private maxHistorySize = 50;

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.id = `provider-${Date.now()}`;
    this.config = config;
    this.providerType = (config.config as ProviderConfig).type;
    this.logger = dependencies.logger as PipelineDebugLogger;

    // Initialize debug enhancements
    this.initializeDebugEnhancements();
  }

  /**
   * Initialize the provider
   */
  async initialize(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'initializing', {
        config: this.config,
        providerType: this.providerType
      });

      // Validate configuration
      this.validateConfig();

      // Initialize authentication
      await this.initializeAuth();

      // Initialize HTTP client
      await this.initializeHttpClient();

      // Perform initial health check
      await this.checkHealth();

      this.isInitialized = true;
      this.logger.logModule(this.id, 'initialized');

    } catch (error) {
      this.logger.logModule(this.id, 'initialization-error', { error });
      throw error;
    }
  }

  /**
   * Process incoming request - Send to generic provider
   */
  // Overload: accept SharedPipelineRequest at the boundary
  async processIncoming(request: SharedPipelineRequest): Promise<unknown>;
  async processIncoming(request: UnknownObject): Promise<unknown>;
  async processIncoming(request: SharedPipelineRequest | UnknownObject): Promise<unknown> {
    if (!this.isInitialized) {
      throw new Error('Generic HTTP Provider is not initialized');
    }

    try {
      this.logger.logProviderRequest(this.id, 'request-start', {
        endpoint: this.getEndpoint(),
        method: 'POST',
        hasAuth: !!this.authContext
      });

      // Prepare request for provider
      const providerRequest = this.prepareRequest(request);

      // Send HTTP request
      const response = await this.sendHttpRequest(providerRequest);

      // Process response
      const processedResponse = this.processResponse(response);

      this.logger.logProviderRequest(this.id, 'request-success', {
        responseTime: response.metadata?.processingTime,
        status: response.status
      });

      return processedResponse;

    } catch (error) {
      await this.handleProviderError(error, request);
      throw error;
    }
  }

  /**
   * Process outgoing response - Not typically used for providers
   */
  async processOutgoing(response: unknown): Promise<unknown> {
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

      // Close HTTP client connections
      if (this.httpClient) {
        await this.closeHttpClient();
      }

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
      authStatus: this.authContext ? 'authenticated' : 'unauthenticated',
      healthStatus: this.healthStatus,
      lastActivity: Date.now()
    };
  }

  /**
   * Get provider metrics
   */
  async getMetrics(): Promise<{ requestCount: number; successCount: number; errorCount: number; averageResponseTime: number; timestamp: number }> {
    return {
      requestCount: 0,
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
    if (!this.config.type || this.config.type !== 'generic-http') {
      throw new Error('Invalid Provider type configuration');
    }

    const providerConfig = this.config.config as ProviderConfig;
    if (!providerConfig.baseUrl) {
      throw new Error('Provider base URL is required');
    }

    if (!providerConfig.auth) {
      throw new Error('Provider authentication configuration is required');
    }

    if (!providerConfig.type) {
      throw new Error('Provider type is required');
    }

    this.logger.logModule(this.id, 'config-validation-success', {
      type: this.config.type,
      providerType: providerConfig.type,
      baseUrl: providerConfig.baseUrl,
      authType: providerConfig.auth.type
    });
  }

  /**
   * Initialize authentication
   */
  private async initializeAuth(): Promise<void> {
    const providerConfig = this.config.config as ProviderConfig;
    const authConfig = providerConfig.auth;

    switch (authConfig.type) {
      case 'apikey':
        this.authContext = this.initializeApiKeyAuth(authConfig as APIKeyAuthConfig);
        break;
      case 'bearer':
        this.authContext = this.initializeBearerAuth(authConfig as BearerAuthConfig);
        break;
      case 'oauth':
        this.authContext = await this.initializeOAuthAuth(authConfig as OAuthAuthConfig);
        break;
      case 'basic':
        this.authContext = this.initializeBasicAuth(authConfig as BasicAuthConfig);
        break;
      case 'custom':
        this.authContext = await this.initializeCustomAuth(authConfig as CustomAuthConfig);
        break;
      default:
        throw new Error(`Unsupported authentication type: ${authConfig.type}`);
    }

    this.logger.logModule(this.id, 'auth-initialized', {
      type: authConfig.type,
      hasToken: !!this.authContext?.token
    });
  }

  /**
   * Initialize API key authentication
   */
  private initializeApiKeyAuth(authConfig: APIKeyAuthConfig): AuthContext {
    return {
      type: 'apikey',
      token: authConfig.apiKey,
      credentials: {
        apiKey: authConfig.apiKey,
        headerName: authConfig.headerName || 'Authorization',
        prefix: authConfig.prefix || 'Bearer '
      },
      metadata: {
        provider: this.providerType,
        initialized: Date.now()
      }
    };
  }

  /**
   * Initialize bearer token authentication
   */
  private initializeBearerAuth(authConfig: BearerAuthConfig): AuthContext {
    return {
      type: 'bearer',
      token: authConfig.token,
      credentials: {
        token: authConfig.token,
        refreshUrl: authConfig.refreshUrl,
        refreshBuffer: authConfig.refreshBuffer || 300000 // 5 minutes
      },
      metadata: {
        provider: this.providerType,
        initialized: Date.now()
      }
    };
  }

  /**
   * Initialize OAuth authentication
   */
  private async initializeOAuthAuth(authConfig: OAuthAuthConfig): Promise<AuthContext> {
    // Would implement OAuth flow here
    return {
      type: 'oauth',
      token: 'oauth-token-placeholder', // Would be actual OAuth token
      refreshToken: 'refresh-token-placeholder',
      expiresAt: Date.now() + 3600000, // 1 hour
      credentials: {
        clientId: authConfig.clientId,
        clientSecret: authConfig.clientSecret,
        tokenUrl: authConfig.tokenUrl,
        scopes: authConfig.scopes || []
      },
      metadata: {
        provider: this.providerType,
        initialized: Date.now()
      }
    };
  }

  /**
   * Initialize basic authentication
   */
  private initializeBasicAuth(authConfig: BasicAuthConfig): AuthContext {
    const credentials = Buffer.from(`${authConfig.username}:${authConfig.password}`).toString('base64');

    return {
      type: 'basic',
      token: credentials,
      credentials: {
        username: authConfig.username,
        password: authConfig.password
      },
      metadata: {
        provider: this.providerType,
        initialized: Date.now()
      }
    };
  }

  /**
   * Initialize custom authentication
   */
  private async initializeCustomAuth(authConfig: CustomAuthConfig): Promise<AuthContext> {
    // Would load custom authentication implementation
    return {
      type: 'custom',
      token: 'custom-token-placeholder',
      credentials: authConfig.config || {},
      metadata: {
        provider: this.providerType,
        implementation: authConfig.implementation,
        initialized: Date.now()
      }
    };
  }

  /**
   * Initialize HTTP client
   */
  private async initializeHttpClient(): Promise<void> {
    const providerConfig = this.config.config as ProviderConfig;

    // Would initialize actual HTTP client here
    this.httpClient = {
      baseUrl: providerConfig.baseUrl,
      timeout: this.config.config?.timeout || 30000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'RouteCodex/1.0.0'
      }
    };

    this.logger.logModule(this.id, 'http-client-initialized', {
      baseUrl: providerConfig.baseUrl,
      timeout: this.httpClient.timeout
    });
  }

  /**
   * Prepare request for provider API
   */
  private prepareRequest(request: SharedPipelineRequest | UnknownObject): UnknownObject {
    const providerConfig = this.config.config as ProviderConfig;

    const payload: UnknownObject = this.isSharedPipelineRequest(request)
      ? ((request as SharedPipelineRequest).data as UnknownObject)
      : ((request as UnknownObject) || {});

    const providerRequest: UnknownObject = {
      ...payload,
      _metadata: {
        provider: this.providerType,
        timestamp: Date.now()
      }
    };

    if (providerConfig.compatibility?.enabled) {
      return this.applyCompatibilityTransformations(providerRequest);
    }

    return providerRequest;
  }

  /**
   * Apply compatibility transformations
   */
  private applyCompatibilityTransformations(request: UnknownObject): UnknownObject {
    // Would apply provider-specific compatibility transformations
    return request;
  }

  /**
   * Send HTTP request to provider API
   */
  private async sendHttpRequest(request: UnknownObject): Promise<ProviderResponse> {
    const startTime = Date.now();
    const endpoint = this.getEndpoint();

    try {
      // Prepare headers with authentication
      const headers = this.prepareHeaders();

      // Would make actual HTTP request here
      const response = await this.simulateHttpRequest(endpoint, request, headers);

      const processingTime = Date.now() - startTime;

      return {
        data: response.data,
        status: response.status,
        headers: response.headers,
        metadata: {
          requestId: `req-${Date.now()}`,
          processingTime,
          model: (request as { model?: string }).model || 'unknown'
        }
      };

    } catch (error) {
      throw createProviderError(error, 'network');
    }
  }

  /**
   * Prepare request headers
   */
  private prepareHeaders(): Record<string, string> {
    return buildAuthHeaders(this.authContext, this.httpClient?.headers ?? {});
  }

  /**
   * Process provider response
   */
  private processResponse(response: ProviderResponse): UnknownObject {
    return {
      ...response.data,
      _providerMetadata: {
        provider: this.providerType,
        processingTime: response.metadata?.processingTime,
        timestamp: Date.now()
      }
    };
  }

  /**
   * Get API endpoint
   */
  private getEndpoint(): string {
    const providerConfig = this.config.config as ProviderConfig;
    return `${providerConfig.baseUrl}/v1/chat/completions`;
  }

  /**
   * Perform health check
   */
  private async performHealthCheck(): Promise<{ isHealthy: boolean; details: Record<string, unknown> }> {
    try {
      const isHealthy = this.authContext !== null;

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
    const providerError = createProviderError(error, 'unknown');

    this.logger.logModule(this.id, 'provider-error', {
      error: providerError,
      request: {
        model: this.extractModel(request),
        hasMessages: this.extractHasMessages(request)
      }
    });

    // Would integrate with error handling center
    if (this.dependencies.errorHandlingCenter) {
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
  }

  /**
   * Create provider error
   */
  // Provider error logic centralized in shared helpers

  /**
   * Simulate HTTP request (for development)
   */
  private async simulateHttpRequest(
    endpoint: string,
    request: UnknownObject,
    _headers: Record<string, string>
  ): Promise<SimulatedHttpResponse> {
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 50));

    return {
      data: {
        id: `chat-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: (request as { model?: string }).model || 'unknown',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: `This is a simulated response from ${this.providerType} provider.`
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 10,
          total_tokens: 20
        }
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-request-id': `req-${Date.now()}`
      }
    };
  }

  /**
   * Close HTTP client
   */
  private async closeHttpClient(): Promise<void> {
    this.httpClient = null;
  }

  /**
   * Initialize debug enhancements
   */
  private initializeDebugEnhancements(): void {
    try {
      this.debugEventBus = DebugEventBus.getInstance();
      this.isDebugEnhanced = true;
      console.log('Generic HTTP Provider debug enhancements initialized');
    } catch (error) {
      console.warn('Failed to initialize Generic HTTP Provider debug enhancements:', error);
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
  private addToRequestHistory(request: UnknownObject): void {
    this.requestHistory.push(request);

    // Keep only recent history
    if (this.requestHistory.length > this.maxHistorySize) {
      this.requestHistory.shift();
    }
  }

  /**
   * Add to error history
   */
  private addToErrorHistory(error: UnknownObject): void {
    this.errorHistory.push(error);

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
        moduleId: this.id,
        operationId: type,
        timestamp: Date.now(),
        type: "start",
        position: 'middle',
        data: {
          ...data,
          providerId: this.id,
          source: 'generic-http-provider'
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
      providerId: this.id,
      type: this.type,
      providerType: this.providerType,
      isInitialized: this.isInitialized,
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
      errorHistory: [...this.errorHistory.slice(-10)] // Last 10 errors
    };
  }

  /**
   * Get detailed debug information
   */
  private getDebugInfo(): UnknownObject {
    return {
      providerId: this.id,
      providerType: this.providerType,
      enhanced: this.isDebugEnhanced,
      eventBusAvailable: !!this.debugEventBus,
      requestHistorySize: this.requestHistory.length,
      errorHistorySize: this.errorHistory.length,
      hasAuth: !!this.authContext,
      hasHttpClient: !!this.httpClient
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
   * Get module debug info - helper method for consistency
   */
  getModuleDebugInfo(): UnknownObject {
    return this.getDebugInfo();
  }

  /**
   * Check if module is initialized - helper method for consistency
   */
  isModuleInitialized(): boolean {
    return this.isInitialized;
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
}
