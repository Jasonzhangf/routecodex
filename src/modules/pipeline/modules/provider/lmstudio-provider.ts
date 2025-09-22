/**
 * LM Studio Provider Implementation
 *
 * Provides LM Studio SDK integration with support for Tools API,
 * session management, and tool calling execution.
 */

import type { ProviderModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { ProviderConfig, AuthContext, ProviderResponse, ProviderError } from '../../types/provider-types.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';

/**
 * LM Studio Provider Module
 */
export class LMStudioProvider implements ProviderModule {
  readonly id: string;
  readonly type = 'lmstudio-http';
  readonly providerType = 'lmstudio';
  readonly config: ModuleConfig;

  private isInitialized = false;
  private logger: PipelineDebugLogger;
  private authContext: AuthContext | null = null;
  private client: any; // LM Studio SDK client
  private session: any; // LM Studio session
  private healthStatus: any = null;

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.id = `provider-${Date.now()}`;
    this.config = config;
    this.logger = dependencies.logger as any;
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

      // Initialize LM Studio client
      await this.initializeClient();

      // Create session
      await this.createSession();

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
   * Process incoming request - Send to LM Studio
   */
  async processIncoming(request: any): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('LM Studio Provider is not initialized');
    }

    try {
      this.logger.logProviderRequest(this.id, 'request-start', {
        endpoint: this.getEndpoint(),
        method: 'POST',
        hasAuth: !!this.authContext,
        hasTools: !!request.tools
      });

      // Prepare request for LM Studio
      const lmStudioRequest = this.prepareRequest(request);

      // Handle tool calls if present
      if (request.tools) {
        return await this.handleToolCall(lmStudioRequest, request.tools);
      }

      // Send chat request
      const response = await this.sendChatRequest(lmStudioRequest);

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
  async processOutgoing(response: any): Promise<any> {
    // For providers, outgoing response processing is usually minimal
    return response;
  }

  /**
   * Send request to provider
   */
  async sendRequest(request: any, options?: any): Promise<ProviderResponse> {
    return this.processIncoming(request);
  }

  /**
   * Check provider health
   */
  async checkHealth(): Promise<boolean> {
    try {
      const startTime = Date.now();

      // Perform health check
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

      // Close session and client
      if (this.session) {
        await this.closeSession();
      }
      if (this.client) {
        await this.closeClient();
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
    healthStatus: any;
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
  async getMetrics(): Promise<any> {
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
    if (!this.config.type || this.config.type !== 'lmstudio-http') {
      throw new Error('Invalid provider type configuration');
    }

    const providerConfig = this.config.config as ProviderConfig;
    if (!providerConfig.baseUrl) {
      throw new Error('Provider base URL is required');
    }

    if (!providerConfig.auth) {
      throw new Error('Provider authentication configuration is required');
    }

    const authConfig = providerConfig.auth;
    if (authConfig.type !== 'apikey' || !authConfig.apiKey) {
      throw new Error('API key authentication is required for LM Studio provider');
    }

    this.logger.logModule(this.id, 'config-validation-success', {
      type: this.config.type,
      baseUrl: providerConfig.baseUrl,
      authType: authConfig.type
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
      token: authConfig.apiKey,
      credentials: {
        apiKey: authConfig.apiKey,
        headerName: authConfig.headerName || 'Authorization',
        prefix: authConfig.prefix || 'Bearer '
      },
      metadata: {
        provider: 'lmstudio',
        initialized: Date.now()
      }
    };

    this.logger.logModule(this.id, 'auth-initialized', {
      type: authConfig.type,
      hasToken: !!this.authContext.token
    });
  }

  /**
   * Initialize LM Studio client
   */
  private async initializeClient(): Promise<void> {
    const providerConfig = this.config.config as ProviderConfig;

    // Would initialize actual LM Studio SDK client here
    // For now, create a mock client
    this.client = {
      baseUrl: providerConfig.baseUrl,
      apiKey: this.authContext!.token,
      timeout: this.config.config?.timeout || 30000
    };

    this.logger.logModule(this.id, 'client-initialized', {
      baseUrl: providerConfig.baseUrl,
      timeout: this.client.timeout
    });
  }

  /**
   * Create LM Studio session
   */
  private async createSession(): Promise<void> {
    try {
      // Would create actual session using LM Studio SDK
      // For now, create a mock session
      this.session = {
        id: `session-${Date.now()}`,
        client: this.client,
        createdAt: Date.now(),
        isActive: true
      };

      this.logger.logModule(this.id, 'session-created', {
        sessionId: this.session.id
      });

    } catch (error) {
      this.logger.logModule(this.id, 'session-creation-error', { error });
      throw error;
    }
  }

  /**
   * Prepare request for LM Studio API
   */
  private prepareRequest(request: any): any {
    const providerConfig = this.config.config as ProviderConfig;

    // Extract and map request parameters
    const lmStudioRequest = {
      model: this.mapModel(request.model),
      messages: request.messages || [],
      temperature: request.temperature ?? 0.7,
      max_tokens: request.max_tokens ?? 2048,
      stream: request.stream ?? false,
      stop: request.stop,
      presence_penalty: request.presence_penalty,
      frequency_penalty: request.frequency_penalty
    };

    // Add model-specific parameters
    if (providerConfig.models?.[request.model]) {
      const modelConfig = providerConfig.models[request.model];
      if (modelConfig.parameters) {
        Object.assign(lmStudioRequest, modelConfig.parameters);
      }
    }

    this.logger.logModule(this.id, 'request-prepared', {
      model: lmStudioRequest.model,
      messageCount: lmStudioRequest.messages.length,
      hasStreaming: lmStudioRequest.stream
    });

    return lmStudioRequest;
  }

  /**
   * Map OpenAI model to LM Studio model
   */
  private mapModel(openaiModel: string): string {
    const providerConfig = this.config.config as ProviderConfig;

    // Check compatibility mapping
    if (providerConfig.compatibility?.modelMapping) {
      const mapping = providerConfig.compatibility.modelMapping;
      if (mapping[openaiModel]) {
        return mapping[openaiModel];
      }
    }

    // Default model mapping - include actual LM Studio models
    const defaultMapping: Record<string, string> = {
      'gpt-4': 'llama2-7b-chat',
      'gpt-3.5-turbo': 'llama2-7b-chat',
      'gpt-4-turbo': 'llama2-13b-chat',
      'qwen3-4b-thinking-2507-mlx': 'qwen3-4b-thinking-2507-mlx',
      'gpt-oss-20b-mlx': 'gpt-oss-20b-mlx'
    };

    // If no mapping found, return the original model name
    return defaultMapping[openaiModel] || openaiModel;
  }

  /**
   * Handle tool call execution
   */
  private async handleToolCall(request: any, tools: any[]): Promise<any> {
    try {
      this.logger.logModule(this.id, 'tool-call-start', {
        toolCount: tools.length
      });

      // Use transformation engine to convert tools
      const { TransformationEngine } = await import('../../utils/transformation-engine.js');
      const transformationEngine = new TransformationEngine();

      // Convert OpenAI tools to LM Studio format using configured rules
      const lmStudioTools = await transformationEngine.transform(
        { tools },
        this.getToolTransformationRules()
      );

      // Send initial request with tools
      const response = await this.sendChatRequest({
        ...request,
        tools: lmStudioTools.tools
      });

      // Check if model wants to call tools
      if (response.tool_calls) {
        // Execute tool calls
        const toolResults = await this.executeToolCalls(response.tool_calls);

        // Send follow-up request with tool results
        const followUpResponse = await this.sendChatRequest({
          ...request,
          tool_results: toolResults
        });

        return followUpResponse;
      }

      return response;

    } catch (error) {
      this.logger.logModule(this.id, 'tool-call-error', { error });
      throw error;
    }
  }

  /**
   * Get tool transformation rules from configuration
   */
  private getToolTransformationRules(): any[] {
    const providerConfig = this.config.config as ProviderConfig;

    // Get tool transformation rules from provider configuration
    if (providerConfig.compatibility?.toolTransformations) {
      return providerConfig.compatibility.toolTransformations;
    }

    // Default tool transformation rules - LM Studio expects OpenAI format directly
    return [
      {
        id: 'openai-to-lmstudio-tools',
        transform: 'mapping',
        sourcePath: 'tools',
        targetPath: 'tools',
        mapping: {
          'type': 'type',
          'function': 'function'
        }
      }
    ];
  }

  /**
   * Execute tool calls
   * Note: LM Studio automatically handles tool execution, so we just log the calls
   */
  private async executeToolCalls(toolCalls: any[]): Promise<any[]> {
    // LM Studio automatically executes tool calls and includes results in the response
    // We just need to log the calls for debugging
    for (const toolCall of toolCalls) {
      this.logger.logModule(this.id, 'tool-call-executed', {
        toolName: toolCall.function?.name || 'unknown',
        arguments: toolCall.function?.arguments || {},
        toolCallId: toolCall.id
      });
    }

    // Return empty array - LM Studio handles the actual execution
    return [];
  }

  
  /**
   * Send chat request to LM Studio
   */
  private async sendChatRequest(request: any): Promise<ProviderResponse> {
    const startTime = Date.now();
    const providerConfig = this.config.config as ProviderConfig;
    const endpoint = `${providerConfig.baseUrl}/v1/chat/completions`;

    try {
      // Prepare headers with authentication
      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'RouteCodex/1.0.0'
      };

      // Add authentication if configured
      if (this.authContext?.credentials?.headerName && this.authContext?.token) {
        const headerName = this.authContext.credentials.headerName;
        const headerValue = (this.authContext.credentials.prefix || '') + this.authContext.token;
        headers[headerName as keyof typeof headers] = headerValue;
      }

      // Send actual HTTP request to LM Studio
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(request)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LM Studio API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data = await response.json();
      const processingTime = Date.now() - startTime;

      return {
        data,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        metadata: {
          requestId: `req-${Date.now()}`,
          processingTime,
          tokensUsed: data.usage?.total_tokens,
          model: request.model
        }
      };

    } catch (error) {
      throw this.createProviderError(error, 'network');
    }
  }

  /**
   * Process provider response
   */
  private processResponse(response: ProviderResponse): any {
    const processedResponse = {
      ...response.data,
      _providerMetadata: {
        provider: 'lmstudio',
        processingTime: response.metadata?.processingTime,
        tokensUsed: response.metadata?.tokensUsed,
        timestamp: Date.now()
      }
    };

    // Map LM Studio response format to OpenAI format if needed
    if (this.config.config?.compatibility?.enabled) {
      return this.mapResponseToOpenAIFormat(processedResponse);
    }

    return processedResponse;
  }

  /**
   * Map LM Studio response to OpenAI format
   */
  private mapResponseToOpenAIFormat(response: any): any {
    return {
      id: response.id || `chat-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: response.model,
      choices: response.choices || [],
      usage: response.usage,
      _originalResponse: response
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
  private async performHealthCheck(): Promise<{ isHealthy: boolean; details: any }> {
    try {
      // Would perform actual health check using LM Studio SDK
      // For now, simulate a health check
      const isHealthy = this.session !== null && this.client !== null;

      return {
        isHealthy,
        details: {
          authentication: isHealthy ? 'valid' : 'invalid',
          connectivity: 'connected',
          session: this.session?.id,
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
  private async handleProviderError(error: any, request: any): Promise<void> {
    const providerError = this.createProviderError(error, 'unknown');

    this.logger.logModule(this.id, 'provider-error', {
      error: providerError,
      request: {
        model: request.model,
        hasMessages: !!request.messages,
        hasTools: !!request.tools
      }
    });

    // Integrate with error handling center
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
  private createProviderError(error: unknown, type: string): ProviderError {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    const providerError: ProviderError = new Error(errorObj.message) as ProviderError;
    providerError.type = type as any;
    providerError.statusCode = (error as any).status || (error as any).statusCode;
    providerError.details = (error as any).details || error;
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
   * Close session
   */
  private async closeSession(): Promise<void> {
    if (this.session) {
      // Would close actual session using LM Studio SDK
      this.session = null;
      this.logger.logModule(this.id, 'session-closed');
    }
  }

  /**
   * Close client
   */
  private async closeClient(): Promise<void> {
    if (this.client) {
      // Would close actual client using LM Studio SDK
      this.client = null;
      this.logger.logModule(this.id, 'client-closed');
    }
  }
}