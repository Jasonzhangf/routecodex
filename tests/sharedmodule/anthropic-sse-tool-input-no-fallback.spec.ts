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

describe('anthropic SSE tool input no-fallback boundary', () => {
  it('throws on unserializable tool input instead of stringifying a fallback value', async () => {
    const cyclic: Record<string, unknown> = { command: 'pwd' };
    cyclic.self = cyclic;

    const response: AnthropicMessageResponse = {
      id: 'msg_anthropic_tool_input_no_fallback',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'exec_command',
          input: cyclic
        }
      ],
      stop_reason: 'tool_use'
    };

    const sequencer = createAnthropicSequencer();

    await expect(collectEvents(sequencer.sequenceResponse(response, 'req_anthropic_tool_input_no_fallback')))
      .rejects.toThrow('Converting circular structure to JSON');
  });
});
