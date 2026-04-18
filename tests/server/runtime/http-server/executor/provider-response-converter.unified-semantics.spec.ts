import { describe, expect, it, jest } from '@jest/globals';

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
});
