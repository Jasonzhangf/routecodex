/**
 * Streaming Control Workflow Implementation
 *
 * Enforces OpenAI Chat standard validation and stream control across the pipeline.
 * - Request: validate OpenAI Chat request, persist originalStream, force provider-side stream=false
 * - Response: validate OpenAI Chat response (non-stream JSON); streaming emission remains handler's job for now
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

      // Validate OpenAI Chat request (strict)
      this.validateOpenAIChatRequest(payload);

      const originalStream = payload?.stream === true;
      // Force provider-side non-stream while preserving client intent
      const transformedPayload = this.convertStreamingToNonStreaming(payload);
      if (originalStream) {
        this.logger.logTransformation(dto?.route?.requestId || 'unknown', 'streaming-to-non-streaming', payload, transformedPayload);
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
      // Validate OpenAI Chat response (non-stream JSON)
      this.validateOpenAIChatResponse(payload);
      // For Phase 1, return non-stream JSON; handler handles streaming.
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

  /**
   * Validate OpenAI Chat request shape (strict minimal set)
   */
  private validateOpenAIChatRequest(req: any): void {
    if (!req || typeof req !== 'object') {
      throw new Error('Invalid request payload: expected object');
    }
    if (typeof req.model !== 'string' || !req.model.trim()) {
      throw new Error('Invalid request: model must be a non-empty string');
    }
    if (!Array.isArray(req.messages) || req.messages.length === 0) {
      throw new Error('Invalid request: messages must be a non-empty array');
    }
    const roles = new Set(['system','user','assistant','tool']);
    for (const m of req.messages) {
      if (!m || typeof m !== 'object') throw new Error('Invalid request: message must be object');
      if (!roles.has(String(m.role))) throw new Error(`Invalid message role: ${String(m.role)}`);
      if (m.role === 'tool') {
        if (typeof m.tool_call_id !== 'string' || !m.tool_call_id) throw new Error('Invalid tool message: missing tool_call_id');
        if (typeof m.content !== 'string') throw new Error('Invalid tool message: content must be string');
      }
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (!tc || typeof tc !== 'object') throw new Error('Invalid assistant.tool_calls item');
          const fn = (tc as any).function;
          if (!fn || typeof fn !== 'object') throw new Error('Invalid tool_calls.function');
          if (typeof fn.name !== 'string' || !fn.name) throw new Error('Invalid tool_calls.function.name');
          // Accept any string for arguments at request stage; normalization happens in llmswitch/compatibility.
          if (typeof fn.arguments !== 'string') throw new Error('Invalid tool_calls.function.arguments: must be string');
        }
      }
    }
  }

  /**
   * Validate OpenAI Chat response shape (strict minimal set)
   */
  private validateOpenAIChatResponse(resp: any): void {
    if (!resp || typeof resp !== 'object') {
      throw new Error('Invalid response payload: expected object');
    }
    if (!Array.isArray(resp.choices) || resp.choices.length === 0) {
      throw new Error('Invalid response: choices must be a non-empty array');
    }
    for (const ch of resp.choices) {
      const msg = ch?.message;
      if (!msg || typeof msg !== 'object') throw new Error('Invalid response: choice.message missing');
      if (msg.role && msg.role !== 'assistant') throw new Error('Invalid response: message.role must be assistant when present');
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const fn = tc?.function;
          if (!fn || typeof fn !== 'object') throw new Error('Invalid response: tool_calls.function missing');
          if (typeof fn.name !== 'string' || !fn.name) throw new Error('Invalid response: tool_calls.function.name');
          // Accept any string; upstream may choose to provide either a JSON string or plain string; do not block here.
          if (typeof fn.arguments !== 'string') throw new Error('Invalid response: tool_calls.function.arguments must be string');
        }
      }
    }
  }
}
