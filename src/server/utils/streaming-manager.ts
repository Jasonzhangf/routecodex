/**
 * Streaming Manager Utility
 * Handles streaming responses for different protocols
 */

import { type Response } from 'express';
import type { ProtocolHandlerConfig } from '../handlers/base-handler.js';
import { PipelineDebugLogger } from '../../modules/pipeline/utils/debug-logger.js';

/**
 * Streaming chunk interface
 */
export interface StreamingChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      content?: string;
      role?: string;
      tool_calls?: any[];
    };
    finish_reason?: string | null;
  }>;
}

/**
 * Streaming Manager Class
 */
export class StreamingManager {
  private config: ProtocolHandlerConfig;
  private logger: PipelineDebugLogger;

  constructor(config: ProtocolHandlerConfig) {
    this.config = config;
    this.logger = new PipelineDebugLogger(null, {
      enableConsoleLogging: config.enableMetrics ?? true,
      enableDebugCenter: true,
    });
  }

  /**
   * Stream response to client
   */
  async streamResponse(response: any, requestId: string, res: Response, model: string): Promise<void> {
    try {
      // Set appropriate headers for streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('x-request-id', requestId);

      // Start streaming
      if (this.shouldStreamFromPipeline()) {
        await this.streamFromPipeline(response, requestId, res, model);
      } else {
        await this.streamSimulated(response, requestId, res, model);
      }

    } catch (error) {
      this.logger.logModule('StreamingManager', 'stream_error', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
        model,
      });

      // Send error chunk and close
      this.sendErrorChunk(res, error, requestId);
      res.end();
    }
  }

  /**
   * Stream Anthropic-compatible responses (delegates to generic streaming)
   */
  async streamAnthropicResponse(response: any, requestId: string, res: Response, model: string): Promise<void> {
    await this.streamResponse(response, requestId, res, model);
  }

  /**
   * Check if should stream from pipeline
   */
  private shouldStreamFromPipeline(): boolean {
    return this.config.enablePipeline ?? false;
  }

  /**
   * Stream from pipeline
   */
  private async streamFromPipeline(
    response: any,
    requestId: string,
    res: Response,
    model: string
  ): Promise<void> {
    // If response is already a stream, pipe it
    if (response && typeof response.pipe === 'function') {
      return new Promise((resolve, reject) => {
        response.pipe(res);
        response.on('end', resolve);
        response.on('error', reject);
      });
    }

    // Handle streaming response data
    if (response && typeof response === 'object' && response.data) {
      await this.processStreamingData(response.data, requestId, res, model);
    } else {
      // Fallback to simulated streaming
      await this.streamSimulated(response, requestId, res, model);
    }
  }

  /**
   * Process streaming data
   */
  private async processStreamingData(
    data: any,
    requestId: string,
    res: Response,
    model: string
  ): Promise<void> {
    if (Array.isArray(data)) {
      // Process array of chunks
      for (const chunk of data) {
        await this.sendChunk(res, chunk, requestId, model);
        await this.delay(10); // Small delay between chunks
      }
    } else if (typeof data === 'object') {
      // Process single chunk object
      await this.sendChunk(res, data, requestId, model);
    }

    // Send final chunk
    this.sendFinalChunk(res, requestId, model);
  }

  /**
   * Stream simulated response
   */
  private async streamSimulated(
    response: any,
    requestId: string,
    res: Response,
    model: string
  ): Promise<void> {
    // Simulate streaming with chunks
    const content = response?.choices?.[0]?.message?.content || 'This is a simulated response';
    const words = content.split(' ');

    let accumulatedContent = '';

    for (let i = 0; i < words.length; i++) {
      accumulatedContent += (i > 0 ? ' ' : '') + words[i];

      const chunk: StreamingChunk = {
        id: `chatcmpl-${Date.now()}-${i}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          delta: { content: words[i] + (i < words.length - 1 ? ' ' : '') },
          finish_reason: i === words.length - 1 ? 'stop' : null
        }]
      };

      await this.sendChunk(res, chunk, requestId, model);
      await this.delay(50); // Simulate processing delay
    }

    // Send final chunk
    this.sendFinalChunk(res, requestId, model);
  }

  /**
   * Send chunk to response
   */
  private async sendChunk(
    res: Response,
    chunk: StreamingChunk | any,
    requestId: string,
    model: string
  ): Promise<void> {
    const chunkData = typeof chunk === 'object' && chunk.id ? chunk : {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: chunk,
        finish_reason: null
      }]
    };

    const sseData = `data: ${JSON.stringify(chunkData)}\n\n`;
    res.write(sseData);

    this.logger.logModule('StreamingManager', 'chunk_sent', {
      requestId,
      chunkId: chunkData.id,
      model,
    });
  }

  /**
   * Send final chunk
   */
  private sendFinalChunk(res: Response, requestId: string, model: string): void {
    const finalChunk = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop'
      }]
    };

    const finalData = `data: ${JSON.stringify(finalChunk)}\n\ndata: [DONE]\n\n`;
    res.write(finalData);
    res.end();

    this.logger.logModule('StreamingManager', 'stream_complete', {
      requestId,
      model,
    });
  }

  /**
   * Send error chunk
   */
  private sendErrorChunk(res: Response, error: any, requestId: string): void {
    const errorChunk = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'unknown',
      choices: [{
        index: 0,
        delta: {
          content: `Error: ${error instanceof Error ? error.message : String(error)}`
        },
        finish_reason: 'error'
      }]
    };

    const errorData = `data: ${JSON.stringify(errorChunk)}\n\ndata: [DONE]\n\n`;
    res.write(errorData);
  }

  /**
   * Delay utility
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Check if response is streamable
   */
  isStreamable(response: any): boolean {
    return (
      response?.stream === true ||
      (typeof response?.pipe === 'function') ||
      (Array.isArray(response?.data)) ||
      (this.config.enableStreaming === true)
    );
  }

  /**
   * Get streaming statistics
   */
  getStreamingStats(): {
    enabled: boolean;
    config: ProtocolHandlerConfig;
  } {
    return {
      enabled: this.config.enableStreaming ?? false,
      config: this.config,
    };
  }
}
