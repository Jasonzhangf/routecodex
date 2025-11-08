/**
 * Streaming Control Workflow Implementation
 *
 * Handles streaming/non-streaming request conversion and response processing.
 * Converts streaming requests to non-streaming for provider compatibility,
 * then leaves responses as non-streaming (no mock streaming back).
 */

import type { WorkflowModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { SharedPipelineRequest } from '../../../../types/shared-dtos.js';
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
  async processIncoming(requestParam: SharedPipelineRequest): Promise<SharedPipelineRequest> {
    if (!this.isInitialized) {
      throw new Error('Streaming Control Workflow is not initialized');
    }

    try {
      const isDto = requestParam && typeof requestParam === 'object' && 'data' in requestParam && 'route' in requestParam;
      const dto = isDto ? (requestParam as SharedPipelineRequest) : null;
      const payload = isDto ? (dto!.data as any) : (requestParam as any);

      const originalStream = payload?.stream;
      let transformedPayload = { ...(payload || {}) };

      // Preserve true streaming for OpenAI Responses endpoint to allow real SSE end-to-end
      const entryEndpoint = String((dto?.metadata as any)?.entryEndpoint || (payload?.metadata as any)?.entryEndpoint || '');
      const isResponses = entryEndpoint === '/v1/responses';

      // If streaming request and NOT /v1/responses, convert to non‑streaming for provider stability
      if (originalStream === true && !isResponses) {
        transformedPayload = this.convertStreamingToNonStreaming(payload);
        this.logger.logTransformation(dto?.route?.requestId || 'unknown', 'streaming-to-non-streaming', payload, transformedPayload);
      } else {
        this.logger.logModule(this.id, isResponses ? 'preserve-streaming-responses' : 'non-streaming-request', {
          hasStream: originalStream,
          entryEndpoint
        });
      }

      return isDto
        ? { ...dto!, data: transformedPayload }
        : { data: transformedPayload, route: { providerId: 'unknown', modelId: 'unknown', requestId: 'unknown', timestamp: Date.now() }, metadata: {}, debug: { enabled: false, stages: {} } } as SharedPipelineRequest;

    } catch (error) {
      this.logger.logModule(this.id, 'request-process-error', { error });
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
      const isDto = response && typeof response === 'object' && 'data' in response && 'metadata' in response;
      const payload = isDto ? (response as any).data : response;
      // Always return non-streaming response. No mock streaming conversion.
      this.logger.logModule(this.id, 'return-non-streaming-response', {
        note: 'Streaming responses are not implemented; unified to non-streaming.'
      });
      return isDto ? response : payload;

    } catch (error) {
      this.logger.logModule(this.id, 'response-process-error', { error, response });
      throw error;
    }
  }

  /**
   * Process streaming control
   */
  async processStreamingControl(request: SharedPipelineRequest): Promise<SharedPipelineRequest> {
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
  // No conversion back to streaming. Left intentionally unimplemented.
  // private convertNonStreamingToStreaming(...) { throw new Error('Not implemented'); }

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
  // Mock streaming has been removed per design; unified to non-streaming.

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
