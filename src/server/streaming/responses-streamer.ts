import { type Response } from 'express';

import {
  BaseStreamer,
  type ProtocolHandlerConfig,
  type StreamChunk,
  type StreamingOptions
} from './base-streamer.js';

/**
 * Protocol-agnostic streamer that falls back to the generic response chunk
 * format. This keeps the new streaming layer compilable while the richer
 * implementation is still being designed.
 */
export class ResponsesStreamer extends BaseStreamer {
  constructor(config?: ProtocolHandlerConfig) {
    super(config);
  }

  async streamResponse(response: unknown, options: StreamingOptions, res: Response): Promise<void> {
    try {
      this.validateOptions(options);
      if (!this.isStreamingEnabled()) {
        throw new Error('Streaming is disabled for this handler');
      }

      this.setupStreamingHeaders(res, options.requestId);
      this.startStreaming();

      const chunks: StreamChunk[] = Array.isArray(response)
        ? (response as StreamChunk[])
        : typeof response === 'object' && response !== null && 'data' in (response as Record<string, unknown>) && Array.isArray((response as any).data)
          ? ((response as any).data as StreamChunk[])
          : [];

      for (const chunk of chunks) {
        const payload = this.formatResponseChunk(chunk, options.requestId);
        const wrote = this.sendSSEData(res, payload);
        if (!wrote) {
          break;
        }
        this.incrementChunkCount();
        await this.applyChunkDelay(options.chunkDelay);
      }

      // Emit Anthropic Responses-style completion signal before closing
      try {
        const completion = {
          type: 'response.completed',
          response: {
            id: `resp_${options.requestId}`,
            model: options.model,
          },
        };
        this.sendSSEEvent(res, 'response.completed', JSON.stringify(completion));
      } catch { /* ignore */ }

      try { res.end(); } catch { /* ignore */ }
      this.logStreamingMetrics(options);
    } catch (error) {
      this.handleStreamingError(res, error as Error, options.requestId);
    }
  }
}
