import { describe, expect, it } from '@jest/globals';

import { createAnthropicResponseBuilder } from '../../sharedmodule/llmswitch-core/src/sse/sse-to-json/builders/anthropic-response-builder.js';
import type { AnthropicSseEvent } from '../../sharedmodule/llmswitch-core/src/sse/types/index.js';

function event(type: AnthropicSseEvent['type'], data: unknown): AnthropicSseEvent {
  return {
    type,
    event: type,
    protocol: 'anthropic-messages',
    direction: 'sse_to_json',
    timestamp: 1,
    data,
    sequenceNumber: 0
  } as AnthropicSseEvent;
}

describe('anthropic response builder no message fallback boundary', () => {
  it('fails completed streams with missing message id instead of generating one', () => {
    const builder = createAnthropicResponseBuilder();

    builder.processEvent(event('message_start', {
      message: { type: 'message', role: 'assistant', model: 'claude-test' }
    }));
    builder.processEvent(event('message_stop', {}));

    const result = builder.getResult();
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Anthropic SSE stream missing message id');
  });

  it('fails completed streams with missing role instead of defaulting to assistant', () => {
    const builder = createAnthropicResponseBuilder();

    builder.processEvent(event('message_start', {
      message: { id: 'msg_1', type: 'message', model: 'claude-test' }
    }));
    builder.processEvent(event('message_stop', {}));

    const result = builder.getResult();
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Anthropic SSE stream missing message role');
  });

  it('fails completed streams with missing model instead of using unknown', () => {
    const builder = createAnthropicResponseBuilder();

    builder.processEvent(event('message_start', {
      message: { id: 'msg_1', type: 'message', role: 'assistant' }
    }));
    builder.processEvent(event('message_stop', {}));

    const result = builder.getResult();
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Anthropic SSE stream missing message model');
  });
});
