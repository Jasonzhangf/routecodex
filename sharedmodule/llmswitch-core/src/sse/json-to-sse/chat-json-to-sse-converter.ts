/**
 * Chat JSON → SSE converter thin shell.
 * Rust owns validation, event sequencing, stats, and error wrapping.
 * TS owns only PassThrough IO and stream lifecycle.
 */

// feature_id: sse.chat_stream_projection
// canonical_builder: build_chat_sse_stream_json
import { PassThrough } from 'stream';
import type {
  ChatCompletionResponse,
  ChatJsonToSseOptions,
  ChatSseEventStream,
  ChatSseEvent
} from '../types/index.js';
import { createChatStreamWriter } from '../shared/writer.js';
import { buildChatSseStreamWithNative } from '../../native/router-hotpath/native-chat-sse-event-payload.js';

export class ChatJsonToSseConverterRefactored {
  async convertResponseToJsonToSse(
    response: ChatCompletionResponse,
    options: ChatJsonToSseOptions
  ): Promise<ChatSseEventStream> {
    const stream = new PassThrough({ objectMode: true });
    const sseStream: ChatSseEventStream = Object.assign(stream, {
      protocol: 'chat' as const,
      direction: 'json_to_sse' as const,
      requestId: options.requestId,
      getStats: () => streamEventStats(stream),
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
    }) as ChatSseEventStream;

    (async () => {
      try {
        const result = buildChatSseStreamWithNative({
          response,
          model: options.model ?? response.model,
          requestId: options.requestId,
          config: {
            chunkSize: options.maxTokensPerChunk,
            chunkDelayMs: options.chunkDelayMs,
            enableDelay: !!options.chunkDelayMs,
            reasoningMode: options.reasoningMode,
            reasoningTextPrefix: options.reasoningTextPrefix
          }
        });
        const writer = createChatStreamWriter(stream, {
          onEvent: () => undefined,
          onError: (error) => {
            if (stream.writable) {
              stream.destroy(error);
            }
          }
        });
        await writer.writeChatEvents(result.events as ChatSseEvent[]);
        writer.complete();
      } catch (error) {
        if (stream.writable) {
          stream.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      }
    })();

    return sseStream;
  }
}

function streamEventStats(stream: PassThrough): Record<string, unknown> {
  return {
    totalEvents: 0,
    eventTypes: {},
    startTime: Date.now(),
    errorCount: 0
  };
}

export const ChatJsonToSseConverter = ChatJsonToSseConverterRefactored;
