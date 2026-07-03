/**
 * Gemini JSON → SSE converter thin shell.
 * Rust owns validation, event sequencing, stats, and error wrapping.
 * TS owns only PassThrough IO and stream lifecycle.
 */

// feature_id: sse.anthropic_gemini_stream_projection
// canonical_builder: build_gemini_sse_stream_json
import { PassThrough } from 'node:stream';
import type { GeminiResponse, GeminiJsonToSseOptions } from '../types/index.js';
import { createGeminiStreamWriter } from '../shared/writer.js';
import { buildGeminiSseStreamWithNative } from '../../native/router-hotpath/native-gemini-sse-event-payload.js';

export class GeminiJsonToSseConverter {
  async convertResponseToJsonToSse(
    response: GeminiResponse,
    options: GeminiJsonToSseOptions
  ): Promise<PassThrough> {
    const stream = new PassThrough({ objectMode: true });
    const result = Object.assign(stream, {
      protocol: 'gemini-chat' as const,
      direction: 'json_to_sse' as const,
      requestId: options.requestId,
      getStats: () => ({
        totalEvents: 0,
        chunkEvents: 0,
        doneEvents: 0,
        errors: 0,
        startTime: Date.now()
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
        const built = buildGeminiSseStreamWithNative({
          response,
          config: {
            chunkDelayMs: options.chunkDelayMs,
            reasoningMode: options.reasoningMode,
            reasoningTextPrefix: options.reasoningTextPrefix
          }
        });
        const writer = createGeminiStreamWriter(stream, {
          onEvent: () => undefined,
          onError: (error) => {
            if (stream.writable) {
              stream.destroy(error);
            }
          }
        });
        await writer.writeGeminiEvents(built.events as unknown as Parameters<typeof writer.writeGeminiEvents>[0]);
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
