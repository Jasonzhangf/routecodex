import { describe, expect, test } from '@jest/globals';

import { filterOutExecutedServerToolCalls } from '../../src/servertool/strip-servertool-calls.js';

describe('strip executed servertool calls', () => {
  test('strips executed review tool call before client remap sees the payload', () => {
    const finalized: any = {
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_review_1',
                type: 'function',
                function: {
                  name: 'review',
                  arguments: '{"goal":"audit","context":"ctx","focus":"tests"}'
                }
              }
            ]
          }
        }
      ]
    };

    const orchestrationPayload: any = {
      tool_outputs: [
        {
          tool_call_id: 'call_review_1',
          name: 'review',
          content: '{"ok":true}'
        }
      ]
    };

    const result: any = filterOutExecutedServerToolCalls(finalized, orchestrationPayload);

    expect(result.choices[0].message.tool_calls).toEqual([]);
    expect(result.choices[0].finish_reason).toBe('stop');
  });

  test('strips executed clock tool call using tool_outputs signal instead of hard-coded names', () => {
    const finalized: any = {
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_clock_1',
              type: 'function',
              function: {
                name: 'clock',
                arguments: '{"action":"get","items":[],"taskId":""}'
              }
            }
          ]
        }
      ]
    };

    const orchestrationPayload: any = {
      tool_outputs: [
        {
          tool_call_id: 'call_clock_1',
          name: 'clock',
          content: '{"ok":true}'
        }
      ]
    };

    const result: any = filterOutExecutedServerToolCalls(finalized, orchestrationPayload);

    expect(result.messages[0].tool_calls).toEqual([]);
  });
});
