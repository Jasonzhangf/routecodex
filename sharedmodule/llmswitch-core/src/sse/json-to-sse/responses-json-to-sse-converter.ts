/**
 * Responses JSON → SSE converter thin shell.
 * Rust owns validation, event sequencing, stats, and error wrapping.
 * TS owns only PassThrough IO and stream lifecycle.
 */

// feature_id: sse.responses_encode_projection
// canonical_builder: build_responses_sse_stream_json
import { PassThrough } from 'node:stream';
import type {
  ResponsesResponse,
  ResponsesJsonToSseOptions,
  ResponsesSseEventStream
} from '../types/index.js';
import { buildResponsesSseStreamFramesWithNative } from '../../native/router-hotpath/native-responses-sse-event-payload.js';

export class ResponsesJsonToSseConverterRefactored {
  async convertResponseToJsonToSse(
    response: ResponsesResponse,
    options: ResponsesJsonToSseOptions
  ): Promise<ResponsesSseEventStream> {
    const stream = new PassThrough({ objectMode: false });
    const sseStream: ResponsesSseEventStream = Object.assign(stream, {
      protocol: 'responses' as const,
      direction: 'json_to_sse' as const,
      requestId: options.requestId,
      getStats: () => ({
        totalEvents: 0,
        eventTypes: {},
        startTime: Date.now(),
        errorCount: 0
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
    }) as unknown as ResponsesSseEventStream;

    (async () => {
      try {
        const frameResult = buildResponsesSseStreamFramesWithNative({
          response,
          requestId: options.requestId,
          model: response.model,
          config: {
            chunkSize: options.chunkSize ?? 0,
            enableTimestampGeneration: true,
            includeSequenceNumbers: true
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

    return sseStream;
  }
}

export const ResponsesJsonToSseConverter = ResponsesJsonToSseConverterRefactored;
