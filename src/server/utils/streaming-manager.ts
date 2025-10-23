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
      enableDebugCenter: false,
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
      if (!this.shouldStreamFromPipeline()) {
        throw new Error('Streaming pipeline is disabled for this endpoint');
      }

      await this.streamFromPipeline(response, requestId, res, model);

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
    if (!response || typeof response !== 'object' || !('data' in response)) {
      throw new Error('Streaming pipeline response is missing data payload');
    }

    await this.processStreamingData((response as Record<string, unknown>).data, requestId, res, model);
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
    const finishReasons: string[] = [];

    const pushChunk = async (raw: any) => {
      const normalized = this.normalizeChunk(raw, model, finishReasons);
      await this.sendChunk(res, normalized, requestId, model);
      await this.delay(10);
    };

    if (Array.isArray(data)) {
      for (const chunk of data) {
        await pushChunk(chunk);
      }
    } else if (typeof data === 'object' && data !== null) {
      await pushChunk(data);
    }

    const finalReason = finishReasons.length ? finishReasons[finishReasons.length - 1] : undefined;
    this.sendFinalChunk(res, requestId, model, finalReason);
  }

  /**
   * Normalize chunk into OpenAI streaming shape
   */
  private normalizeChunk(chunk: any, model: string, finishReasons: string[]): any {
    if (!chunk || typeof chunk !== 'object') {
      return chunk;
    }

    const hasDelta =
      chunk.object === 'chat.completion.chunk' ||
      (Array.isArray(chunk.choices) && chunk.choices.some((choice: any) => choice?.delta));

    if (hasDelta) {
      this.captureFinishReason(chunk, finishReasons);
      return chunk;
    }

    if (!Array.isArray(chunk.choices)) {
      return chunk;
    }

    const normalizedChoices = chunk.choices.map((choice: any, index: number) => {
      const message = choice?.message || {};
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : undefined;
      const delta: Record<string, unknown> = {};
      if (message.role && typeof message.role === 'string') {
        delta.role = message.role;
      }
      if (typeof message.content === 'string') {
        delta.content = message.content;
      }
      if (toolCalls) {
        delta.tool_calls = toolCalls;
      }
      if (typeof choice.content === 'string' && !delta.content) {
        delta.content = choice.content;
      }

      const finishReason = choice?.finish_reason ?? (message?.finish_reason as string | undefined);
      if (finishReason) {
        finishReasons.push(finishReason);
      }

      return {
        index: choice?.index ?? index,
        delta,
        finish_reason: null
      };
    });

    return {
      id: chunk.id ?? `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: chunk.created ?? Math.floor(Date.now() / 1000),
      model: chunk.model ?? model,
      choices: normalizedChoices
    };
  }

  private captureFinishReason(chunk: any, finishReasons: string[]): void {
    if (!chunk || typeof chunk !== 'object') {
      return;
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices) {
      const reason = choice?.finish_reason;
      if (typeof reason === 'string' && reason.length > 0) {
        finishReasons.push(reason);
      }
    }
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
  private sendFinalChunk(res: Response, requestId: string, model: string, finishReason?: string): void {
    const finalChunk = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: finishReason ?? 'stop'
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
