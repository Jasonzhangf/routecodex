import { describe, expect, it } from '@jest/globals';

import { buildClientPayloadForProtocol } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_outbound/resp_outbound_stage1_client_remap/client-remap-protocol-switch.js';

describe('responses completed native tool remap', () => {
  it('RED: responses submit completion must not leak completed native chat tool_calls through choices', () => {
    const payload = {
      id: 'resp_native_completed',
      model: 'gpt-5.4-medium',
      tool_outputs: [
        { tool_call_id: 'native:run_command:3', output: '/tmp/ws\n' }
      ],
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: 'Running `pwd` now.',
            tool_calls: [
              {
                id: 'native:run_command:3',
                type: 'function',
                function: {
                  name: 'run_command',
                  arguments: '{"command_line":"pwd","cwd":"/tmp/ws"}'
                }
              }
            ]
          }
        }
      ]
    };

    const result = buildClientPayloadForProtocol({
      payload: payload as any,
      clientProtocol: 'openai-responses',
      requestId: 'req-test-native-completed-no-chat-leak'
    });

    expect((result as any).status).toBe('completed');
    expect((result as any).required_action).toBeUndefined();
    expect((result as any).choices).toBeUndefined();
    const functionCalls = ((result as any).output ?? []).filter((item: any) => item?.type === 'function_call');
    expect(functionCalls).toHaveLength(1);
    expect(functionCalls[0]).toMatchObject({
      type: 'function_call',
      status: 'completed',
      call_id: 'native:run_command:3',
      name: 'run_command'
    });
  });

  it('RED: Windsurf native run_command response for declared shell_command must survive Responses remap as function_call', () => {
    const payload = {
      id: 'chatcmpl-windsurf-native-shell-command',
      object: 'chat.completion',
      created: 1779483975,
      model: 'gpt-5.4-medium',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '## Running command\n\nI’ll run `pwd` exactly as requested.',
            tool_calls: [
              {
                id: 'native:run_command:3',
                type: 'function',
                function: {
                  name: 'run_command',
                  arguments: '{"command_line":"pwd","cwd":"/Users/fanzhang/Documents/github/routecodex"}'
                }
              }
            ]
          }
        }
      ]
    };

    const result = buildClientPayloadForProtocol({
      payload: payload as any,
      clientProtocol: 'openai-responses',
      requestId: 'req-windsurf-native-shell-command-remap',
      requestSemantics: {
        tools: {
          clientToolsRaw: [
            {
              type: 'function',
              function: {
                name: 'shell_command',
                parameters: {
                  type: 'object',
                  properties: { cmd: { type: 'string' } },
                  required: ['cmd'],
                  additionalProperties: false
                }
              }
            }
          ]
        }
      } as any
    }) as any;

    const functionCalls = (result.output ?? []).filter((item: any) => item?.type === 'function_call');
    expect(result.status).toBe('requires_action');
    expect(functionCalls).toHaveLength(1);
    expect(functionCalls[0]).toMatchObject({
      type: 'function_call',
      status: 'in_progress',
      call_id: 'native:run_command:3',
      name: 'shell_command'
    });
    expect(JSON.parse(functionCalls[0].arguments)).toEqual({ cmd: 'pwd' });
    expect(result.required_action?.submit_tool_outputs?.tool_calls?.[0]).toMatchObject({
      tool_call_id: 'native:run_command:3',
      name: 'shell_command',
      function: { name: 'shell_command' }
    });
    expect(JSON.parse(result.required_action.submit_tool_outputs.tool_calls[0].function.arguments)).toEqual({ cmd: 'pwd' });
  });

  it('RED: responses native tool call first turn must allocate response id instead of leaking chatcmpl id for submit resume', () => {
    const payload = {
      id: 'chatcmpl_native_first_turn',
      object: 'chat.completion',
      model: 'gpt-5.4-medium',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'native:run_command:3',
                type: 'function',
                function: {
                  name: 'run_command',
                  arguments: '{"command_line":"pwd","cwd":"/Users/fanzhang/Documents/github/routecodex"}'
                }
              }
            ]
          }
        }
      ]
    };

    const result = buildClientPayloadForProtocol({
      payload: payload as any,
      clientProtocol: 'openai-responses',
      requestId: 'req-test-native-first-turn-response-id'
    }) as any;

    expect(result.status).toBe('requires_action');
    expect(result.id).toMatch(/^resp[_-]/);
    expect(result.id).not.toMatch(/^chatcmpl/);
    expect(result.required_action?.submit_tool_outputs?.tool_calls?.[0]?.tool_call_id).toBe('native:run_command:3');
  });

});
