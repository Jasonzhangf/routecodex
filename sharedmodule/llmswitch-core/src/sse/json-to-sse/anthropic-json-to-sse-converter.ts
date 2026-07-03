/**
 * Anthropic JSON → SSE converter thin shell.
 * Rust owns validation, event sequencing, stats, and error wrapping.
 * TS owns only PassThrough IO and stream lifecycle.
 */

// feature_id: sse.anthropic_gemini_stream_projection
// canonical_builder: build_anthropic_sse_stream_json
import { PassThrough } from 'node:stream';
import type { AnthropicMessageResponse, AnthropicJsonToSseOptions } from '../types/index.js';
import { createAnthropicStreamWriter } from '../shared/writer.js';
import { buildAnthropicSseStreamWithNative } from '../../native/router-hotpath/native-anthropic-sse-event-payload.js';

export class AnthropicJsonToSseConverter {
  async convertResponseToJsonToSse(
    response: AnthropicMessageResponse,
    options: AnthropicJsonToSseOptions
  ): Promise<PassThrough> {
    const stream = new PassThrough({ objectMode: true });
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
        const built = buildAnthropicSseStreamWithNative({
          response,
          config: {
            chunkSize: options.chunkSize,
            chunkDelayMs: options.chunkDelayMs,
            enableDelay: Boolean(options.chunkDelayMs),
            reasoningMode: options.reasoningMode,
            reasoningTextPrefix: options.reasoningTextPrefix
          }
        });
        const writer = createAnthropicStreamWriter(stream, {
          onEvent: () => undefined,
          onError: (error) => {
            if (stream.writable) {
              stream.destroy(error);
            }
          }
        });
        await writer.writeAnthropicEvents(built.events as unknown as Parameters<typeof writer.writeAnthropicEvents>[0]);
        writer.complete();
      } catch (error) {
        if (stream.writable) {
          stream.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      }
    })();

    return result;
  }
}
