/**
 * Chat JSON → SSE converter thin shell.
 * Rust owns validation, event sequencing, stats, and error wrapping.
 * TS owns only PassThrough IO and stream lifecycle.
 */

// feature_id: sse.chat_stream_projection
// canonical_builder: build_chat_sse_stream_json
import { PassThrough } from 'node:stream';
import type {
  ChatCompletionResponse,
  ChatJsonToSseOptions,
  ChatSseEventStream,
  ChatEventStats
} from '../types/index.js';
import {
  buildChatSseStreamWithNativeFrames
} from '../../native/router-hotpath/native-chat-sse-event-payload.js';

export class ChatJsonToSseConverterRefactored {
  async convertResponseToJsonToSse(
    response: ChatCompletionResponse,
    options: ChatJsonToSseOptions
  ): Promise<ChatSseEventStream> {
    const stream = new PassThrough({ objectMode: false });
    const sseStream: ChatSseEventStream = Object.assign(stream, {
      protocol: 'chat' as const,
      direction: 'json_to_sse' as const,
      requestId: options.requestId,
      getStats: () => streamEventStats(),
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
        const frameResult = buildChatSseStreamWithNativeFrames({
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

function streamEventStats(): ChatEventStats {
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
