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

describe('anthropic response builder tool json no-salvage boundary', () => {
  it('throws on invalid tool_use partial_json instead of preserving it as _raw', () => {
    const builder = createAnthropicResponseBuilder();

    builder.processEvent(event('message_start', {
      message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test' }
    }));
    builder.processEvent(event('content_block_start', {
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'exec_command' }
    }));
    builder.processEvent(event('content_block_delta', {
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"command":' }
    }));

    expect(() => builder.processEvent(event('content_block_stop', { index: 0 })))
      .toThrow(/Unexpected end of JSON input|Expected JSON/);
  });
});
