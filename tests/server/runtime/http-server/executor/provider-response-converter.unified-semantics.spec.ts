import { describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

const mockConvertProviderResponse = jest.fn();
const mockCreateSnapshotRecorder = jest.fn(async () => ({ record: () => {} }));
const mockSyncReasoningStopModeFromRequest = jest.fn(() => 'off');
const mockBridgeModule = () => ({
  convertProviderResponse: mockConvertProviderResponse,
  createSnapshotRecorder: mockCreateSnapshotRecorder,
  syncReasoningStopModeFromRequest: mockSyncReasoningStopModeFromRequest,
  sanitizeFollowupText: async (raw: unknown) => (typeof raw === 'string' ? raw : '')
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
});
