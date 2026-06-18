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

  test('keeps live stopless continuation tool pair for responses previous_response_id resume', () => {
    const body: Record<string, unknown> = {
      model: 'gpt-5.5',
      previous_response_id: 'resp_prev_stopless_1',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '第一轮 stopless 指令' }]
        },
        {
          type: 'reasoning',
          id: 'reasoning_prev_1',
          summary: [{ type: 'summary_text', text: '**Thinking** 第一轮推理' }]
        },
        {
          type: 'function_call',
          id: 'fc_call_servertool_cli_stopless_1',
          call_id: 'call_servertool_cli_stopless_1',
          name: 'exec_command',
          arguments:
            '{"cmd":"routecodex hook run reasoning_stop --input-json \'{\\"flowId\\":\\"stop_message_flow\\",\\"repeatCount\\":1,\\"maxRepeats\\":3}\'"}'
        },
        {
          type: 'function_call_output',
          call_id: 'call_servertool_cli_stopless_1',
          output:
            '{"ok":true,"toolName":"stop_message_auto","flowId":"stop_message_flow","continuationPrompt":"继续往下做；要是能收尾就直接告诉我做完了，不然就继续推进。","repeatCount":2,"maxRepeats":3}'
        }
      ],
      tools: [
        {
          type: 'function',
          name: 'exec_command',
          parameters: { type: 'object', properties: {}, additionalProperties: false }
        }
      ],
      stream: false
    };

    normalizeResponsesToChatBody(body);

    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(3);
    expect(messages[0]?.role).toBe('user');
    expect(messages[1]?.role).toBe('assistant');
    expect(Array.isArray(messages[1]?.tool_calls)).toBe(true);
    expect((messages[1]?.tool_calls as Array<Record<string, unknown>>)[0]?.id).toBe(
      'call_servertool_cli_stopless_1'
    );
    expect(messages[2]?.role).toBe('tool');
    expect(messages[2]?.tool_call_id).toBe('call_servertool_cli_stopless_1');
  });
});
