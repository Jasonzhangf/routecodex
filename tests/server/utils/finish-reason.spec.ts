import { describe, expect, it } from '@jest/globals';
import { deriveFinishReason, STREAM_LOG_FINISH_REASON_KEY } from '../../../src/server/utils/finish-reason.js';

describe('deriveFinishReason', () => {
  it('infers tool_calls for chat payloads with message.tool_calls but missing choice.finish_reason', () => {
    const reason = deriveFinishReason({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' }
              }
            ]
          }
        }
      ]
    });
    expect(reason).toBe('tool_calls');
  });

  it('infers stop for chat payloads with assistant content but missing finish reason', () => {
    const reason = deriveFinishReason({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'done'
          }
        }
      ]
    });
    expect(reason).toBe('stop');
  });

  it('keeps wrapper finish reason fallback', () => {
    const reason = deriveFinishReason({
      [STREAM_LOG_FINISH_REASON_KEY]: 'tool_calls'
    });
    expect(reason).toBe('tool_calls');
  });
});

