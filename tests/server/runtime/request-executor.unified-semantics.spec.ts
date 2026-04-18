import { afterAll, describe, expect, it, jest } from '@jest/globals';

const mockConvertProviderResponseIfNeeded = jest.fn();

jest.unstable_mockModule('../../../src/server/runtime/http-server/executor/provider-response-converter.js', () => ({
  convertProviderResponseIfNeeded: mockConvertProviderResponseIfNeeded
}));
jest.unstable_mockModule('../../../src/server/runtime/http-server/executor/provider-response-converter.ts', () => ({
  convertProviderResponseIfNeeded: mockConvertProviderResponseIfNeeded
}));

const { HubRequestExecutor } = await import('../../../src/server/runtime/http-server/request-executor.js');
const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

function createRuntimeHandle() {
  return {
    providerType: 'anthropic',
    providerFamily: 'anthropic',
    providerId: 'mock-anthropic',
    instance: {
      processIncoming: jest.fn(async () => ({
        status: 200,
        body: {
          id: 'provider_resp_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn'
        }
      })),
      cleanup: jest.fn()
    }
  } as any;
}

function createExecutorWithSemantics() {
  const handle = createRuntimeHandle();
  const pipelineResult = {
    providerPayload: {
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: '继续执行 runtime 语义链' }]
    },
    standardizedRequest: {
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: '继续执行 runtime 语义链' }],
      semantics: {
        continuation: {
          chainId: 'standardized_should_not_win',
          stickyScope: 'request'
        }
      }
    },
    processedRequest: {
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: '继续执行 runtime 语义链' }],
      semantics: {
        continuation: {
          chainId: 'req_chain_executor_1',
          stickyScope: 'request_chain',
          stateOrigin: 'openai-responses',
          resumeFrom: {
            protocol: 'openai-responses',
            requestId: 'req_chain_executor_1',
            previousResponseId: 'resp_prev_executor_1'
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
      }
    },
    target: {
      providerKey: 'mock.key1.claude-sonnet-4-5',
      providerType: 'anthropic',
      outboundProfile: 'anthropic-messages',
      runtimeKey: 'runtime:key',
      processMode: 'standard'
    },
    processMode: 'standard',
    metadata: {
      capturedChatRequest: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 runtime 语义链' }]
      }
    }
  };

  const fakePipeline = {
    execute: jest.fn().mockResolvedValue(pipelineResult)
  };

  const runtimeManager = {
    resolveRuntimeKey: jest.fn().mockReturnValue('runtime:key'),
    getHandleByRuntimeKey: jest.fn().mockReturnValue(handle),
    getHandleByProviderKey: jest.fn(),
    disposeAll: jest.fn(),
    initialize: jest.fn()
  };

  const deps = {
    runtimeManager,
    getHubPipeline: () => fakePipeline,
    getModuleDependencies: () => ({
      errorHandlingCenter: {
        handleError: jest.fn().mockResolvedValue({ success: true })
      }
    }),
    logStage: jest.fn(),
    stats: {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn()
    }
  };

  return {
    executor: new HubRequestExecutor(deps as any),
    handle,
    fakePipeline
  };
}

describe('request-executor unified semantics handoff', () => {
  it('passes processedRequest unified continuation/audit semantics into provider response conversion and returns converted body', async () => {
    mockConvertProviderResponseIfNeeded.mockReset();
    mockConvertProviderResponseIfNeeded.mockResolvedValue({
      status: 200,
      body: {
        object: 'response',
        id: 'resp_client_executor_1',
        previous_response_id: 'resp_prev_executor_1',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'runtime executor converted ok' }]
          }
        ]
      }
    });

    const { executor, handle } = createExecutorWithSemantics();

    const response = await executor.execute({
      requestId: 'req_executor_semantics_1',
      entryEndpoint: '/v1/responses',
      method: 'POST',
      headers: {},
      query: {},
      body: {
        model: 'claude-sonnet-4-5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行 runtime 语义链' }] }]
      },
      metadata: { stream: false, inboundStream: false }
    } as any);

    expect(handle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(mockConvertProviderResponseIfNeeded).toHaveBeenCalledTimes(1);

    const convertOptions = mockConvertProviderResponseIfNeeded.mock.calls[0]?.[0] as Record<string, any>;
    expect(convertOptions?.entryEndpoint).toBe('/v1/responses');
    expect(convertOptions?.providerProtocol).toBe('anthropic-messages');
    expect(convertOptions?.requestSemantics).toMatchObject({
      continuation: {
        chainId: 'req_chain_executor_1',
        stickyScope: 'request_chain',
        stateOrigin: 'openai-responses',
        resumeFrom: {
          requestId: 'req_chain_executor_1',
          previousResponseId: 'resp_prev_executor_1'
        }
      },
      audit: {
        protocolMapping: {
          unsupported: [
            expect.objectContaining({
              field: 'response_format',
              targetProtocol: 'anthropic-messages',
              reason: 'structured_output_not_supported'
            })
          ]
        }
      }
    });

    expect((response as any).body).toMatchObject({
      object: 'response',
      previous_response_id: 'resp_prev_executor_1',
      status: 'completed'
    });
  });
});

afterAll(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
});
