import { describe, expect, it, jest } from '@jest/globals';

const mockConvertProviderResponse = jest.fn();
const mockCreateSnapshotRecorder = jest.fn(async () => ({ record: () => {} }));
const mockSyncReasoningStopModeFromRequest = jest.fn(() => 'off');
const logStageSpy = jest.fn();

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.js', () => ({
  convertProviderResponse: mockConvertProviderResponse,
  createSnapshotRecorder: mockCreateSnapshotRecorder,
  syncReasoningStopModeFromRequest: mockSyncReasoningStopModeFromRequest,
  sanitizeFollowupText: async (raw: unknown) => (typeof raw === 'string' ? raw : ''),
  syncStoplessGoalStateFromRequest: () => null,
  readStoplessGoalState: () => null,
  persistStoplessGoalStateSnapshot: () => undefined,
  deriveFinishReasonNative: () => undefined,
  updateResponsesContractProbeFromSseChunkNative: () => ({}),
  buildResponsesTerminalSseFramesFromProbeNative: () => [],
  resolveRelayResponsesClientSseStreamForHttp: () => undefined,
  requireCoreDist: () => ({}),
  importCoreDist: async () => ({})
}));

jest.unstable_mockModule('../../../../../src/server/utils/stage-logger.js', () => ({
  logPipelineStage: logStageSpy
}));

describe('provider-response-converter error logging', () => {
  it('surfaces SSE wrapper error in chat mode', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockSyncReasoningStopModeFromRequest.mockClear();
    logStageSpy.mockReset();

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await expect(convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        requestId: 'req_chat_wrapper_error_1',
        processMode: 'chat',
        wantsStream: true,
        serverToolsEnabled: true,
        response: {
          status: 200,
          body: {
            mode: 'sse',
            error: {
              message: 'gateway unavailable',
              code: 'UPSTREAM_UNAVAILABLE',
              statusCode: 503
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
    )).rejects.toMatchObject({
      code: 'HTTP_502',
      upstreamCode: 'UPSTREAM_UNAVAILABLE',
      statusCode: 502
    });

    expect(mockConvertProviderResponse).not.toHaveBeenCalled();
  });

  it('applies provider configured error mapping before throwing SSE wrapper errors', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockSyncReasoningStopModeFromRequest.mockClear();
    logStageSpy.mockReset();

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await expect(convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        providerType: 'responses',
        providerFamily: 'responses',
        providerKey: 'XLC.key2.deepseek-v4-pro',
        requestId: 'req_sse_wrapper_error_mapping_1',
        processMode: 'chat',
        wantsStream: true,
        serverToolsEnabled: true,
        response: {
          status: 200,
          body: {
            mode: 'sse',
            error: {
              message: 'All available accounts exhausted',
              code: 'HTTP_400',
              statusCode: 400,
              type: 'server_error',
              param: ''
            }
          }
        } as any,
        pipelineMetadata: {}
      },
      {
        runtimeManager: {
          resolveRuntimeKey: (providerKey?: string) => providerKey,
          getHandleByRuntimeKey: () => ({
            runtime: {
              extensions: {
                errorMapping: {
                  rules: [
                    {
                      origin: {
                        status: 400,
                        error: {
                          type: 'server_error',
                          messageContains: 'All available accounts exhausted'
                        }
                      },
                      to: {
                        status: 429,
                        code: 'HTTP_429',
                        message: 'All available accounts exhausted'
                      }
                    }
                  ]
                }
              }
            }
          })
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    )).rejects.toMatchObject({
      code: 'HTTP_429',
      upstreamCode: 'HTTP_400',
      status: 429,
      statusCode: 429,
      message: 'All available accounts exhausted',
      response: {
        status: 429,
        data: {
          error: {
            code: 'HTTP_429',
            status: 429,
            message: 'All available accounts exhausted'
          }
        }
      },
      details: {
        providerErrorMapping: {
          originalStatus: 400,
          originalCode: 'SSE_DECODE_ERROR',
          mappedStatus: 429,
          mappedCode: 'HTTP_429'
        }
      }
    });

    expect(mockConvertProviderResponse).not.toHaveBeenCalled();
  });

  it('does not map SSE wrapper errors without provider runtime errorMapping', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockSyncReasoningStopModeFromRequest.mockClear();
    logStageSpy.mockReset();

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await expect(convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        providerType: 'responses',
        providerFamily: 'responses',
        providerKey: 'XLC.key2.deepseek-v4-pro',
        requestId: 'req_sse_wrapper_error_unmapped_1',
        processMode: 'chat',
        wantsStream: true,
        serverToolsEnabled: true,
        response: {
          status: 200,
          body: {
            mode: 'sse',
            error: {
              message: 'All available accounts exhausted',
              code: 'HTTP_400',
              statusCode: 400,
              type: 'server_error',
              param: ''
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
    )).rejects.toMatchObject({
      code: 'SSE_DECODE_ERROR',
      upstreamCode: 'HTTP_400',
      status: 400,
      statusCode: 400,
      response: {
        status: 400,
        data: {
          error: {
            code: 'HTTP_400',
            status: 400,
            message: 'All available accounts exhausted'
          }
        }
      }
    });

    expect(mockConvertProviderResponse).not.toHaveBeenCalled();
  });

  it('does not emit convert.bridge.error stage for provider business error 2056', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockSyncReasoningStopModeFromRequest.mockClear();
    logStageSpy.mockReset();

    mockConvertProviderResponse.mockRejectedValueOnce(Object.assign(new Error(
      '[hub_response] Upstream provider returned structured business error at chat_process.response.entry: usage limit exceeded, weekly usage limit reached'
    ), {
      name: 'ProviderProtocolError',
      code: 'HTTP_429_2056',
      upstreamCode: 'HTTP_429_2056',
      details: {
        detected: 'provider_business_error',
        reason: 'provider_business_error',
        providerStatusCode: 2056
      }
    }));

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await expect(convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        requestId: 'req_no_duplicate_convert_bridge_2056',
        wantsStream: false,
        response: { body: { id: 'upstream_body' } } as any,
        pipelineMetadata: {}
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    )).rejects.toMatchObject({
      code: 'HTTP_429_2056',
      upstreamCode: 'HTTP_429_2056'
    });

    expect(
      logStageSpy.mock.calls.some(
        (call) => call[0] === 'convert.bridge.error' && call[1] === 'req_no_duplicate_convert_bridge_2056'
      )
    ).toBe(true);
  });
});
