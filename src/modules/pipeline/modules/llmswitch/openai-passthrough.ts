/**
 * OpenAI Passthrough LLMSwitch Implementation
 *
 * Provides OpenAI protocol passthrough functionality with metadata support.
 * This implementation simply passes through the request/response while adding
 * pipeline metadata for tracking and debugging.
 */

import type { LLMSwitchModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';

/**
 * OpenAI Passthrough LLMSwitch Module
 */
export class OpenAIPassthroughLLMSwitch implements LLMSwitchModule {
  readonly id: string;
  readonly type = 'openai-passthrough';
  readonly protocol = 'openai';
  readonly config: ModuleConfig;

  private isInitialized = false;
  private logger: PipelineDebugLogger;

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.id = `llmswitch-${Date.now()}`;
    this.config = config;
    this.logger = dependencies.logger as any;
  }

  /**
   * Initialize the module
   */
  async initialize(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'initializing', {
        config: this.config
      });

      // Validate configuration
      this.validateConfig();

      this.isInitialized = true;
      this.logger.logModule(this.id, 'initialized');

    } catch (error) {
      this.logger.logModule(this.id, 'initialization-error', { error });
      throw error;
    }
  }

  /**
   * Process incoming request - OpenAI passthrough
   */
  async processIncoming(request: any): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('OpenAI Passthrough LLMSwitch is not initialized');
    }

    try {
      // For OpenAI passthrough, we simply pass through the request
      // but add metadata for tracking
      const transformedRequest = {
        ...request,
        _metadata: {
          switchType: 'openai-passthrough',
          timestamp: Date.now(),
          originalProtocol: 'openai',
          targetProtocol: 'openai'
        }
      };

      this.logger.logTransformation(this.id, 'llmswitch-request-transform', request, transformedRequest);

      return transformedRequest;

    } catch (error) {
      this.logger.logModule(this.id, 'request-transform-error', { error, request });
      throw error;
    }
  }

  /**
   * Process outgoing response - OpenAI passthrough
   */
  async processOutgoing(response: any): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('OpenAI Passthrough LLMSwitch is not initialized');
    }

    try {
      // For OpenAI passthrough, we pass through the response
      // but ensure metadata is preserved/updated
      const transformedResponse = {
        ...response,
        _metadata: {
          ...response._metadata,
          switchType: 'openai-passthrough',
          responseTimestamp: Date.now(),
          processedBy: 'llmswitch'
        }
      };

      this.logger.logTransformation(this.id, 'llmswitch-response-transform', response, transformedResponse);

      return transformedResponse;

    } catch (error) {
      this.logger.logModule(this.id, 'response-transform-error', { error, response });
      throw error;
    }
  }

  /**
   * Transform request to target protocol
   */
  async transformRequest(request: any): Promise<any> {
    return this.processIncoming(request);
  }

  /**
   * Transform response from target protocol
   */
  async transformResponse(response: any): Promise<any> {
    return this.processOutgoing(response);
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'cleanup-start');

      // Reset state
      this.isInitialized = false;

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
    protocol: string;
    isInitialized: boolean;
    lastActivity: number;
  } {
    return {
      id: this.id,
      type: this.type,
      protocol: this.protocol,
      isInitialized: this.isInitialized,
      lastActivity: Date.now()
    };
  }

  /**
   * Validate module configuration
   */
  private validateConfig(): void {
    if (!this.config.type || this.config.type !== 'openai-passthrough') {
      throw new Error('Invalid LLMSwitch type configuration');
    }

    if (!this.config.config) {
      throw new Error('LLMSwitch configuration is required');
    }

    // Log configuration validation
    this.logger.logModule(this.id, 'config-validation-success', {
      type: this.config.type,
      configKeys: Object.keys(this.config.config)
    });
  }

  /**
   * Extract request metadata for logging
   */
  private extractRequestMetadata(request: any): Record<string, any> {
    const metadata: Record<string, any> = {
      timestamp: Date.now(),
      hasModel: !!request.model,
      hasMessages: !!request.messages,
      hasTools: !!request.tools,
      hasStream: !!request.stream,
      messageCount: request.messages?.length || 0,
      toolCount: request.tools?.length || 0
    };

    // Add model information if available
    if (request.model) {
      metadata.model = request.model;
    }

    // Add request type inference
    if (request.messages) {
      metadata.requestType = 'chat';
    } else if (request.prompt) {
      metadata.requestType = 'completion';
    } else if (request.input) {
      metadata.requestType = 'embedding';
    }

    return metadata;
  }

  /**
   * Extract response metadata for logging
   */
  private extractResponseMetadata(response: any): Record<string, any> {
    const metadata: Record<string, any> = {
      timestamp: Date.now(),
      hasChoices: !!response.choices,
      hasUsage: !!response.usage,
      choiceCount: response.choices?.length || 0
    };

    // Add usage information if available
    if (response.usage) {
      metadata.usage = {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens
      };
    }

    // Add response type inference
    if (response.choices) {
      metadata.responseType = 'chat';
    } else if (response.data) {
      metadata.responseType = 'embedding';
    } else if (response.text) {
      metadata.responseType = 'completion';
    }

    return metadata;
  }

  /**
   * Add performance tracking metadata
   */
  private addPerformanceMetadata(data: any, operation: string): any {
    return {
      ...data,
      _performance: {
        ...(data._performance || {}),
        [operation]: {
          timestamp: Date.now(),
          operation,
          moduleId: this.id
        }
      }
    };
  }
}