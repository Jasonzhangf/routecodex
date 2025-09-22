/**
 * Streaming Control Workflow Implementation
 *
 * Handles streaming/non-streaming request conversion and response processing.
 * Converts streaming requests to non-streaming for provider compatibility,
 * then converts non-streaming responses back to streaming format.
 */

import type { WorkflowModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';

/**
 * Streaming Control Workflow Module
 */
export class StreamingControlWorkflow implements WorkflowModule {
  readonly id: string;
  readonly type = 'streaming-control';
  readonly workflowType = 'streaming-converter';
  readonly config: ModuleConfig;

  private isInitialized = false;
  private logger: PipelineDebugLogger;

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.id = `workflow-${Date.now()}`;
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
   * Process incoming request - Handle streaming conversion
   */
  async processIncoming(request: any): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('Streaming Control Workflow is not initialized');
    }

    try {
      const originalStream = request.stream;
      let transformedRequest = { ...request };

      // If streaming request, convert to non-streaming for provider
      if (originalStream === true) {
        transformedRequest = this.convertStreamingToNonStreaming(request);
        this.logger.logTransformation(this.id, 'streaming-to-non-streaming', request, transformedRequest);
      } else {
        this.logger.logModule(this.id, 'non-streaming-request', {
          hasStream: originalStream
        });
      }

      return transformedRequest;

    } catch (error) {
      this.logger.logModule(this.id, 'request-process-error', { error, request });
      throw error;
    }
  }

  /**
   * Process outgoing response - Handle streaming response conversion
   */
  async processOutgoing(response: any): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('Streaming Control Workflow is not initialized');
    }

    try {
      // Check if original request was streaming
      const originalStream = response.originalStream;
      let transformedResponse = { ...response };

      // If original request was streaming, convert response back to streaming
      if (originalStream === true) {
        transformedResponse = this.convertNonStreamingToStreaming(response);
        this.logger.logTransformation(this.id, 'non-streaming-to-streaming', response, transformedResponse);
      } else {
        this.logger.logModule(this.id, 'non-streaming-response', {
          hasOriginalStream: originalStream
        });
      }

      return transformedResponse;

    } catch (error) {
      this.logger.logModule(this.id, 'response-process-error', { error, response });
      throw error;
    }
  }

  /**
   * Process streaming control
   */
  async processStreamingControl(request: any): Promise<any> {
    return this.processIncoming(request);
  }

  /**
   * Handle streaming response
   */
  async handleStreamingResponse(response: any): Promise<any> {
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
    workflowType: string;
    isInitialized: boolean;
    lastActivity: number;
  } {
    return {
      id: this.id,
      type: this.type,
      workflowType: this.workflowType,
      isInitialized: this.isInitialized,
      lastActivity: Date.now()
    };
  }

  /**
   * Convert streaming request to non-streaming
   */
  private convertStreamingToNonStreaming(request: any): any {
    const converted = {
      ...request,
      stream: false, // Set to false for provider
      originalStream: true, // Mark original as streaming
      _streamingMetadata: {
        originalRequest: true,
        convertedAt: Date.now(),
        workflowId: this.id
      }
    };

    // Handle streaming-specific parameter conversions
    if (request.stream_options) {
      converted._originalStreamOptions = request.stream_options;
      delete converted.stream_options;
    }

    return converted;
  }

  /**
   * Convert non-streaming response to streaming
   */
  private convertNonStreamingToStreaming(response: any): any {
    // Create streaming format response
    const streamingResponse = {
      ...response,
      stream: true, // Set back to true
      originalStream: true, // Preserve original flag
      _streamingMetadata: {
        ...response._streamingMetadata,
        responseConverted: true,
        convertedAt: Date.now(),
        workflowId: this.id
      }
    };

    // Convert regular response to streaming format
    if (response.choices && response.choices.length > 0) {
      streamingResponse.choices = response.choices.map((choice: any, index: number) => ({
        index,
        delta: {
          content: choice.message?.content || '',
          role: choice.message?.role || 'assistant'
        },
        finish_reason: choice.finish_reason,
        logprobs: choice.logprobs
      }));
    }

    // Handle usage information in streaming context
    if (response.usage) {
      streamingResponse._usage = response.usage;
      delete streamingResponse.usage; // Remove from main response for streaming format
    }

    // Restore original stream options if they existed
    if (response._originalStreamOptions) {
      streamingResponse.stream_options = response._originalStreamOptions;
      delete streamingResponse._originalStreamOptions;
    }

    return streamingResponse;
  }

  /**
   * Validate module configuration
   */
  private validateConfig(): void {
    if (!this.config.type || this.config.type !== 'streaming-control') {
      throw new Error('Invalid Workflow type configuration');
    }

    if (!this.config.config) {
      throw new Error('Workflow configuration is required');
    }

    // Set default configuration values
    const config = this.config.config;
    config.enableStreaming = config.enableStreaming ?? true;
    config.bufferSize = config.bufferSize ?? 1024;
    config.timeout = config.timeout ?? 30000;

    this.logger.logModule(this.id, 'config-validation-success', {
      type: this.config.type,
      enableStreaming: config.enableStreaming,
      bufferSize: config.bufferSize,
      timeout: config.timeout
    });
  }

  /**
   * Extract streaming metadata for debugging
   */
  private extractStreamingMetadata(request: any): Record<string, any> {
    return {
      hasStream: !!request.stream,
      hasStreamOptions: !!request.stream_options,
      hasOriginalStream: !!request.originalStream,
      hasStreamingMetadata: !!request._streamingMetadata,
      timestamp: Date.now()
    };
  }

  /**
   * Create streaming chunk from regular response
   */
  private createStreamingChunk(content: string, isFinal: boolean = false): any {
    return {
      id: `chunk-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'unknown', // Will be filled in by actual response
      choices: [
        {
          index: 0,
          delta: {
            content: content
          },
          finish_reason: isFinal ? 'stop' : null
        }
      ]
    };
  }

  /**
   * Simulate streaming response from complete response
   */
  private simulateStreamingResponse(response: any): any {
    const content = response.choices?.[0]?.message?.content || '';
    const chunks = this.splitContentIntoChunks(content);

    return {
      ...response,
      stream: true,
      _simulatedStreaming: true,
      _chunks: chunks,
      _currentChunk: 0
    };
  }

  /**
   * Split content into streaming chunks
   */
  private splitContentIntoChunks(content: string): string[] {
    const chunks: string[] = [];
    const chunkSize = 50; // characters per chunk

    for (let i = 0; i < content.length; i += chunkSize) {
      chunks.push(content.slice(i, i + chunkSize));
    }

    return chunks;
  }

  /**
   * Handle streaming-specific errors
   */
  private handleStreamingError(error: any, context: string): void {
    const errorInfo = {
      context,
      error: error.message,
      stack: error.stack,
      timestamp: Date.now()
    };

    this.logger.logModule(this.id, 'streaming-error', errorInfo);

    // Re-throw with additional context
    throw new Error(`Streaming error in ${context}: ${error.message}`);
  }
}