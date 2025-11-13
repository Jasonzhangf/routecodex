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
  private injectedConfig: unknown = undefined;

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

  // V2 注入（V1 不调用）
  setConfig(cfg: unknown): void {
    this.injectedConfig = cfg;
    try { if (cfg && typeof cfg === 'object') { (this.config as any).config = { ...(this.config as any).config, ...(cfg as any) }; } } catch {}
  }

  getConfig(): unknown { return this.injectedConfig ?? (this.config as any)?.config ?? null; }

  /**
   * Process incoming request - Handle streaming conversion
   */
  async processIncoming(requestParam: SharedPipelineRequest): Promise<SharedPipelineRequest> {
    // Pass-through: do not modify payload or metadata
    if (!this.isInitialized) {
      throw new Error('Streaming Control Workflow is not initialized');
    }
    return requestParam;
  }

  /**
   * Process outgoing response - Handle streaming response conversion
   */
  async processOutgoing(response: any): Promise<any> {
    // Pass-through
    if (!this.isInitialized) {
      throw new Error('Streaming Control Workflow is not initialized');
    }
    return response;
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
  // No conversion in pass-through mode
  private convertStreamingToNonStreaming(request: any): any { return request; }

  /**
   * Convert non-streaming response to streaming
   */
  // No conversion back to streaming. Left intentionally unimplemented.
  // private convertNonStreamingToStreaming(...) { throw new Error('Not implemented'); }

  /**
   * Validate module configuration
   */
  private validateConfig(): void {
    // Pass-through: accept any config; do not enforce or mutate
    this.logger.logModule(this.id, 'config-validation-success', {
      type: this.config?.type || 'streaming-control',
      mode: 'pass-through'
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
