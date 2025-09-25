/**
 * Pass-Through Provider
 * Simple provider that forwards requests to a target server without complex logic
 */

import { BaseProvider, type ProviderResponse } from './base-provider.js';
import { DebugEventBus } from 'rcc-debugcenter';
import { ErrorHandlingCenter, type ErrorContext } from 'rcc-errorhandling';
import {
  type RequestContext,
  type ResponseContext,
  type OpenAIChatCompletionRequest,
  type OpenAICompletionRequest,
  type OpenAIModel,
  type OpenAICompletionResponse,
  type ProviderHealth,
  type ProviderStats,
  type StreamOptions,
  RouteCodexError
} from '../server/types.js';
import { UnimplementedModuleFactory } from '../modules/unimplemented-module-factory.js';

/**
 * Pass-Through Provider configuration interface
 */
export interface PassThroughProviderConfig {
  targetUrl: string;
  timeout?: number;
  headers?: Record<string, string>;
  apiKey?: string;
  retryAttempts?: number;
  enableHealthCheck?: boolean;
}

/**
 * Pass-Through Provider class
 * Forwards requests to a target server with minimal processing
 */
export class PassThroughProvider extends BaseProvider {
  private passThroughConfig: PassThroughProviderConfig;
  private streamingModule: any; // RCCUnimplementedModule instance for streaming functionality

  constructor(config: PassThroughProviderConfig) {
    // Create a provider config that BaseProvider expects
    const providerConfig = {
      id: 'pass-through-provider',
      type: 'pass-through' as const,
      enabled: true,
      baseUrl: config.targetUrl,
      models: {
        'gpt-3.5-turbo': {
          id: 'gpt-3.5-turbo',
          maxTokens: 4096,
          enabled: true
        },
        'gpt-4': {
          id: 'gpt-4',
          maxTokens: 8192,
          enabled: true
        }
      }
    };

    super(providerConfig);

    this.passThroughConfig = {
      timeout: 30000,
      retryAttempts: 3,
      enableHealthCheck: true,
      ...config
    };
  }

  /**
   * Initialize the pass-through provider
   */
  public async initialize(): Promise<void> {
    try {
      await super.initialize();

      // Validate target URL
      if (!this.passThroughConfig.targetUrl) {
        throw new Error('Target URL is required for pass-through provider');
      }

      // Test connectivity to target
      if (this.passThroughConfig.enableHealthCheck) {
        await this.testConnectivity();
      }

      // Initialize unimplemented module for streaming functionality
      const unimplementedFactory = UnimplementedModuleFactory.getInstance();
      this.streamingModule = await unimplementedFactory.createModule({
        moduleId: 'streaming-handler',
        moduleName: 'Streaming Handler',
        maxCallerHistory: 50,
        logLevel: 'info'
      });

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.getModuleInfo().id,
        operationId: 'pass_through_provider_initialized',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          targetUrl: this.passThroughConfig.targetUrl,
          timeout: this.passThroughConfig.timeout,
          retryAttempts: this.passThroughConfig.retryAttempts
        }
      });

    } catch (error) {
      await this.handleError(error as Error, 'initialization');
      throw error;
    }
  }

  /**
   * Process chat completion request (pass-through)
   */
  public async processChatCompletion(
    request: OpenAIChatCompletionRequest,
    options?: { timeout?: number; retryAttempts?: number; apiKey?: string }
  ): Promise<ProviderResponse> {
    const startTime = Date.now();

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.getModuleInfo().id,
        operationId: 'chat_completion_request_start',
        timestamp: startTime,
        type: 'start',
        position: 'middle',
        data: {
          model: request.model,
          messageCount: request.messages?.length || 0,
          targetUrl: this.passThroughConfig.targetUrl
        }
      });

      // Extract API key from options if available
      const apiKey = options?.apiKey;

      // Create a minimal context for forwarding
      const context: RequestContext = {
        id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: startTime,
        method: 'POST',
        url: '/chat/completions',
        headers: apiKey ? { 'authorization': `Bearer ${apiKey}` } : {},
        body: request
      };

      // Forward request to target server
      const response = await this.forwardRequest('/chat/completions', request, context);

      const duration = Date.now() - startTime;
      this.updateStats(true, duration, response.usage?.totalTokens);

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.getModuleInfo().id,
        operationId: 'chat_completion_request_end',
        timestamp: Date.now(),
        type: 'end',
        position: 'middle',
        data: {
          duration,
          status: 200,
          model: request.model
        }
      });

      return this.createResponse(
        true,
        response,
        undefined,
        200,
        { 'Content-Type': 'application/json' },
        duration,
        response.usage
      );

    } catch (error) {
      const duration = Date.now() - startTime;
      this.updateStats(false, duration);
      await this.handleError(error as Error, 'chat_completion');

      return this.createResponse(
        false,
        undefined,
        error instanceof Error ? error.message : String(error),
        500,
        undefined,
        duration
      );
    }
  }

  /**
   * Process completion request (pass-through)
   */
  public async processCompletion(
    request: OpenAICompletionRequest,
    options?: { timeout?: number; retryAttempts?: number }
  ): Promise<ProviderResponse> {
    const startTime = Date.now();

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.getModuleInfo().id,
        operationId: 'completion_request_start',
        timestamp: startTime,
        type: 'start',
        position: 'middle',
        data: {
          model: request.model,
          promptLength: Array.isArray(request.prompt) ? request.prompt.length : request.prompt?.length || 0,
          targetUrl: this.passThroughConfig.targetUrl
        }
      });

      // Create a minimal context for forwarding
      const context: RequestContext = {
        id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: startTime,
        method: 'POST',
        url: '/completions',
        headers: {},
        body: request
      };

      // Forward request to target server
      const response = await this.forwardRequest('/completions', request, context);

      const duration = Date.now() - startTime;
      this.updateStats(true, duration, response.usage?.totalTokens);

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.getModuleInfo().id,
        operationId: 'completion_request_end',
        timestamp: Date.now(),
        type: 'end',
        position: 'middle',
        data: {
          duration,
          status: 200,
          model: request.model
        }
      });

      return this.createResponse(
        true,
        response,
        undefined,
        200,
        { 'Content-Type': 'application/json' },
        duration,
        response.usage
      );

    } catch (error) {
      const duration = Date.now() - startTime;
      this.updateStats(false, duration);
      await this.handleError(error as Error, 'completion');

      return this.createResponse(
        false,
        undefined,
        error instanceof Error ? error.message : String(error),
        500,
        undefined,
        duration
      );
    }
  }

  /**
   * Process streaming chat completion
   */
  public async processStreamingChatCompletion(
    request: OpenAIChatCompletionRequest,
    options: StreamOptions
  ): Promise<ProviderResponse> {
    const startTime = Date.now();

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.getModuleInfo().id,
        operationId: 'streaming_chat_completion_start',
        timestamp: startTime,
        type: 'start',
        position: 'middle',
        data: {
          model: request.model,
          targetUrl: this.passThroughConfig.targetUrl
        }
      });

      // Use RCCUnimplementedModule for streaming functionality
      const streamingResult = await this.streamingModule.callUnderConstructionFeature('streaming-chat-completion', {
        caller: 'PassThroughProvider.processStreamingChatCompletion',
        parameters: {
          model: request.model,
          messages: request.messages,
          targetUrl: this.passThroughConfig.targetUrl
        },
        purpose: 'Streaming chat completion via pass-through provider'
      });

      const duration = Date.now() - startTime;
      this.updateStats(true, duration);

      return this.createResponse(
        true,
        {
          streaming: true,
          chunks: streamingResult.chunks || ['Streaming response processed by unimplemented module'],
          moduleId: this.streamingModule.getModuleInfo().id
        },
        undefined,
        200,
        { 'Content-Type': 'text/event-stream' },
        duration
      );

    } catch (error) {
      const duration = Date.now() - startTime;
      this.updateStats(false, duration);
      await this.handleError(error as Error, 'streaming_chat_completion');

      return this.createResponse(
        false,
        undefined,
        error instanceof Error ? error.message : String(error),
        500,
        undefined,
        duration
      );
    }
  }

  /**
   * Get models from target server
   */
  public async getModels(): Promise<OpenAIModel[]> {
    // Use the BaseProvider getModels method for now
    return await super.getModels();
  }

  /**
   * Get specific model from target server
   */
  public async getModel(modelId: string): Promise<OpenAIModel> {
    const startTime = Date.now();

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.getModuleInfo().id,
        operationId: 'model_request_start',
        timestamp: startTime,
        type: 'start',
        position: 'middle',
        data: {
          modelId,
          targetUrl: this.passThroughConfig.targetUrl
        }
      });

      const context: RequestContext = {
        id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: startTime,
        method: 'GET',
        url: `/models/${modelId}`,
        headers: {},
        body: {}
      };

      const response = await this.forwardRequest(`/models/${modelId}`, null, context);

      const duration = Date.now() - startTime;
      this.updateStats(true, duration);

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.getModuleInfo().id,
        operationId: 'model_request_end',
        timestamp: Date.now(),
        type: 'end',
        position: 'middle',
        data: {
          modelId,
          duration
        }
      });

      return response;

    } catch (error) {
      const duration = Date.now() - startTime;
      this.updateStats(false, duration);
      await this.handleError(error as Error, 'model');

      // Return fallback model if target is unavailable
      return {
        id: modelId,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'openai'
      };
    }
  }

  /**
   * Process embeddings request (pass-through)
   */
  public async processEmbeddings(request: any, context: RequestContext): Promise<any> {
    const startTime = Date.now();
    this.stats.totalRequests++;

    try {
      const response = await this.forwardRequest('/embeddings', request, context);
      const duration = Date.now() - startTime;
      this.updateStats(true, duration);
      return response;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.updateStats(false, duration);
      await this.handleError(error as Error, 'embeddings');
      throw error;
    }
  }

  /**
   * Process moderations request (pass-through)
   */
  public async processModerations(request: any, context: RequestContext): Promise<any> {
    const startTime = Date.now();
    this.stats.totalRequests++;

    try {
      const response = await this.forwardRequest('/moderations', request, context);
      const duration = Date.now() - startTime;
      this.updateStats(true, duration);
      return response;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.updateStats(false, duration);
      await this.handleError(error as Error, 'moderations');
      throw error;
    }
  }

  /**
   * Process image generations request (pass-through)
   */
  public async processImageGenerations(request: any, context: RequestContext): Promise<any> {
    const startTime = Date.now();
    this.stats.totalRequests++;

    try {
      const response = await this.forwardRequest('/images/generations', request, context);
      const duration = Date.now() - startTime;
      this.updateStats(true, duration);
      return response;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.updateStats(false, duration);
      await this.handleError(error as Error, 'image_generations');
      throw error;
    }
  }

  /**
   * Process audio transcriptions request (pass-through)
   */
  public async processAudioTranscriptions(request: any, context: RequestContext): Promise<any> {
    const startTime = Date.now();
    this.stats.totalRequests++;

    try {
      const response = await this.forwardRequest('/audio/transcriptions', request, context);
      const duration = Date.now() - startTime;
      this.updateStats(true, duration);
      return response;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.updateStats(false, duration);
      await this.handleError(error as Error, 'audio_transcriptions');
      throw error;
    }
  }

  /**
   * Process audio translations request (pass-through)
   */
  public async processAudioTranslations(request: any, context: RequestContext): Promise<any> {
    const startTime = Date.now();
    this.stats.totalRequests++;

    try {
      const response = await this.forwardRequest('/audio/translations', request, context);
      const duration = Date.now() - startTime;
      this.updateStats(true, duration);
      return response;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.updateStats(false, duration);
      await this.handleError(error as Error, 'audio_translations');
      throw error;
    }
  }

  /**
   * Forward request to target server
   */
  private async forwardRequest(
    path: string,
    body: any,
    context: RequestContext
  ): Promise<any> {
    const url = `${this.passThroughConfig.targetUrl}${path}`;
    const startTime = Date.now();

    try {
      // Prepare headers
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'RouteCodex-PassThrough/1.0.0',
        ...this.passThroughConfig.headers
      };

      // Add authorization from original request if available
      const authHeader = context.headers['authorization'] || context.headers['Authorization'];
      if (authHeader) {
        headers['Authorization'] = authHeader;
      }

      // Add API key from original request if available
      const apiKey = context.headers['api-key'] || context.headers['x-api-key'];
      if (apiKey) {
        headers['api-key'] = apiKey;
      }

      // Add API key from provider config if available and no auth header found
      if (!headers['Authorization'] && this.passThroughConfig.apiKey) {
        headers['Authorization'] = `Bearer ${this.passThroughConfig.apiKey}`;
      }

      // Make the HTTP request
      const response = await fetch(url, {
        method: context.method || 'POST',
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.passThroughConfig.timeout || 30000)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Target server returned ${response.status}: ${errorText}`);
      }

      const result = await response.json();
      const duration = Date.now() - startTime;

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.getModuleInfo().id,
        operationId: 'request_forwarded',
        timestamp: Date.now(),
        type: 'end',
        position: 'middle',
        data: {
          url,
          method: context.method,
          status: response.status,
          duration,
          size: JSON.stringify(result).length
        }
      });

      return result;

    } catch (error) {
      const duration = Date.now() - startTime;

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.getModuleInfo().id,
        operationId: 'request_forward_failed',
        timestamp: Date.now(),
        type: 'error',
        position: 'middle',
        data: {
          url,
          method: context.method,
          duration,
          error: error instanceof Error ? error.message : String(error)
        }
      });

      throw error;
    }
  }

  /**
   * Test connectivity to target server
   */
  private async testConnectivity(): Promise<void> {
    try {
      const url = `${this.passThroughConfig.targetUrl}/models`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'RouteCodex-PassThrough/1.0.0'
        },
        signal: AbortSignal.timeout(10000) // Shorter timeout for health check
      });

      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status}`);
      }

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.getModuleInfo().id,
        operationId: 'connectivity_test_success',
        timestamp: Date.now(),
        type: 'end',
        position: 'middle',
        data: {
          url,
          status: response.status
        }
      });

    } catch (error) {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.getModuleInfo().id,
        operationId: 'connectivity_test_failed',
        timestamp: Date.now(),
        type: 'error',
        position: 'middle',
        data: {
          error: error instanceof Error ? error.message : String(error)
        }
      });

      // Don't throw error for health check failures, just log them
      console.warn(`Pass-through provider connectivity test failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Use BaseProvider's implementation for health check
  public async healthCheck(): Promise<ProviderHealth> {
    if (this.passThroughConfig.enableHealthCheck) {
      try {
        await this.testConnectivity();
      } catch (error) {
        await this.handleError(error as Error, 'health_check');
      }
    }
    return await super.healthCheck();
  }

  /**
   * Update pass-through provider configuration
   */
  public async updateConfig(newConfig: Partial<PassThroughProviderConfig>): Promise<void> {
    this.passThroughConfig = { ...this.passThroughConfig, ...newConfig };

    this.debugEventBus.publish({
      sessionId: `session_${Date.now()}`,
      moduleId: this.getModuleInfo().id,
      operationId: 'config_updated',
      timestamp: Date.now(),
      type: 'start',
      position: 'middle',
      data: {
        changes: Object.keys(newConfig)
      }
    });
  }
}