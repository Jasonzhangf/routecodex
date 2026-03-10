import type { AnthropicMessageResponse, AnthropicSseEvent } from '../../types/index.js';
import type { ChatReasoningMode } from '../../types/chat-types.js';
import { dispatchReasoning } from '../../shared/reasoning-dispatcher.js';

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

function createEvent(type: AnthropicSseEvent['type'], data: Record<string, unknown>): AnthropicSseEvent {
  return {
    type,
    event: type,
    timestamp: Date.now(),
    protocol: 'anthropic-messages',
    direction: 'json_to_sse',
    data: { type, ...data }
  } as AnthropicSseEvent;
}

async function maybeDelay(config: AnthropicSequencerConfig): Promise<void> {
  if (!config.enableDelay || !config.chunkDelayMs) return;
  await new Promise(resolve => setTimeout(resolve, config.chunkDelayMs));
}

function chunkText(input: string, size: number): string[] {
  if (!input || size <= 0) return [input];
  const chunks: string[] = [];
  for (let i = 0; i < input.length; i += size) {
    chunks.push(input.slice(i, i + size));
  }
  return chunks.length ? chunks : [''];
}

function normalizeToolInput(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return String(input ?? '');
  }
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
      yield createEvent('message_start', {
        message: {
          id: response.id || `msg_${requestId}`,
          type: 'message',
          role: response.role || 'assistant',
          model: response.model
        }
      });

      let index = 0;
      for (const block of response.content || []) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') {
          yield createEvent('content_block_start', { index, content_block: { type: 'text' } });
          for (const chunk of chunkText(block.text ?? '', finalConfig.chunkSize)) {
            if (!chunk) continue;
            yield createEvent('content_block_delta', {
              index,
              delta: { type: 'text_delta', text: chunk }
            });
            await maybeDelay(finalConfig);
          }
          yield createEvent('content_block_stop', { index });
          index += 1;
        } else if (block.type === 'thinking') {
          const decision = dispatchReasoning(block.text, {
            mode: finalConfig.reasoningMode,
            prefix: finalConfig.reasoningTextPrefix
          });
          if (decision.appendToContent) {
            yield createEvent('content_block_start', { index, content_block: { type: 'text' } });
            for (const chunk of chunkText(decision.appendToContent, finalConfig.chunkSize)) {
              if (!chunk) continue;
              yield createEvent('content_block_delta', {
                index,
                delta: { type: 'text_delta', text: chunk }
              });
              await maybeDelay(finalConfig);
            }
            yield createEvent('content_block_stop', { index });
            index += 1;
          }
          if (decision.channel) {
            yield createEvent('content_block_start', { index, content_block: { type: 'thinking' } });
            for (const chunk of chunkText(decision.channel, finalConfig.chunkSize)) {
              if (!chunk) continue;
              yield createEvent('content_block_delta', {
                index,
                delta: { type: 'thinking_delta', text: chunk }
              });
              await maybeDelay(finalConfig);
            }
            yield createEvent('content_block_stop', { index });
            index += 1;
          }
        } else if (block.type === 'tool_use') {
          const id = block.id || `call_${requestId}_${index}`;
          yield createEvent('content_block_start', {
            index,
            content_block: { type: 'tool_use', id, name: block.name, input: block.input }
          });
          const payload = normalizeToolInput(block.input ?? {});
          if (payload) {
            yield createEvent('content_block_delta', {
              index,
              delta: { type: 'input_json_delta', partial_json: payload }
            });
          }
          yield createEvent('content_block_stop', { index });
          index += 1;
        } else if (block.type === 'tool_result') {
          yield createEvent('content_block_start', {
            index,
            content_block: {
              type: 'tool_result',
              tool_use_id: block.tool_use_id,
              content: block.content,
              is_error: block.is_error
            }
          });
          yield createEvent('content_block_stop', { index });
          index += 1;
        }
      }

      yield createEvent('message_delta', {
        delta: {
          stop_reason: response.stop_reason ?? 'end_turn',
          usage: response.usage
        }
      });
      yield createEvent('message_stop', {});
    }
  };
}
