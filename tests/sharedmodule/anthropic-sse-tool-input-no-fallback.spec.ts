import { describe, expect, it } from '@jest/globals';

import { buildAnthropicSseEventSequenceWithNative } from '../../sharedmodule/llmswitch-core/dist/native/router-hotpath/native-anthropic-sse-event-payload.js';

type AnthropicMessageResponse = Record<string, unknown> & {
  content?: unknown[];
};

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

    
    expect(() => buildAnthropicSseEventSequenceWithNative({
      response,
      requestId: 'req_anthropic_tool_input_no_fallback'
    })).toThrow('json stringify failed');
  });
});
