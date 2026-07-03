/**
 * Anthropic JSON → SSE converter thin shell.
 * Rust owns validation, event sequencing, stats, and error wrapping.
 * TS owns only PassThrough IO and stream lifecycle.
 */

// feature_id: sse.anthropic_gemini_stream_projection
// canonical_builder: build_anthropic_sse_stream_json
import { PassThrough } from 'node:stream';
import type { AnthropicMessageResponse, AnthropicJsonToSseOptions } from '../types/index.js';
import { buildAnthropicSseStreamFramesWithNative } from '../../native/router-hotpath/native-anthropic-sse-event-payload.js';

export class AnthropicJsonToSseConverter {
  async convertResponseToJsonToSse(
    response: AnthropicMessageResponse,
    options: AnthropicJsonToSseOptions
  ): Promise<PassThrough> {
    const stream = new PassThrough({ objectMode: false });
    const result = Object.assign(stream, {
      protocol: 'anthropic-messages' as const,
      direction: 'json_to_sse' as const,
      requestId: options.requestId,
      getStats: () => ({
        totalEvents: 0,
        contentBlocks: 0,
        toolUseBlocks: 0,
        thinkingBlocks: 0,
        textBlocks: 0,
        startTime: Date.now(),
        errors: 0
      }),
      complete: () => {
        if (stream.writable) {
          stream.end();
        }
      },
      abort: (error?: Error) => {
        if (stream.writable) {
          stream.destroy(error);
        }
      }
    });

    (async () => {
      try {
        const frameResult = buildAnthropicSseStreamFramesWithNative({
          response,
          requestId: options.requestId,
          model: response.model,
          config: {
            chunkSize: options.chunkSize,
            chunkDelayMs: options.chunkDelayMs,
            enableDelay: Boolean(options.chunkDelayMs),
            reasoningMode: options.reasoningMode,
            reasoningTextPrefix: options.reasoningTextPrefix
          }
        });
        for (const frame of frameResult.frames) {
          if (!stream.writable) break;
          stream.write(frame);
        }
        if (stream.writable) {
          stream.end();
        }
      } catch (error) {
        if (stream.writable) {
          stream.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      }
    })();

    return result;
  }
}
