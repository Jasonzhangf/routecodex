import { describe, expect, it } from '@jest/globals';
import { deriveFinishReason } from '../../../src/server/utils/finish-reason.js';

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

  it('infers stop for responses payloads with completed assistant output but missing explicit finish reason', () => {
    const reason = deriveFinishReason({
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'done',
            },
          ],
        },
      ],
    });
    expect(reason).toBe('stop');
  });

});
