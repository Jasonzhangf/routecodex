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
  ChatSseEvent,
  ChatEventStats
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
    }) as unknown as ChatSseEventStream;

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

function streamEventStats(stream: PassThrough): ChatEventStats {
  return {
    totalChunks: 0,
    totalTokens: 0,
    totalChoices: 0,
    totalToolCalls: 0,
    totalEvents: 0,
    eventTypes: {},
    startTime: Date.now(),
    tokenRate: 0,
    chunkRate: 0,
    errorCount: 0,
    retryCount: 0
  };
}

export const ChatJsonToSseConverter = ChatJsonToSseConverterRefactored;
