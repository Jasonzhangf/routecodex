import { describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const mockConvertProviderResponse = jest.fn();
const mockCreateSnapshotRecorder = jest.fn(async () => ({ record: () => {} }));
const mockSyncReasoningStopModeFromRequest = jest.fn(() => 'off');
const mockSyncStoplessGoalStateFromRequest = jest.fn(() => ({
  stateKey: 'session:test',
  hadDirective: false,
  directiveTypes: []
}));
const mockPersistStoplessGoalStateSnapshot = jest.fn();
const mockLoadRoutingInstructionStateSync = jest.fn(() => null);
const mockReadStoplessGoalState = jest.fn((adapterContext: Record<string, unknown>) => {
  const sessionId = typeof adapterContext?.sessionId === 'string' ? adapterContext.sessionId : undefined;
  return {
    ...(sessionId ? { stateKey: `session:${sessionId}` } : {}),
    state: mockLoadRoutingInstructionStateSync(sessionId ? `session:${sessionId}` : '')?.stoplessGoalState
  };
});
const mockBridgeModule = () => ({
  convertProviderResponse: mockConvertProviderResponse,
  createSnapshotRecorder: mockCreateSnapshotRecorder,
  requireCoreDist: jest.fn(() => ({
    normalizeResponsesToolCallArgumentsForClientWithNative: (payload: unknown, toolsRaw: unknown[]) => {
      const toolName =
        Array.isArray(toolsRaw) && toolsRaw[0] && typeof toolsRaw[0] === 'object'
          ? String((((toolsRaw[0] as any).function || (toolsRaw[0] as any)).name) || '')
          : '';
      if (!payload || typeof payload !== 'object' || toolName !== 'exec_command') {
        return payload as Record<string, unknown>;
      }
      const cloned = JSON.parse(JSON.stringify(payload));
      const normalizeArgs = (holder: any) => {
        if (!holder || typeof holder !== 'object') {
          return;
        }
        try {
          const parsed = typeof holder.arguments === 'string' ? JSON.parse(holder.arguments) : holder.arguments;
          if (parsed && typeof parsed === 'object' && typeof parsed.command === 'string' && !parsed.cmd) {
            holder.arguments = JSON.stringify({ cmd: parsed.command });
          }
        } catch {
          // keep original shape on parse failure
        }
        if (holder.function && typeof holder.function === 'object') {
          holder.function.arguments = holder.arguments;
        }
      };
      const output = Array.isArray((cloned as any).output) ? (cloned as any).output : [];
      for (const item of output) {
        if (item && typeof item === 'object' && item.type === 'function_call') {
          normalizeArgs(item);
        }
      }
      const toolCalls = Array.isArray((cloned as any)?.required_action?.submit_tool_outputs?.tool_calls)
        ? (cloned as any).required_action.submit_tool_outputs.tool_calls
        : [];
      for (const toolCall of toolCalls) {
        normalizeArgs(toolCall);
      }
      return cloned;
    },
  })),
  importCoreDist: jest.fn(async () => ({
    normalizeResponsesToolCallArgumentsForClientWithNative: (payload: unknown, toolsRaw: unknown[]) => {
      const toolName =
        Array.isArray(toolsRaw) && toolsRaw[0] && typeof toolsRaw[0] === 'object'
          ? String((((toolsRaw[0] as any).function || (toolsRaw[0] as any)).name) || '')
          : '';
      if (!payload || typeof payload !== 'object' || toolName !== 'exec_command') {
        return payload as Record<string, unknown>;
      }
      const cloned = JSON.parse(JSON.stringify(payload));
      const normalizeArgs = (holder: any) => {
        if (!holder || typeof holder !== 'object') {
          return;
        }
        try {
          const parsed = typeof holder.arguments === 'string' ? JSON.parse(holder.arguments) : holder.arguments;
          if (parsed && typeof parsed === 'object' && typeof parsed.command === 'string' && !parsed.cmd) {
            holder.arguments = JSON.stringify({ cmd: parsed.command });
          }
        } catch {
          // keep original shape on parse failure
        }
        if (holder.function && typeof holder.function === 'object') {
          holder.function.arguments = holder.arguments;
        }
      };
      const output = Array.isArray((cloned as any).output) ? (cloned as any).output : [];
      for (const item of output) {
        if (item && typeof item === 'object' && item.type === 'function_call') {
          normalizeArgs(item);
        }
      }
      const toolCalls = Array.isArray((cloned as any)?.required_action?.submit_tool_outputs?.tool_calls)
        ? (cloned as any).required_action.submit_tool_outputs.tool_calls
        : [];
      for (const toolCall of toolCalls) {
        normalizeArgs(toolCall);
      }
      return cloned;
    },
  })),
  syncReasoningStopModeFromRequest: mockSyncReasoningStopModeFromRequest,
  syncStoplessGoalStateFromRequest: mockSyncStoplessGoalStateFromRequest,
  persistStoplessGoalStateSnapshot: mockPersistStoplessGoalStateSnapshot,
  loadRoutingInstructionStateSync: mockLoadRoutingInstructionStateSync,
  readStoplessGoalState: mockReadStoplessGoalState,
  sanitizeFollowupText: async (raw: unknown) => (typeof raw === 'string' ? raw : ''),
  deriveFinishReasonNative: jest.fn(() => undefined),
  updateResponsesContractProbeFromSseChunkNative: jest.fn(() => ({})),
  buildResponsesTerminalSseFramesFromProbeNative: jest.fn(() => [])
});

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);

describe('provider-response-converter unified semantics handoff', () => {
  it('forwards unified continuation/audit semantics into bridge conversion and returns bridge-remapped client body', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockSyncReasoningStopModeFromRequest.mockClear();

    mockConvertProviderResponse.mockImplementation(async ({ requestSemantics, context }) => ({
      body: {
        object: 'response',
        id: 'resp_client_converter_1',
        previous_response_id:
          (requestSemantics as any)?.continuation?.resumeFrom?.previousResponseId ?? null,
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'provider-response-converter ok' }]
          }
        ],
        observed_chain_id: (requestSemantics as any)?.continuation?.chainId,
        observed_unsupported_count:
          Array.isArray((requestSemantics as any)?.audit?.protocolMapping?.unsupported)
            ? (requestSemantics as any).audit.protocolMapping.unsupported.length
            : 0,
        observed_captured_has_messages: Array.isArray((context as any)?.capturedChatRequest?.messages)
      }
    }));

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const requestSemantics = {
      continuation: {
        chainId: 'req_chain_converter_1',
        stickyScope: 'request_chain',
        stateOrigin: 'openai-responses',
        resumeFrom: {
          protocol: 'openai-responses',
          requestId: 'req_chain_converter_1',
          previousResponseId: 'resp_prev_converter_1'
        }
      },
      audit: {
        protocolMapping: {
          unsupported: [
            {
              field: 'response_format',
              disposition: 'unsupported',
              sourceProtocol: 'openai-responses',
              targetProtocol: 'anthropic-messages',
              reason: 'structured_output_not_supported',
              source: 'chat.parameters'
            }
          ]
        }
      }
    };

    const result = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_converter_semantics_1',
        wantsStream: false,
        requestSemantics: requestSemantics as any,
        originalRequest: {
          model: 'claude-sonnet-4-5',
          input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行 converter 语义链' }] }]
        },
        response: {
          body: {
            id: 'msg_provider_converter_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            stop_reason: 'end_turn'
          }
        } as any,
        pipelineMetadata: {
          capturedChatRequest: {
            model: 'claude-sonnet-4-5',
            messages: [{ role: 'user', content: '继续执行 converter 语义链' }]
          }
        }
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    expect(mockConvertProviderResponse).toHaveBeenCalledTimes(1);
    const bridgeArgs = mockConvertProviderResponse.mock.calls[0]?.[0] as Record<string, any>;
    expect(bridgeArgs?.providerProtocol).toBe('anthropic-messages');
    expect(bridgeArgs?.entryEndpoint).toBe('/v1/responses');
    expect(bridgeArgs?.requestSemantics).toMatchObject({
      continuation: {
        chainId: 'req_chain_converter_1',
        stickyScope: 'request_chain',
        resumeFrom: {
          previousResponseId: 'resp_prev_converter_1'
        }
      },
      audit: {
        protocolMapping: {
          unsupported: [
            expect.objectContaining({
              field: 'response_format',
              reason: 'structured_output_not_supported'
            })
          ]
        }
      }
    });

    expect((result as any).body).toMatchObject({
      object: 'response',
      previous_response_id: 'resp_prev_converter_1',
      observed_chain_id: 'req_chain_converter_1',
      observed_unsupported_count: 1,
      observed_captured_has_messages: true
    });
  });

  it('unwraps snapshot-style anthropic provider-response body.data before bridge conversion', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockSyncReasoningStopModeFromRequest.mockClear();

    mockConvertProviderResponse.mockImplementationOnce(async ({ providerResponse }) => ({
      body: {
        object: 'response',
        id: 'resp_unwrapped_1',
        output: [
          {
            type: 'function_call',
            name: 'apply_patch',
            arguments: JSON.stringify({ patch: '*** Begin Patch\\n*** End Patch' }),
            call_id: 'toolu_1'
          }
        ]
      }
    }));

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const result = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_converter_unwrap_1',
        wantsStream: false,
        requestSemantics: {
          tools: {
            clientToolsRaw: [
              {
                type: 'function',
                function: {
                  name: 'apply_patch',
                  parameters: { type: 'object' }
                }
              }
            ]
          }
        } as any,
        originalRequest: {
          model: 'deepseek-v4-flash',
          input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行' }] }]
        },
        response: {
          body: {
            body: {
              data: {
                id: 'msg_provider_wrapped_1',
                type: 'message',
                role: 'assistant',
                stop_reason: 'tool_use',
                content: [
                  {
                    id: 'toolu_1',
                    type: 'tool_use',
                    name: 'apply_patch',
                    input: {
                      patch: '*** Begin Patch\n*** End Patch'
                    }
                  }
                ]
              }
            },
            headers: {
              'content-type': 'application/json'
            },
            meta: {
              stage: 'provider-response'
            }
          }
        } as any,
        pipelineMetadata: {}
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    expect(mockConvertProviderResponse).toHaveBeenCalledTimes(1);
    const bridgeArgs = mockConvertProviderResponse.mock.calls[0]?.[0] as Record<string, any>;
    expect(bridgeArgs?.providerResponse).toMatchObject({
      id: 'msg_provider_wrapped_1',
      stop_reason: 'tool_use',
      content: [
        expect.objectContaining({
          type: 'tool_use',
          name: 'apply_patch'
        })
      ]
    });
    expect((result as any).body).toMatchObject({
      object: 'response',
      id: 'resp_unwrapped_1',
      output: [
        expect.objectContaining({
          type: 'function_call',
          name: 'apply_patch'
        })
      ]
    });
  });

  it('normalizes responses required_action exec_command arguments through rust ssot before host validation', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockSyncReasoningStopModeFromRequest.mockClear();
    mockSyncStoplessGoalStateFromRequest.mockClear();
    mockLoadRoutingInstructionStateSync.mockReset();
    mockLoadRoutingInstructionStateSync.mockReturnValue(null);

    mockConvertProviderResponse.mockResolvedValueOnce({
      body: {
        object: 'response',
        id: 'resp_tool_args_repaired_1',
        status: 'requires_action',
        output: [
          {
            type: 'function_call',
            name: 'exec_command',
            call_id: 'call_exec_1',
            arguments: JSON.stringify({ command: 'pwd' }),
            function: {
              name: 'exec_command',
              arguments: JSON.stringify({ command: 'pwd' })
            }
          }
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              {
                id: 'call_exec_1',
                type: 'function',
                name: 'exec_command',
                arguments: JSON.stringify({ command: 'pwd' }),
                function: {
                  name: 'exec_command',
                  arguments: JSON.stringify({ command: 'pwd' })
                }
              }
            ]
          }
        }
      }
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const result = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_responses_tool_args_repaired_1',
        wantsStream: false,
        requestSemantics: {
          tools: {
            clientToolsRaw: [
              {
                type: 'function',
                function: {
                  name: 'exec_command',
                  parameters: {
                    type: 'object',
                    properties: {
                      cmd: { type: 'string' }
                    },
                    required: ['cmd'],
                    additionalProperties: false
                  }
                }
              }
            ]
          }
        } as any,
        originalRequest: {
          model: 'gpt-5.4',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'run pwd' }] }]
        },
        response: {
          body: {
            id: 'provider_resp_repaired_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            stop_reason: 'tool_use'
          }
        } as any,
        pipelineMetadata: {
          capturedChatRequest: {
            model: 'gpt-5.4',
            tools: [
              {
                type: 'function',
                function: {
                  name: 'exec_command',
                  parameters: {
                    type: 'object',
                    properties: {
                      cmd: { type: 'string' }
                    },
                    required: ['cmd'],
                    additionalProperties: false
                  }
                }
              }
            ]
          }
        }
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    const toolCall = (result.body as any)?.required_action?.submit_tool_outputs?.tool_calls?.[0];
    expect(toolCall?.arguments).toBe(JSON.stringify({ cmd: 'pwd' }));
    expect(toolCall?.function?.arguments).toBe(JSON.stringify({ cmd: 'pwd' }));
    expect((result.body as any)?.output?.[0]?.arguments).toBe(JSON.stringify({ cmd: 'pwd' }));
  });

  it('preserves anthropic tool_use on real reasoning_stop_guard followup sample instead of collapsing to empty tool_calls', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockSyncReasoningStopModeFromRequest.mockClear();

    const sampleDir = path.join(
      '/Volumes/extension/.rcc/codex-samples/openai-responses/mimo.key1.mimo-v2.5-pro',
      'openai-responses-mimo.key1-mimo-v2.5-pro-20260507T220242798-168767-1436_reasoning_stop_guard'
    );
    if (!fs.existsSync(sampleDir)) {
      return;
    }

    const { convertProviderResponse: coreConvertProviderResponse } = await import(
      '../../../../../sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.js'
    );
    mockConvertProviderResponse.mockImplementation(async (args) => coreConvertProviderResponse(args as any));

    const providerResponseDoc = JSON.parse(
      fs.readFileSync(path.join(sampleDir, 'provider-response.json'), 'utf8')
    ) as Record<string, any>;

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const result = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_converter_real_reasoning_stop_guard_followup',
        wantsStream: false,
        requestSemantics: {
          tools: {
            clientToolsRaw: [
              {
                type: 'function',
                function: {
                  name: 'exec_command',
                  parameters: {
                    type: 'object',
                    properties: { cmd: { type: 'string' } },
                    required: ['cmd']
                  }
                }
              }
            ]
          },
          __routecodex: {
            serverToolFollowup: true,
            serverToolFollowupSource: 'servertool.reasoning_stop_guard'
          }
        } as any,
        originalRequest: {
          model: 'mimo-v2.5-pro',
          input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行' }] }]
        },
        response: providerResponseDoc as any,
        pipelineMetadata: {
          capturedChatRequest: {
            model: 'mimo-v2.5-pro',
            messages: [{ role: 'user', content: '继续执行' }],
            tools: [
              {
                type: 'function',
                function: {
                  name: 'exec_command',
                  parameters: { type: 'object' }
                }
              }
            ]
          },
          __rt: {
            serverToolFollowup: true,
            clientProtocol: 'openai-responses'
          }
        }
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    const body = (result as any).body;
    const toolCalls = body?.choices?.[0]?.message?.tool_calls;
    expect(Array.isArray(toolCalls)).toBe(true);
    expect(toolCalls?.[0]?.function?.name).toBe('exec_command');
    expect(body?.choices?.[0]?.finish_reason).toBe('tool_calls');
  });

  it('failing-shape replay: preserves empty completed payload for downstream response-contract gate', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockSyncReasoningStopModeFromRequest.mockClear();

    mockConvertProviderResponse.mockResolvedValueOnce({
      body: {
        object: 'response',
        id: 'resp_empty_output_contract_1',
        status: 'completed',
        output: []
      }
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const converted = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        requestId: 'req_empty_output_contract_1',
        wantsStream: false,
        requestSemantics: {} as any,
        originalRequest: { model: 'gpt-5', input: 'hello' } as any,
        response: { body: { status: 'completed', output: [] } } as any,
        pipelineMetadata: {}
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    expect((converted as any).body).toMatchObject({
      object: 'response',
      id: 'resp_empty_output_contract_1',
      status: 'completed',
      output: []
    });
    expect(Array.isArray((converted as any).body?.output)).toBe(true);
    expect((converted as any).body?.output).toHaveLength(0);
  });

  it('preserves explicit providerProtocol on /v1/responses instead of remapping from providerType', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementationOnce(async ({ providerProtocol, entryEndpoint }) => ({
      __sse_responses:
        providerProtocol === 'openai-responses' && entryEndpoint === '/v1/responses'
          ? ({ pipe: () => undefined } as any)
          : undefined,
      body: {
        id: 'resp_protocol_preserved_1',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: `protocol=${String(providerProtocol)}` }],
          },
        ],
      },
    }));

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const result = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        providerType: 'openai',
        requestId: 'req_converter_protocol_preserve_1',
        wantsStream: true,
        response: {
          body: {
            id: 'chatcmpl_protocol_preserve_1',
            object: 'chat.completion',
            model: 'gpt-5.4-medium',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'hello' },
                finish_reason: 'stop',
              },
            ],
          },
        } as any,
        pipelineMetadata: {},
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined,
        },
        executeNested: async () => ({ body: { ok: true } } as any),
      },
    );

    expect(mockConvertProviderResponse).toHaveBeenCalledTimes(1);
    const bridgeArgs = mockConvertProviderResponse.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(bridgeArgs?.providerProtocol).toBe('openai-responses');
    expect((result as any).body?.__sse_responses).toBeDefined();
  });

  it('does not start stopless reenter followup after client disconnect', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const { trackClientConnectionState } = await import(
      '../../../../../src/server/utils/client-connection-state.js'
    );
    const req = new EventEmitter() as any;
    req.headers = {};
    const res = new EventEmitter() as any;
    res.writableFinished = false;
    res.writableEnded = false;
    const clientConnectionState = trackClientConnectionState(req, res);
    res.emit('close');

    mockConvertProviderResponse.mockImplementationOnce(async ({ reenterPipeline }) => {
      await reenterPipeline({
        entryEndpoint: '/v1/responses',
        requestId: 'req_stopless_client_disconnect_1_followup',
        body: { model: 'gpt-5.5', input: '继续执行' },
        metadata: {}
      });
      return { body: { id: 'resp_should_not_continue' } };
    });

    const executeNested = jest.fn(async () => ({ body: { id: 'resp_nested_started' } } as any));
    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await expect(convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        providerType: 'openai',
        requestId: 'req_stopless_client_disconnect_1',
        wantsStream: true,
        response: { body: { id: 'resp_seed_stopless' } } as any,
        requestSemantics: {} as any,
        originalRequest: { model: 'gpt-5.5', input: 'continue' } as any,
        pipelineMetadata: {
          clientConnectionState,
          __rt: { serverToolFollowup: true, clientProtocol: 'openai-responses' }
        }
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined,
        },
        executeNested,
      },
    )).rejects.toMatchObject({ code: 'CLIENT_DISCONNECTED' });
    expect(executeNested).not.toHaveBeenCalled();
  });

  it('fails marker-only provider SSE wrapper before Rust bridge conversion on live executor converter path', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await expect(convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'anthropic-messages',
        providerType: 'anthropic',
        providerFamily: 'anthropic',
        providerKey: 'mimo.key2.mimo-v2.5',
        requestId: 'req_live_marker_only_wrapper_240540',
        wantsStream: true,
        response: {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
            body: { captureSse: true, mode: 'sse', transport: 'prepared-request-executor' }
          }
        } as any,
        pipelineMetadata: {}
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined,
        },
        executeNested: async () => ({ body: { ok: true } } as any),
      },
    )).rejects.toThrow('__sse_responses');
    expect(mockConvertProviderResponse).toHaveBeenCalledTimes(1);
  });
});
