/**
 * 简化的LM Studio Provider - 只做HTTP请求，不做任何转换
 */

import type { ProviderModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { ProviderConfig, AuthContext, ProviderResponse, ProviderError } from '../../types/provider-types.js';
import type { UnknownObject } from '../../../../types/common-types.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';
import { DebugEventBus } from "rcc-debugcenter";

/**
 * 简化的LM Studio Provider - 标准HTTP服务器
 */
export class LMStudioProviderSimple implements ProviderModule {
  readonly id: string;
  readonly type = 'lmstudio-http';
  readonly providerType = 'lmstudio';
  readonly config: ModuleConfig;

  private isInitialized = false;
  private logger: PipelineDebugLogger;
  private authContext: AuthContext | null = null;
  private baseUrl: string;
  private headers: Record<string, string> = {};

  // Debug enhancement properties
  private debugEventBus: DebugEventBus | null = null;
  private isDebugEnhanced = false;
  private providerMetrics: Map<string, { values: any[]; lastUpdated: number }> = new Map();
  private requestHistory: UnknownObject[] = [];
  private errorHistory: UnknownObject[] = [];
  private maxHistorySize = 50;

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.id = `provider-${Date.now()}`;
    this.config = config;
    this.logger = dependencies.logger as PipelineDebugLogger;
    const providerConfig = this.config.config as ProviderConfig;
    this.baseUrl = providerConfig.baseUrl || 'http://localhost:1234';

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
      console.log('LM Studio Provider Simple debug enhancements initialized');
    } catch (error) {
      console.warn('Failed to initialize LM Studio Provider Simple debug enhancements:', error);
      this.isDebugEnhanced = false;
    }
  }

  /**
   * Record provider metric
   */
  private recordProviderMetric(operation: string, data: any): void {
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
        moduleId: 'lmstudio-provider-simple',
        operationId: type,
        timestamp: Date.now(),
        type: "start",
        position: 'middle',
        data: {
          ...data,
          providerId: this.id,
          source: 'lmstudio-provider-simple'
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
      isInitialized: this.isInitialized,
      baseUrl: this.baseUrl,
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
      hasAuth: !!this.authContext
    };
  }

  /**
   * Get provider metrics
   */
  private getProviderMetrics(): Record<string, { count: number; lastUpdated: number; recentValues: any[] }> {
    const metrics: Record<string, { count: number; lastUpdated: number; recentValues: any[] }> = {};

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
   * Initialize the provider
   */
  async initialize(): Promise<void> {
    const startTime = Date.now();
    const initId = `init_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Debug: Record initialization start
    if (this.isDebugEnhanced) {
      this.recordProviderMetric('initialization_start', {
        initId,
        baseUrl: this.baseUrl,
        providerType: this.providerType,
        timestamp: startTime
      });
      this.publishDebugEvent('initialization_start', {
        initId,
        baseUrl: this.baseUrl,
        providerType: this.providerType,
        timestamp: startTime
      });
    }

    try {
      this.logger.logModule(this.id, 'initializing', {
        baseUrl: this.baseUrl,
        providerType: this.providerType
      });

      // Validate configuration
      this.validateConfig();

      // Initialize authentication
      await this.initializeAuth();

      this.isInitialized = true;
      this.logger.logModule(this.id, 'initialized');

      const totalTime = Date.now() - startTime;

      // Debug: Record initialization completion
      if (this.isDebugEnhanced) {
        this.recordProviderMetric('initialization_complete', {
          initId,
          success: true,
          totalTime,
          hasAuth: !!this.authContext
        });
        this.publishDebugEvent('initialization_complete', {
          initId,
          success: true,
          totalTime,
          hasAuth: !!this.authContext
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
        this.addToErrorHistory({
          initId,
          error,
          startTime,
          endTime: Date.now(),
          totalTime,
          operation: 'initialize'
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
   * Process incoming request - 直接发送，不做转换
   */
  async processIncoming(request: UnknownObject): Promise<ProviderResponse> {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    if (!this.isInitialized) {
      throw new Error('LM Studio Provider is not initialized');
    }

    // Debug: Record request processing start
    if (this.isDebugEnhanced) {
      this.recordProviderMetric('request_start', {
        requestId,
        requestType: typeof request,
        hasMessages: !!request.messages,
        hasTools: !!request.tools,
        model: request.model,
        timestamp: startTime
      });
      this.publishDebugEvent('request_start', {
        requestId,
        request,
        timestamp: startTime
      });
    }

    try {
      this.logger.logProviderRequest(this.id, 'request-start', {
        endpoint: `${this.baseUrl}/v1/chat/completions`,
        method: 'POST',
        hasAuth: !!this.authContext,
        hasTools: Array.isArray((request as { tools?: any[] }).tools)
      });

      // Compatibility模块已经处理了所有转换，直接发送请求
      const response = await this.sendChatRequest(request as Record<string, unknown>);

      const totalTime = Date.now() - startTime;

      // Debug: Record request completion
      if (this.isDebugEnhanced) {
        this.recordProviderMetric('request_complete', {
          requestId,
          success: true,
          totalTime,
          responseStatus: response.status,
          hasData: !!response.data,
          tokensUsed: response.metadata?.tokensUsed || 0
        });
        this.addToRequestHistory({
          requestId,
          request,
          response,
          startTime,
          endTime: Date.now(),
          totalTime,
          success: true
        });
        this.publishDebugEvent('request_complete', {
          requestId,
          success: true,
          totalTime,
          response
        });
      }

      this.logger.logProviderRequest(this.id, 'request-success', {
        responseTime: response.metadata?.processingTime,
        status: response.status
      });

      return response;

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
   * Process outgoing response - 直接返回
   */
  async processOutgoing(response: UnknownObject): Promise<UnknownObject> {
    return response;
  }

  /**
   * Send request to provider
   */
  async sendRequest(request: UnknownObject, _options?: any): Promise<ProviderResponse> {
    return this.processIncoming(request);
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

      this.logger.logModule(this.id, 'cleanup-complete');

    } catch (error) {
      this.logger.logModule(this.id, 'cleanup-error', { error });
      throw error;
    }
  }

  /**
   * Get module status
   */
  getStatus(): {
    id: string;
    type: string;
    isInitialized: boolean;
    baseUrl: string;
    lastActivity: number;
  } {
    return {
      id: this.id,
      type: this.type,
      isInitialized: this.isInitialized,
      baseUrl: this.baseUrl,
      lastActivity: Date.now()
    };
  }

  /**
   * Check provider health
   */
  async checkHealth(): Promise<boolean> {
    try {
      const startTime = Date.now();
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this.headers
      });
      const processingTime = Date.now() - startTime;

      this.logger.logModule(this.id, 'health-check', {
        status: response.status,
        processingTime
      });

      return response.ok;
    } catch (error) {
      this.logger.logModule(this.id, 'health-check-error', { error });
      return false;
    }
  }

  /**
   * Validate configuration
   */
  private validateConfig(): void {
    const providerConfig = this.config.config as ProviderConfig;

    if (!providerConfig.baseUrl) {
      throw new Error('LM Studio baseUrl is required');
    }

    if (!providerConfig.auth) {
      throw new Error('LM Studio auth configuration is required');
    }

    this.logger.logModule(this.id, 'config-validation-success', {
      type: this.config.type,
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
    let resolvedApiKey = '';
    if (authConfig?.type === 'apikey') {
      const rawKey = (authConfig as { apiKey?: string }).apiKey;
      if (typeof rawKey === 'string') {
        // Resolve ${ENV} or ${ENV:-default} patterns
        const envMatch = rawKey.match(/^\$\{([^}:]+)(?::-(.*))?}$/);
        if (envMatch) {
          const envName = envMatch[1];
          const def = envMatch[2] || '';
          resolvedApiKey = process.env[envName] || def || '';
        } else if (rawKey.includes('${')) {
          // Unresolved placeholder: treat as empty
          resolvedApiKey = '';
        } else {
          resolvedApiKey = rawKey;
        }
      }
    }

    this.authContext = {
      type: (authConfig?.type as AuthContext['type']) || 'apikey',
      token: resolvedApiKey || '',
      credentials: {
        apiKey: resolvedApiKey || '',
        headerName: 'Authorization',
        prefix: 'Bearer '
      }
    };

    // Prepare headers
    this.headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'RouteCodex/1.0.0'
    };

    if (authConfig?.type === 'apikey' && resolvedApiKey) {
      this.headers['Authorization'] = `Bearer ${resolvedApiKey}`;
    }

    this.logger.logModule(this.id, 'auth-initialized', {
      type: (authConfig?.type as string) || 'apikey',
      hasToken: !!authConfig.apiKey
    });
  }

  /**
   * Send chat request to LM Studio
   */
  private async sendChatRequest(request: Record<string, unknown>): Promise<ProviderResponse> {
    const startTime = Date.now();
    const httpRequestId = `http_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const endpoint = `${this.baseUrl}/v1/chat/completions`;

    // Debug: Record HTTP request start
    if (this.isDebugEnhanced) {
      this.recordProviderMetric('http_request_start', {
        httpRequestId,
        endpoint,
        model: request?.model,
        hasTools: !!request.tools,
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
      // Make HTTP request using fetch
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(request)
      });

      if (!response.ok) {
        const errorText = await response.text();

        // Debug: Record HTTP request failure
        if (this.isDebugEnhanced) {
          this.recordProviderMetric('http_request_failed', {
            httpRequestId,
            status: response.status,
            error: errorText,
            processingTime: Date.now() - startTime
          });
          this.addToErrorHistory({
            httpRequestId,
            error: new Error(`LM Studio API error: ${response.status} ${response.statusText} - ${errorText}`),
            request,
            startTime,
            endTime: Date.now(),
            processingTime: Date.now() - startTime,
            operation: 'sendChatRequest'
          });
          this.publishDebugEvent('http_request_failed', {
            httpRequestId,
            status: response.status,
            error: errorText,
            processingTime: Date.now() - startTime
          });
        }

        throw new Error(`LM Studio API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const responseData = await response.json();
      const processingTime = Date.now() - startTime;

      // Debug: Record HTTP request success
      if (this.isDebugEnhanced) {
        this.recordProviderMetric('http_request_complete', {
          httpRequestId,
          success: true,
          processingTime,
          status: response.status,
          tokensUsed: responseData.usage?.total_tokens || 0,
          hasChoices: !!responseData.choices,
          choiceCount: responseData.choices?.length || 0
        });
        this.publishDebugEvent('http_request_complete', {
          httpRequestId,
          success: true,
          processingTime,
          response: responseData,
          status: response.status
        });
      }

      // Return standardized response format
      return {
        data: responseData,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        metadata: {
          requestId: `req-${Date.now()}`,
          processingTime,
          tokensUsed: responseData.usage?.total_tokens || 0,
          model: responseData.model
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

      const providerError = this.createProviderError(error);
      throw providerError;
    }
  }

  /**
   * Handle provider errors
   */
  private async handleProviderError(error: any, request: any): Promise<void> {
    const providerError = this.createProviderError(error);
    await this.dependencies.errorHandlingCenter.handleError(providerError, {
      module: this.id,
      action: 'processIncoming',
      request
    });
  }

  /**
   * Create provider error
   */
  private createProviderError(error: any): ProviderError {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    const providerError: ProviderError = new Error(errorObj.message) as ProviderError;
    providerError.type = 'network';
    const errLike = error as { statusCode?: number; details?: Record<string, unknown> };
    providerError.statusCode = errLike?.statusCode || 500;
    providerError.details = (errLike?.details as Record<string, unknown> | undefined) ?? {};
    providerError.retryable = this.isRetryableError(error);

    return providerError;
  }

  /**
   * Check if error is retryable
   */
  private isRetryableError(error: any): boolean {
    const errLike = error as { statusCode?: number; code?: string };
    if (!errLike?.statusCode && !errLike?.code) {return false;}
    return (typeof errLike.statusCode === 'number' && (errLike.statusCode >= 500 || errLike.statusCode === 429))
      || errLike.code === 'ECONNREFUSED'
      || errLike.code === 'ETIMEDOUT';
  }
}
