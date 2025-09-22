/**
 * 简化的LM Studio Provider - 只做HTTP请求，不做任何转换
 */

import type { ProviderModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { ProviderConfig, AuthContext, ProviderResponse, ProviderError } from '../../types/provider-types.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';

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

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.id = `provider-${Date.now()}`;
    this.config = config;
    this.logger = dependencies.logger as any;
    const providerConfig = this.config.config as ProviderConfig;
    this.baseUrl = providerConfig.baseUrl || 'http://localhost:1234';
  }

  /**
   * Initialize the provider
   */
  async initialize(): Promise<void> {
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

    } catch (error) {
      this.logger.logModule(this.id, 'initialization-error', { error });
      throw error;
    }
  }

  /**
   * Process incoming request - 直接发送，不做转换
   */
  async processIncoming(request: any): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('LM Studio Provider is not initialized');
    }

    try {
      this.logger.logProviderRequest(this.id, 'request-start', {
        endpoint: `${this.baseUrl}/v1/chat/completions`,
        method: 'POST',
        hasAuth: !!this.authContext,
        hasTools: !!request.tools
      });

      // Compatibility模块已经处理了所有转换，直接发送请求
      const response = await this.sendChatRequest(request);

      this.logger.logProviderRequest(this.id, 'request-success', {
        responseTime: response.metadata?.processingTime,
        status: response.status
      });

      return response;

    } catch (error) {
      await this.handleProviderError(error, request);
      throw error;
    }
  }

  /**
   * Process outgoing response - 直接返回
   */
  async processOutgoing(response: any): Promise<any> {
    return response;
  }

  /**
   * Send request to provider
   */
  async sendRequest(request: any, options?: any): Promise<ProviderResponse> {
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

    this.authContext = {
      type: authConfig.type,
      token: authConfig.apiKey || '',
      credentials: {
        apiKey: authConfig.apiKey || '',
        headerName: 'Authorization',
        prefix: 'Bearer '
      }
    };

    // Prepare headers
    this.headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'RouteCodex/1.0.0'
    };

    if (authConfig.type === 'apikey' && authConfig.apiKey) {
      this.headers['Authorization'] = `Bearer ${authConfig.apiKey}`;
    }

    this.logger.logModule(this.id, 'auth-initialized', {
      type: authConfig.type,
      hasToken: !!authConfig.apiKey
    });
  }

  /**
   * Send chat request to LM Studio
   */
  private async sendChatRequest(request: any): Promise<ProviderResponse> {
    const startTime = Date.now();
    const endpoint = `${this.baseUrl}/v1/chat/completions`;

    try {
      // Make HTTP request using fetch
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(request)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LM Studio API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const responseData = await response.json();
      const processingTime = Date.now() - startTime;

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
    providerError.type = 'network' as any;
    providerError.statusCode = error.statusCode || 500;
    providerError.details = error;
    providerError.retryable = this.isRetryableError(error);

    return providerError;
  }

  /**
   * Check if error is retryable
   */
  private isRetryableError(error: any): boolean {
    if (!error.statusCode) return false;

    // Retry on 5xx errors, 429 (rate limit), and network errors
    return error.statusCode >= 500 ||
           error.statusCode === 429 ||
           error.code === 'ECONNREFUSED' ||
           error.code === 'ETIMEDOUT';
  }
}