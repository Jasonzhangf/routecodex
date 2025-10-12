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
  private protocolByReq: Map<string, 'anthropic' | 'openai'> = new Map();

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

      // Memorize target protocol per request for response stage filtering
      try {
        const reqId = dto?.route?.requestId || 'unknown';
        const md: any = (requestParam as any)?.metadata || {};
        const explicit = typeof md?.targetProtocol === 'string' ? String(md.targetProtocol).toLowerCase() : undefined;
        const endpoint = String(md?.endpoint || md?.url || '');
        let proto: 'anthropic' | 'openai' = explicit === 'anthropic' ? 'anthropic' : (explicit === 'openai' ? 'openai' : (endpoint.includes('/v1/messages') ? 'anthropic' : 'openai'));
        if (reqId) this.protocolByReq.set(reqId, proto);
      } catch { /* ignore */ }

      const originalStream = payload?.stream;
      let transformedPayload = { ...(payload || {}) };

      // If streaming request, convert to non-streaming for provider
      if (originalStream === true) {
        transformedPayload = this.convertStreamingToNonStreaming(payload);
        this.logger.logTransformation(dto?.route?.requestId || 'unknown', 'streaming-to-non-streaming', payload, transformedPayload);
      } else {
        this.logger.logModule(this.id, 'non-streaming-request', {
          hasStream: originalStream
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
      const reqId: string = isDto ? String((response as any)?.metadata?.requestId || '') : '';
      const proto = (reqId && this.protocolByReq.has(reqId)) ? this.protocolByReq.get(reqId)! : 'openai';

      // Optional reasoning filtering (config-driven)
      const policy = ((this.config?.config as any)?.reasoningPolicy) || {};
      const cleaned = this.applyReasoningPolicy(payload, proto, policy);

      // Always return non-streaming response
      if (isDto) {
        return { ...(response as any), data: cleaned };
      }
      return cleaned;

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
    // reasoningPolicy defaults are not enforced here; they are optional and endpoint-driven

    this.logger.logModule(this.id, 'config-validation-success', {
      type: this.config.type,
      enableStreaming: config.enableStreaming,
      bufferSize: config.bufferSize,
      timeout: config.timeout
    });
  }

  // --- Reasoning policy helpers ---
  private applyReasoningPolicy(payload: any, proto: 'anthropic' | 'openai', policy: any): any {
    try {
      const obj = (payload && typeof payload === 'object') ? { ...payload } : payload;
      if (!obj || typeof obj !== 'object') return payload;
      if (!Array.isArray((obj as any).choices)) return payload;
      const dispAnth = (policy?.anthropic?.disposition === 'text') ? 'text' : 'drop';
      const strictAnth = policy?.anthropic?.strict !== false;
      const dispOpen = (policy?.openai?.disposition === 'safe_text') ? 'safe_text' : 'keep';
      if (proto === 'anthropic') {
        (obj as any).choices = (obj as any).choices.map((c: any) => this.cleanAnthropicChoice(c, dispAnth, strictAnth));
      } else {
        (obj as any).choices = (obj as any).choices.map((c: any) => this.cleanOpenAIChoice(c, dispOpen));
      }
      return obj;
    } catch {
      return payload;
    }
  }

  private cleanOpenAIChoice(choiceIn: any, disposition: 'keep' | 'safe_text'): any {
    const c = (choiceIn && typeof choiceIn === 'object') ? { ...choiceIn } : choiceIn;
    if (!c || typeof c !== 'object') return c;
    const msg = (c.message && typeof c.message === 'object') ? { ...c.message } : c.message;
    if (!msg || typeof msg !== 'object') return c;
    msg.content = this.mergeContentToString(msg.content);
    if ('reasoning_content' in msg) {
      if (disposition === 'safe_text') {
        const rcStr = this.mergeContentToString((msg as any).reasoning_content);
        msg.content = msg.content ? `${msg.content}\n${rcStr}` : rcStr;
        delete (msg as any).reasoning_content;
      } else {
        (msg as any).reasoning_content = this.mergeContentToString((msg as any).reasoning_content);
      }
    }
    delete (msg as any).thinking;
    delete (msg as any).thought;
    c.message = msg;
    return c;
  }

  private cleanAnthropicChoice(choiceIn: any, disposition: 'drop' | 'text', _strict: boolean): any {
    const c = (choiceIn && typeof choiceIn === 'object') ? { ...choiceIn } : choiceIn;
    if (!c || typeof c !== 'object') return c;
    const msg = (c.message && typeof c.message === 'object') ? { ...c.message } : c.message;
    if (!msg || typeof msg !== 'object') return c;
    msg.content = this.mergeContentToString(msg.content);
    if ('reasoning_content' in msg) {
      if (disposition === 'text') {
        const rcStr = this.mergeContentToString((msg as any).reasoning_content);
        msg.content = msg.content ? `${msg.content}\n${rcStr}` : rcStr;
      }
      delete (msg as any).reasoning_content;
    }
    delete (msg as any).thinking;
    delete (msg as any).thought;
    c.message = msg;
    return c;
  }

  private mergeContentToString(content: any): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const texts = content.map((it) => {
        if (typeof it === 'string') return it;
        if (it && typeof it === 'object' && typeof (it as any).text === 'string') return (it as any).text;
        return '';
      }).filter(Boolean);
      return texts.join('');
    }
    if (content && typeof content === 'object' && typeof (content as any).text === 'string') return (content as any).text;
    try { return JSON.stringify(content ?? ''); } catch { return String(content ?? ''); }
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
