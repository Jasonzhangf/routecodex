import { describe, expect, it } from '@jest/globals';

import { serializeAnthropicEventToSSE } from '../../sharedmodule/llmswitch-core/src/sse/shared/serializers/anthropic-event-serializer.js';
import { serializeGeminiEventToSSE } from '../../sharedmodule/llmswitch-core/src/sse/shared/serializers/gemini-event-serializer.js';

describe('Anthropic/Gemini SSE serializer no-fallback boundary', () => {
  it('serializes explicit Anthropic event type without synthesizing a default', () => {
    const text = serializeAnthropicEventToSSE({
      type: 'message_stop',
      event: 'message_stop',
      protocol: 'anthropic-messages',
      direction: 'json_to_sse',
      timestamp: 1,
      data: { type: 'message_stop' }
    });

    expect(text).toContain('event: message_stop\n');
    expect(text).toContain('data: {"type":"message_stop"}');
  });

  it('fails Anthropic events missing explicit event/type instead of defaulting to message', () => {
    expect(() => serializeAnthropicEventToSSE({
      protocol: 'anthropic-messages',
      direction: 'json_to_sse',
      timestamp: 1,
      data: { type: 'message_stop' }
    } as never)).toThrow('Invalid Anthropic SSE event: missing event type');
  });

  it('serializes explicit Gemini event type without synthesizing a default', () => {
    const text = serializeGeminiEventToSSE({
      type: 'gemini.done',
      event: 'gemini.done',
      protocol: 'gemini-chat',
      direction: 'json_to_sse',
      timestamp: 1,
      data: { kind: 'done' }
    });

    expect(text).toContain('event: gemini.done\n');
    expect(text).toContain('data: {"kind":"done"}');
  });

  it('fails Gemini events missing explicit event/type instead of defaulting to gemini.data', () => {
    expect(() => serializeGeminiEventToSSE({
      protocol: 'gemini-chat',
      direction: 'json_to_sse',
      timestamp: 1,
      data: { kind: 'done' }
    } as never)).toThrow('Invalid Gemini SSE event: missing event type');
  });
});
