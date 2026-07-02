// feature_id: sse.anthropic_gemini_stream_projection
import type { AnthropicMessageResponse, AnthropicSseEvent } from '../../types/index.js';
import type { ChatReasoningMode } from '../../types/chat-types.js';
import { buildAnthropicSseEventSequenceWithNative } from '../../../native/router-hotpath/native-anthropic-sse-event-payload.js';

export interface AnthropicSequencerConfig {
  chunkSize: number;
  chunkDelayMs: number;
  enableDelay: boolean;
  reasoningMode?: ChatReasoningMode;
  reasoningTextPrefix?: string;
}

export const DEFAULT_ANTHROPIC_SEQUENCER_CONFIG: AnthropicSequencerConfig = {
  chunkSize: 1024,
  chunkDelayMs: 0,
  enableDelay: false,
  reasoningMode: 'channel',
  reasoningTextPrefix: undefined
};

// Contract anchor: Rust owner must fail fast with
// `Invalid Anthropic tool_result block: missing tool_use_id`.

async function maybeDelay(config: AnthropicSequencerConfig): Promise<void> {
  if (!config.enableDelay || !config.chunkDelayMs) return;
  await new Promise(resolve => setTimeout(resolve, config.chunkDelayMs));
}

export function createAnthropicSequencer(config?: Partial<AnthropicSequencerConfig>) {
  const finalConfig: AnthropicSequencerConfig = {
    ...DEFAULT_ANTHROPIC_SEQUENCER_CONFIG,
    ...config
  };

  return {
    async *sequenceResponse(
      response: AnthropicMessageResponse,
      requestId: string
    ): AsyncGenerator<AnthropicSseEvent> {
      void requestId;
      const events = buildAnthropicSseEventSequenceWithNative({
        response,
        config: {
          chunkSize: finalConfig.chunkSize,
          reasoningMode: finalConfig.reasoningMode,
          reasoningTextPrefix: finalConfig.reasoningTextPrefix
        }
      });
      for (const event of events) {
        yield event as unknown as AnthropicSseEvent;
        await maybeDelay(finalConfig);
      }
    }
  };
}
