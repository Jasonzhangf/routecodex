import { type Response } from 'express';
import { BaseStreamer, type StreamChunk, type StreamingOptions, type ProtocolHandlerConfig } from './base-streamer.js';

export class OpenAIStreamer extends BaseStreamer {
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
        const payload = this.formatOpenAIChunk(chunk, options.requestId);
        const wrote = this.sendSSEData(res, payload);
        if (!wrote) {
          break;
        }
        this.incrementChunkCount();
        await this.applyChunkDelay(options.chunkDelay);
      }

      this.endStreaming(res);
      this.logStreamingMetrics(options);
    } catch (error) {
      this.handleStreamingError(res, error as Error, options.requestId);
    }
  }
}
