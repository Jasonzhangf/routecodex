import { describe, expect, it } from '@jest/globals';
import { deriveFinishReason } from '../../../src/server/utils/finish-reason.js';

describe('deriveFinishReason visible success coverage', () => {
  it('returns explicit tool_calls when required_action tool calls exist', () => {
    expect(
      deriveFinishReason({
        status: 'requires_action',
        required_action: {
          submit_tool_outputs: {
            tool_calls: [{ id: 'call_1', type: 'function', name: 'exec_command' }],
          },
        },
      })
    ).toBe('tool_calls');
  });

  it('returns stop for chat-like visible assistant success without explicit finish_reason', () => {
    expect(
      deriveFinishReason({
        id: 'chatcmpl_router_direct_finish_reason',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'ok from router direct',
            },
          },
        ],
      })
    ).toBe('stop');
  });

  it('returns stop for responses completed visible output without explicit finish_reason', () => {
    expect(
      deriveFinishReason({
        id: 'resp_router_direct_visible_output',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'done' }],
          },
        ],
      })
    ).toBe('stop');
  });
});
