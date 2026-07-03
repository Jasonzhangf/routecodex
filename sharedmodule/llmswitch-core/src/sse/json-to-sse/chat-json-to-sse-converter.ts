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
    // Call native synchronously first to capture synchronous errors
    // before setting up the stream, so that reject-based test patterns work.
    let frameResult: ReturnType<typeof buildChatSseStreamWithNativeFrames>;
    try {
      frameResult = buildChatSseStreamWithNativeFrames({
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
    } catch (error) {
      // Propagate validation errors synchronously so callers using
      // `await expect(converter.convertResponseToJsonToSse(...)).rejects.toThrow(...)`
      // can catch them properly.
      throw error instanceof Error ? error : new Error(String(error));
    }

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
