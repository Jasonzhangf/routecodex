// feature_id: sse.anthropic_gemini_stream_projection
import type {
  GeminiResponse,
  GeminiSseEvent
} from '../../types/index.js';
import type { ChatReasoningMode } from '../../types/chat-types.js';
import { buildGeminiSseEventSequenceWithNative } from '../../../native/router-hotpath/native-gemini-sse-event-payload.js';

export interface GeminiSequencerConfig {
  chunkDelayMs: number;
  reasoningMode?: ChatReasoningMode;
  reasoningTextPrefix?: string;
}

const DEFAULT_CONFIG: GeminiSequencerConfig = {
  chunkDelayMs: 0,
  reasoningMode: 'channel',
  reasoningTextPrefix: undefined
};

async function maybeDelay(config: GeminiSequencerConfig): Promise<void> {
  if (!config.chunkDelayMs) return;
  await new Promise((resolve) => setTimeout(resolve, config.chunkDelayMs));
}

export function createGeminiSequencer(config?: Partial<GeminiSequencerConfig>) {
  const finalConfig: GeminiSequencerConfig = { ...DEFAULT_CONFIG, ...config };

  return {
    async *sequenceResponse(response: GeminiResponse): AsyncGenerator<GeminiSseEvent> {
      const events = buildGeminiSseEventSequenceWithNative({
        response,
        config: {
          reasoningMode: finalConfig.reasoningMode,
          reasoningTextPrefix: finalConfig.reasoningTextPrefix
        }
      });
      for (const event of events) {
        yield event as GeminiSseEvent;
        await maybeDelay(finalConfig);
      }
    }
  };
}
