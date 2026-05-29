import { describe, expect, it, jest } from '@jest/globals';

const mockBridgeModule = () => ({
  importCoreDist: async (subpath: string) => {
    if (subpath === 'conversion/shared/responses-conversation-store') {
      return await import('../../../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js');
    }
    if (subpath === 'router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics') {
      return {
        buildResponsesPayloadFromChatWithNative: (payload: any, context: any) => {
          const output = { object: 'response', id: 'resp_test', status: 'requires_action', output: [{ type: 'function_call', status: 'in_progress', call_id: 'native:run_command:3', name: 'shell_command', arguments: JSON.stringify({ cmd: 'pwd' }) }], required_action: { type: 'submit_tool_outputs', submit_tool_outputs: { tool_calls: [{ id: 'native:run_command:3', tool_call_id: 'native:run_command:3', type: 'function', name: 'shell_command', arguments: JSON.stringify({ cmd: 'pwd' }), function: { name: 'shell_command', arguments: JSON.stringify({ cmd: 'pwd' }) } }] } } };
          return output;
        },
        normalizeResponsesToolCallArgumentsForClientWithNative: (payload: any, toolsRaw: any[]) => {
          const declared = toolsRaw?.[0]?.function?.name ?? toolsRaw?.[0]?.name;
          const clone = JSON.parse(JSON.stringify(payload));
          if (declared === 'shell_command') {
            for (const item of clone.output ?? []) {
              if (item?.type === 'function_call' && item.name === 'run_command') {
                item.name = 'shell_command';
                item.arguments = JSON.stringify({ cmd: JSON.parse(item.arguments).command_line });
              }
            }
            for (const call of clone.required_action?.submit_tool_outputs?.tool_calls ?? []) {
              if (call?.name === 'run_command') {
                call.name = 'shell_command';
                call.arguments = JSON.stringify({ cmd: JSON.parse(call.arguments).command_line });
                call.function.name = 'shell_command';
                call.function.arguments = call.arguments;
              }
            }
          }
          return clone;
        }
      };
    }
    throw new Error(`unexpected importCoreDist ${subpath}`);
  },
  convertProviderResponse: async (options: any) => {
    const { convertProviderResponse } = await import('../../../../../sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.js');
    return convertProviderResponse(options);
  },
  createSnapshotRecorder: jest.fn(async () => ({ record: () => {} })),
  persistStoplessGoalStateSnapshot: jest.fn(),
  readStoplessGoalState: jest.fn(() => null),
  requireCoreDist: jest.fn(() => ({})),
  syncReasoningStopModeFromRequest: jest.fn(() => 'off'),
  syncStoplessGoalStateFromRequest: jest.fn(() => ({ stateKey: 'session:test', hadDirective: false, directiveTypes: [] })),
  loadRoutingInstructionStateSync: jest.fn(() => null),
  sanitizeFollowupText: async (raw: unknown) => (typeof raw === 'string' ? raw : '')

});

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);

describe('provider response converter Windsurf tool remap', () => {
  it('RED: converter must use original request tools when requestSemantics lost Windsurf first-turn tools', async () => {
    const { buildClientPayloadForProtocol } = await import('../../../../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_outbound/resp_outbound_stage1_client_remap/client-remap-protocol-switch.js');
    const direct = buildClientPayloadForProtocol({ payload: { id: 'x', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'native:run_command:3', type: 'function', function: { name: 'run_command', arguments: '{\"command_line\":\"pwd\",\"cwd\":\"\"}' } }] } }] } as any, clientProtocol: 'openai-responses', requestId: 'direct', requestSemantics: { tools: { clientToolsRaw: [{ type: 'function', name: 'shell_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'], additionalProperties: false } }] } } as any }) as any;
    expect(direct.status).toBe('requires_action');
    const { captureResponsesRequestContext } = await import('../../../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js');
    captureResponsesRequestContext({
      requestId: 'req-windsurf-converter-original-tools',
      payload: { model: 'gpt-5.4-medium', input: [], tools: [] },
      context: { input: [{ role: 'user', content: [{ type: 'input_text', text: 'pwd' }] }] }
    });
    const { convertProviderResponseIfNeeded } = await import('../../../../../src/server/runtime/http-server/executor/provider-response-converter.js');
    const converted = await convertProviderResponseIfNeeded({
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      providerType: 'openai',
      providerFamily: 'windsurf',
      requestId: 'req-windsurf-converter-original-tools',
      serverToolsEnabled: false,
      wantsStream: false,
      processMode: 'standard',
      originalRequest: {
        model: 'gpt-5.4-medium',
        stream: false,
        tools: [
          {
            type: 'function',
            name: 'shell_command',
            parameters: {
              type: 'object',
              properties: { cmd: { type: 'string' } },
              required: ['cmd'],
              additionalProperties: false
            }
          }
        ]
      },
      requestSemantics: undefined,
      response: {
        status: 200,
        body: {
          id: 'chatcmpl-windsurf-native-first',
          object: 'chat.completion',
          created: 1779485009,
          model: 'gpt-5.4-medium',
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: 'I’ll run `pwd`.',
                tool_calls: [
                  {
                    id: 'native:run_command:3',
                    type: 'function',
                    function: {
                      name: 'run_command',
                      arguments: '{"command_line":"pwd","cwd":""}'
                    }
                  }
                ]
              }
            }
          ]
        }
      }
    } as any, {
      runtimeManager: {} as any,
      executeNested: async () => { throw new Error('unexpected nested execution'); }
    } as any);

    const body = converted.body as any;
    const calls = (body.output ?? []).filter((item: any) => item?.type === 'function_call');
    expect(body.object).toBe('response');
    expect(body.status).toBe('requires_action');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      call_id: 'native:run_command:3',
      name: 'shell_command',
      type: 'function_call'
    });
    expect(JSON.parse(calls[0].arguments)).toEqual({ cmd: 'pwd' });
  });

  it('RED: converter must keep responses conversation entry for submit_tool_outputs after rescue remap', async () => {
    const storeMod = await import('../../../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js');
    const requestId = 'req-windsurf-converter-retention';
    storeMod.clearResponsesConversationByRequestId(requestId);
    storeMod.captureResponsesRequestContext({
      requestId,
      payload: { model: 'gpt-5.4-medium', input: [{ role: 'user', content: [{ type: 'input_text', text: 'pwd' }] }], tools: [] },
      context: { input: [{ role: 'user', content: [{ type: 'input_text', text: 'pwd' }] }] }
    });
    const { convertProviderResponseIfNeeded } = await import('../../../../../src/server/runtime/http-server/executor/provider-response-converter.js');
    const converted = await convertProviderResponseIfNeeded({
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      providerType: 'openai',
      providerFamily: 'windsurf',
      requestId,
      serverToolsEnabled: false,
      wantsStream: false,
      processMode: 'standard',
      originalRequest: {
        model: 'gpt-5.4-medium',
        stream: false,
        tools: [
          {
            type: 'function',
            name: 'shell_command',
            parameters: {
              type: 'object',
              properties: { cmd: { type: 'string' } },
              required: ['cmd'],
              additionalProperties: false
            }
          }
        ]
      },
      requestSemantics: undefined,
      response: {
        status: 200,
        body: {
          id: 'chatcmpl-windsurf-native-first-retention',
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
                      arguments: '{"command_line":"pwd","cwd":""}'
                    }
                  }
                ]
              }
            }
          ]
        }
      }
    } as any, {
      runtimeManager: {} as any,
      executeNested: async () => { throw new Error('unexpected nested execution'); }
    } as any);

    const body = converted.body as any;
    expect(body.status).toBe('requires_action');
    expect(() => storeMod.recordResponsesResponse({ requestId, response: body })).not.toThrow();
    const resumed = storeMod.resumeResponsesConversation(body.id, {
      model: 'gpt-5.4-medium',
      tool_outputs: [{ tool_call_id: 'native:run_command:3', output: '/Users/fanzhang/Documents/github/routecodex\n' }]
    } as any, { requestId: 'req-windsurf-submit-retention' });
    expect(resumed.payload).toBeTruthy();
    storeMod.clearResponsesConversationByRequestId(requestId);
  });

});
