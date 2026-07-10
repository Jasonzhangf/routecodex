import { describe, expect, it } from '@jest/globals';
import { projectResponsesClientPayloadForClientWithNative } from '../../sharedmodule/helpers/resp-semantics-direct-native.js';
import { buildSseFramesFromJsonDirectNative } from '../../sharedmodule/helpers/sse-direct-native.js';

describe('Responses client tool SSE contract', () => {
  function buildFrames(mode: 'pending' | 'resolved'): string[] {
    const rawPayload = mode === 'resolved'
      ? {
          id: 'resp_tool_resolved',
          object: 'response',
          created_at: 1781149537,
          status: 'completed',
          model: 'gpt-5.5',
          tool_outputs: [
            { tool_call_id: 'call_exec_1', output: '/Users/fanzhang/Documents/github/routecodex' },
          ],
          output: [
            {
              id: 'fc_call_exec_1',
              type: 'function_call',
              status: 'completed',
              name: 'exec_command',
              call_id: 'call_exec_1',
              arguments: '{"cmd":"pwd"}',
            },
          ],
        }
      : {
          id: 'resp_tool_pending',
          object: 'response',
          created_at: 1781149537,
          status: 'completed',
          model: 'gpt-5.5',
          output: [
            {
              id: 'fc_call_exec_1',
              type: 'function_call',
              status: 'completed',
              name: 'exec_command',
              call_id: 'call_exec_1',
              arguments: '{"cmd":"pwd"}',
            },
          ],
        };
    const toolsRaw = [
      {
        type: 'function',
        function: {
          name: 'exec_command',
          parameters: {
            type: 'object',
            properties: {
              cmd: { type: 'string' },
            },
            required: ['cmd'],
            additionalProperties: false,
          },
        },
      },
    ];
    const requestId = `req_tool_contract_${mode}`;
    const projected = projectResponsesClientPayloadForClientWithNative(rawPayload, toolsRaw, {});
    const { frames } = buildSseFramesFromJsonDirectNative({
      protocol: 'openai-responses',
      response: projected,
      requestId,
    });
    return frames;
  }

  it('pending function_call response must surface standard tool events before terminal completion', () => {
    const text = buildFrames('pending').join('');

    expect(text).toContain('event: response.output_item.added');
    expect(text).toContain('event: response.function_call_arguments.done');
    expect(text).toContain('event: response.output_item.done');
    expect(text).toContain('"name":"exec_command"');
    expect(text).not.toContain('event: response.required_action');
    expect(text.indexOf('event: response.output_item.done')).toBeLessThan(text.indexOf('event: response.completed'));
  });

  it('resolved tool output must remain completed and must not synthesize required_action', () => {
    const text = buildFrames('resolved').join('');

    expect(text).not.toContain('event: response.required_action');
    expect(text).toContain('event: response.completed');
    expect(text).toContain('"status":"completed"');
  });
});
