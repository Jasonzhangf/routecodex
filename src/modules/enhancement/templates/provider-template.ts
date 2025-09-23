/**
 * Enhanced Provider Module Template
 *
 * This template shows how to create a provider module with debugging capabilities
 * already integrated using the enhancement system.
 */

import type { ProviderModule, ModuleConfig, ModuleDependencies } from '../../pipeline/interfaces/pipeline-interfaces.js';
import type { ProviderConfig, AuthContext, ProviderResponse, ProviderError } from '../../pipeline/types/provider-types.js';
import { EnhancementConfigManager } from '../enhancement-config-manager.js';
import type { EnhancedModule } from '../module-enhancement-factory.js';

/**
 * Enhanced Provider Module
 *
 * This module demonstrates the recommended pattern for creating provider modules
 * with built-in debugging capabilities using the enhancement system.
 */
export class EnhancedProviderModule implements ProviderModule {
  readonly id: string;
  readonly type = 'enhanced-provider';
  readonly providerType = 'enhanced';
  readonly config: ModuleConfig;

  private isInitialized = false;
  private authContext: AuthContext | null = null;
  private enhancedModule: EnhancedModule<this> | null = null;
  private configManager: EnhancementConfigManager;

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.id = `enhanced-provider-${Date.now()}`;
    this.config = config;

    // Initialize enhancement configuration manager
    this.configManager = new EnhancementConfigManager(
      dependencies.debugCenter,
      config.config?.enhancementConfigPath
    );
  }

  /**
   * Initialize the provider
   */
  async initialize(): Promise<void> {
    try {
      // Create enhanced version of this module
      this.enhancedModule = await this.configManager.enhanceModule(
        this,
        this.id,
        'provider',
        this.config.config?.enhancement
      );

      // Log initialization start
      this.logInfo('initialization-start', {
        providerType: this.providerType,
        config: this.config.config
      });

      // Validate configuration
      this.validateConfig();

      // Initialize authentication
      await this.initializeAuth();

      this.isInitialized = true;
      this.logInfo('initialization-success');

    } catch (error) {
      this.logError('initialization-error', { error });
      throw error;
    }
  }

  /**
   * Process incoming request
   */
  async processIncoming(request: any): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('Enhanced Provider is not initialized');
    }

    try {
      // Log request start
      this.logInfo('request-start', {
        hasAuth: !!this.authContext,
        hasTools: !!request.tools,
        requestSize: JSON.stringify(request).length
      });

      // Process request
      const response = await this.processRequest(request);

      // Log request success
      this.logInfo('request-success', {
        responseTime: response.metadata?.processingTime,
        status: response.status,
        tokensUsed: response.metadata?.tokensUsed
      });

      return response;

    } catch (error) {
      this.logError('request-error', { error, request });
      throw error;
    }
  }

  /**
   * Process outgoing response
   */
  async processOutgoing(response: any): Promise<any> {
    try {
      // Log response processing start
      this.logInfo('response-start', {
        responseSize: JSON.stringify(response).length
      });

      // Process response
      const processedResponse = await this.processResponse(response);

      // Log response processing success
      this.logInfo('response-success', {
        processingTime: processedResponse.metadata?.processingTime
      });

      return processedResponse;

    } catch (error) {
      this.logError('response-error', { error, response });
      throw error;
    }
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
      this.logInfo('cleanup-start');

      // Reset state
      this.isInitialized = false;
      this.authContext = null;

      // Cleanup enhanced module
      if (this.enhancedModule) {
        this.enhancedModule.logger.clearLogs();
      }

      this.logInfo('cleanup-success');

    } catch (error) {
      this.logError('cleanup-error', { error });
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
    providerType: string;
    lastActivity: number;
    enhanced: boolean;
    enhancementTime?: number;
  } {
    return {
      id: this.id,
      type: this.type,
      isInitialized: this.isInitialized,
      providerType: this.providerType,
      lastActivity: Date.now(),
      enhanced: !!this.enhancedModule,
      enhancementTime: this.enhancedModule?.metadata.enhancementTime
    };
  }

  /**
   * Check provider health
   */
  async checkHealth(): Promise<boolean> {
    try {
      const startTime = Date.now();

      // Perform health check
      const isHealthy = await this.performHealthCheck();

      const processingTime = Date.now() - startTime;

      this.logInfo('health-check', {
        status: isHealthy ? 'healthy' : 'unhealthy',
        processingTime
      });

      return isHealthy;
    } catch (error) {
      this.logError('health-check-error', { error });
      return false;
    }
  }

  /**
   * Get debug logs for this module
   */
  getDebugLogs() {
    if (!this.enhancedModule) {
      return {
        general: [],
        transformations: [],
        provider: [],
        statistics: {
          totalLogs: 0,
          logsByLevel: {},
          logsByCategory: {},
          logsByPipeline: {},
          transformationCount: 0,
          providerRequestCount: 0
        }
      };
    }

    return {
      general: this.enhancedModule.logger.getRecentLogs(),
      transformations: this.enhancedModule.logger.getTransformationLogs(),
      provider: this.enhancedModule.logger.getProviderLogs(),
      statistics: this.enhancedModule.logger.getStatistics()
    };
  }

  /**
   * Export logs to file
   */
  exportLogs(format: 'json' | 'csv' = 'json') {
    if (!this.enhancedModule) {
      return { error: 'Module not enhanced' };
    }

    return this.enhancedModule.logger.exportLogs(format);
  }

  /**
   * Validate configuration
   */
  private validateConfig(): void {
    const providerConfig = this.config.config as ProviderConfig;

    if (!providerConfig.baseUrl) {
      throw new Error('Provider baseUrl is required');
    }

    if (!providerConfig.auth) {
      throw new Error('Provider auth configuration is required');
    }

    this.logInfo('config-validation-success', {
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
    const authConfig = providerConfig.auth || { type: 'apikey' };

    // Resolve API key from environment variables
    let resolvedApiKey = '';
    if (authConfig.type === 'apikey' && typeof authConfig.apiKey === 'string') {
      const envMatch = authConfig.apiKey.match(/^\$\{([^}:]+)(?::-(.*))?}$/);
      if (envMatch) {
        const envName = envMatch[1];
        const defaultValue = envMatch[2] || '';
        resolvedApiKey = process.env[envName] || defaultValue || '';
      } else {
        resolvedApiKey = authConfig.apiKey;
      }
    }

    this.authContext = {
      type: authConfig.type,
      token: resolvedApiKey,
      credentials: {
        apiKey: resolvedApiKey,
        headerName: 'Authorization',
        prefix: 'Bearer '
      }
    };

    this.logInfo('auth-initialized', {
      type: authConfig.type,
      hasToken: !!resolvedApiKey
    });
  }

  /**
   * Process request implementation
   */
  private async processRequest(request: any): Promise<ProviderResponse> {
    const startTime = Date.now();

    try {
      // This is where the actual provider request logic would go
      // For example, making HTTP requests to the AI service

      const response = await this.makeProviderRequest(request);
      const processingTime = Date.now() - startTime;

      return {
        data: response,
        status: 200,
        headers: {},
        metadata: {
          requestId: `req-${Date.now()}`,
          processingTime,
          tokensUsed: 0, // Would be calculated from actual response
          model: request.model
        }
      };
    } catch (error) {
      const providerError = this.createProviderError(error);
      throw providerError;
    }
  }

  /**
   * Process response implementation
   */
  private async processResponse(response: any): Promise<any> {
    // This is where response processing logic would go
    // For example, transforming the response format
    return response;
  }

  /**
   * Make actual provider request
   */
  private async makeProviderRequest(request: any): Promise<any> {
    // This would be replaced with actual provider-specific logic
    // For example, fetch requests to the AI service

    // Simulate a response for the template
    return {
      id: `resp-${Date.now()}`,
      object: 'chat.completion',
      choices: [{
        finish_reason: 'stop',
        message: {
          content: 'Enhanced provider response',
          role: 'assistant'
        }
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15
      }
    };
  }

  /**
   * Perform health check
   */
  private async performHealthCheck(): Promise<boolean> {
    // This would be replaced with actual health check logic
    // For example, checking if the provider service is accessible
    return true;
  }

  /**
   * Create provider error
   */
  private createProviderError(error: any): ProviderError {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    const providerError: ProviderError = new Error(errorObj.message) as ProviderError;
    providerError.type = 'network';
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

  /**
   * Log info message
   */
  private logInfo(action: string, data?: any): void {
    if (this.enhancedModule) {
      this.enhancedModule.logger.logModule(this.id, action, data);
    }
  }

  /**
   * Log error message
   */
  private logError(action: string, data?: any): void {
    if (this.enhancedModule) {
      this.enhancedModule.logger.logError(data.error, {
        moduleId: this.id,
        action,
        ...data
      });
    }
  }
}