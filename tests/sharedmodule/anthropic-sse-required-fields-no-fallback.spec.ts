import { describe, expect, it } from '@jest/globals';

import { createAnthropicSequencer } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/anthropic-sequencer.js';
import type { AnthropicMessageResponse } from '../../sharedmodule/llmswitch-core/src/sse/types/index.js';

async function collectEvents(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function baseResponse(overrides: Partial<AnthropicMessageResponse> = {}): AnthropicMessageResponse {
  return {
    id: 'msg_required_fields',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content: [{ type: 'text', text: 'hello' }],
    ...overrides
  };
}

describe('anthropic SSE required fields no-fallback boundary', () => {
  it('throws when response id is missing instead of generating one from request id', async () => {
    const sequencer = createAnthropicSequencer();

    await expect(collectEvents(sequencer.sequenceResponse(
      baseResponse({ id: '' }),
      'req_anthropic_missing_id'
    ))).rejects.toThrow('Invalid Anthropic response: missing id');
  });

  it('throws when response role is missing instead of defaulting to assistant', async () => {
    const sequencer = createAnthropicSequencer();

    await expect(collectEvents(sequencer.sequenceResponse(
      baseResponse({ role: undefined as unknown as 'assistant' }),
      'req_anthropic_missing_role'
    ))).rejects.toThrow('Invalid Anthropic response: missing role');
  });

  it('throws when tool_use id is missing instead of generating one from request id', async () => {
    const sequencer = createAnthropicSequencer();

    await expect(collectEvents(sequencer.sequenceResponse(
      baseResponse({
        content: [{
          type: 'tool_use',
          id: '',
          name: 'exec_command',
          input: { command: 'pwd' }
        }]
      }),
      'req_anthropic_missing_tool_id'
    ))).rejects.toThrow('Invalid Anthropic tool_use block: missing id');
  });

  it('throws when stop_reason is missing instead of defaulting to end_turn', async () => {
    const sequencer = createAnthropicSequencer();

    await expect(collectEvents(sequencer.sequenceResponse(
      baseResponse({ stop_reason: undefined }),
      'req_anthropic_missing_stop_reason'
    ))).rejects.toThrow('Invalid Anthropic response: missing stop_reason');
  });
});
