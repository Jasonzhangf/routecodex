import { describe, expect, it } from '@jest/globals';

import { buildAnthropicSseEventSequenceWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-anthropic-sse-event-payload.js';
import type { AnthropicMessageResponse } from '../../sharedmodule/llmswitch-core/src/sse/types/index.js';

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
    })).toThrow('Converting circular structure to JSON');
  });
});
