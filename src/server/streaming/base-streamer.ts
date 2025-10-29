import { type Response } from 'express';

/**
 * Stream chunk interface
 */
export interface StreamChunk {
  content?: string;
  done?: boolean;
  // For OpenAI Chat SSE: include tool_calls delta when present
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }>;
  metadata?: {
    model?: string;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
    finish_reason?: string;
  };
}

/**
 * Streaming options interface
 */
export interface StreamingOptions {
  requestId: string;
  model: string;
  enableMetrics?: boolean;
  chunkDelay?: number;
  maxTokens?: number;
}

/**
 * Protocol handler configuration
 */
export interface ProtocolHandlerConfig {
  enableStreaming?: boolean;
  enableMetrics?: boolean;
  targetUrl?: string;
  timeout?: number;
}

/**
 * Base Streamer Abstract Class
 * Provides common streaming functionality for different protocols
 */
export abstract class BaseStreamer {
  protected config: ProtocolHandlerConfig;
  protected isStreaming = false;
  protected startTime = 0;
  protected chunkCount = 0;

  constructor(config: ProtocolHandlerConfig = {}) {
    this.config = {
      enableStreaming: true,
      enableMetrics: true,
      timeout: 30000,
      ...config,
    };
  }

  /**
   * Stream response - must be implemented by subclasses
   */
  abstract streamResponse(
    response: any,
    options: StreamingOptions,
    res: Response
  ): Promise<void>;

  /**
   * Send SSE (Server-Sent Events) data
   */
  protected sendSSEData(res: Response, data: string): boolean {
    try {
      if (res.writableEnded) {
        return false;
      }

      res.write(`data: ${data}\n\n`);
      return true;
    } catch (error) {
      console.error('Failed to send SSE data:', error);
      return false;
    }
  }

  /**
   * Send SSE event with custom event name
   */
  protected sendSSEEvent(res: Response, event: string, data: string): boolean {
    try {
      if (res.writableEnded) {
        return false;
      }

      res.write(`event: ${event}\n`);
      res.write(`data: ${data}\n\n`);
      return true;
    } catch (error) {
      console.error('Failed to send SSE event:', error);
      return false;
    }
  }

  /**
   * Set up streaming response headers
   */
  protected setupStreamingHeaders(res: Response, requestId: string): void {
    // Avoid "ERR_HTTP_HEADERS_SENT" if a pre-heartbeat or another layer already set headers
    if (res.headersSent) {
      return;
    }
    try { res.setHeader('Content-Type', 'text/event-stream'); } catch { /* ignore */ }
    try { res.setHeader('Cache-Control', 'no-cache'); } catch { /* ignore */ }
    try { res.setHeader('Connection', 'keep-alive'); } catch { /* ignore */ }
    try { res.setHeader('Access-Control-Allow-Origin', '*'); } catch { /* ignore */ }
    try { res.setHeader('Access-Control-Allow-Headers', 'Cache-Control'); } catch { /* ignore */ }
    try { res.setHeader('x-request-id', requestId); } catch { /* ignore */ }
  }

  /**
   * Start streaming session
   */
  protected startStreaming(): void {
    this.isStreaming = true;
    this.startTime = Date.now();
    this.chunkCount = 0;
  }

  /**
   * End streaming session
   */
  protected endStreaming(res: Response): void {
    this.isStreaming = false;

    if (!res.writableEnded) {
      try {
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (error) {
        console.error('Error ending stream:', error);
      }
    }
  }

  /**
   * Log streaming metrics
   */
  protected logStreamingMetrics(options: StreamingOptions): void {
    if (!this.config.enableMetrics) {
      return;
    }

    const duration = Date.now() - this.startTime;
    const metrics = {
      requestId: options.requestId,
      model: options.model,
      duration,
      chunkCount: this.chunkCount,
      chunksPerSecond: this.chunkCount > 0 ? (this.chunkCount / (duration / 1000)).toFixed(2) : 0,
    };

    console.log('Streaming metrics:', metrics);
  }

  /**
   * Validate streaming options
   */
  protected validateOptions(options: StreamingOptions): void {
    if (!options.requestId) {
      throw new Error('Request ID is required for streaming');
    }

    if (!options.model) {
      throw new Error('Model is required for streaming');
    }
  }

  /**
   * Handle streaming error
   */
  protected handleStreamingError(res: Response, error: Error, requestId: string): void {
    console.error('Streaming error:', error);

    if (!res.writableEnded) {
      const errorData = {
        error: {
          message: error.message,
          type: 'streaming_error',
          code: 'STREAM_FAILED',
        },
        requestId,
      };

      this.sendSSEEvent(res, 'error', JSON.stringify(errorData));
      res.end();
    }
  }

  /**
   * Check if streaming is enabled
   */
  protected isStreamingEnabled(): boolean {
    return this.config.enableStreaming === true;
  }

  /**
   * Get streaming statistics
   */
  protected getStreamingStats(): {
    isStreaming: boolean;
    duration: number;
    chunkCount: number;
  } {
    return {
      isStreaming: this.isStreaming,
      duration: this.startTime > 0 ? Date.now() - this.startTime : 0,
      chunkCount: this.chunkCount,
    };
  }

  /**
   * Increment chunk counter
   */
  protected incrementChunkCount(): void {
    this.chunkCount++;
  }

  /**
   * Apply chunk delay if configured
   */
  protected async applyChunkDelay(delayMs?: number): Promise<void> {
    const ms = typeof delayMs === 'number' ? delayMs : 0;
    if (ms > 0) {
      await new Promise(resolve => setTimeout(resolve, ms));
    }
  }

  /**
   * Format OpenAI-style chunk
   */
  protected formatOpenAIChunk(chunk: StreamChunk, requestId: string): string {
    const openAIChunk: any = {
      id: `chatcmpl-${requestId}-${this.chunkCount}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: chunk.metadata?.model || 'unknown',
      choices: [{
        index: 0,
        delta: {
          content: chunk.content ?? '',
          // Attach tool_calls delta if present
          ...(Array.isArray(chunk.tool_calls) && chunk.tool_calls.length
            ? { tool_calls: chunk.tool_calls.map((tc) => ({
                index: tc.index,
                id: tc.id,
                type: tc.type || 'function',
                function: tc.function || {}
              })) }
            : {})
        },
        finish_reason: chunk.done ? chunk.metadata?.finish_reason || 'stop' : null,
      }],
    };

    if (chunk.done && chunk.metadata?.usage) {
      openAIChunk.usage = chunk.metadata.usage;
    }

    return JSON.stringify(openAIChunk);
  }

  /**
   * Format Anthropic-style chunk
   */
  protected formatAnthropicChunk(chunk: StreamChunk, requestId: string): string {
    if (chunk.done) {
      return JSON.stringify({
        type: 'message_stop',
      });
    }

    return JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: chunk.content ?? ''
      }
    });
  }

  /**
   * Format Response-style chunk (generic)
   */
  protected formatResponseChunk(chunk: StreamChunk, requestId: string): string {
    return JSON.stringify({
      id: requestId,
      object: 'response.chunk',
      created: Math.floor(Date.now() / 1000),
      content: chunk.content,
      done: chunk.done,
      metadata: chunk.metadata,
    });
  }
}
