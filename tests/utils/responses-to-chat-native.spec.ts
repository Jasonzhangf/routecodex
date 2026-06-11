import { describe, expect, test } from '@jest/globals';

import { normalizeResponsesToChatBody } from '../../src/utils/responses-to-chat.js';

describe('responses-to-chat native normalization', () => {
  test('materializes paired Responses function call and output into chat messages', () => {
    const body: Record<string, unknown> = {
      model: 'gpt-5.4-mini',
      previous_response_id: 'resp_prev',
      input: [
        {
          id: 'fc_1',
          type: 'function_call',
          call_id: 'call_1',
          name: 'exec_command',
          arguments: '{"cmd":"pwd"}'
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: '/Users/fanzhang/Documents/github/routecodex'
        }
      ],
      tools: [
        {
          type: 'function',
          name: 'exec_command',
          parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }
        }
      ],
      stream: false
    };

    normalizeResponsesToChatBody(body);

    expect(body.input).toBeUndefined();
    expect(body.previous_response_id).toBeUndefined();
    expect(Array.isArray(body.messages)).toBe(true);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages.some((message) => message.role === 'assistant' && Array.isArray(message.tool_calls))).toBe(true);
    expect(messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_1')).toBe(true);
  });
});
