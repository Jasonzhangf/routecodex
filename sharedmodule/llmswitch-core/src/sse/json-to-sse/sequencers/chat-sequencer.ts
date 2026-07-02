/**
 * Chat SSE sequencer thin shell.
 * Rust owns role/content/reasoning/tool/finish/done event ordering.
 */

import type { ChatCompletionResponse, ChatReasoningMode, ChatSseEvent } from '../../types/index.js';
import { buildChatSseEventSequenceWithNative } from '../../../native/router-hotpath/native-chat-sse-event-payload.js';

export interface ChatSequencerConfig {
  chunkSize: number;
  chunkDelayMs: number;
  enableTimestampGeneration: boolean;
  includeSequenceNumbers: boolean;
  enableDelay: boolean;
  validateOrder: boolean;
  reasoningMode?: ChatReasoningMode;
  reasoningTextPrefix?: string;
}

export const DEFAULT_CHAT_SEQUENCER_CONFIG: ChatSequencerConfig = {
  chunkSize: 0,
  chunkDelayMs: 0,
  enableTimestampGeneration: true,
  includeSequenceNumbers: true,
  enableDelay: false,
  validateOrder: true,
  reasoningMode: 'channel'
};

export async function* sequenceChatResponse(
  response: ChatCompletionResponse,
  model: string,
  requestId: string,
  config: ChatSequencerConfig = DEFAULT_CHAT_SEQUENCER_CONFIG
): AsyncGenerator<ChatSseEvent> {
  const events = buildChatSseEventSequenceWithNative({
    response: response as unknown as Record<string, unknown>,
    model,
    requestId,
    config
  });

  for (const event of events) {
    yield event as ChatSseEvent;
    if (config.enableDelay && config.chunkDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, config.chunkDelayMs));
    }
  }
}

export function createChatSequencer(config?: Partial<ChatSequencerConfig>) {
  const finalConfig = { ...DEFAULT_CHAT_SEQUENCER_CONFIG, ...config };

  return {
    async *sequenceResponse(response: ChatCompletionResponse, model: string, requestId: string) {
      yield* sequenceChatResponse(response, model, requestId, finalConfig);
    },

    getConfig(): ChatSequencerConfig {
      return { ...finalConfig };
    }
  };
}
