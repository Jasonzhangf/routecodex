import { describe, expect, it, jest } from '@jest/globals';
import { MetadataCenter } from '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const mockConvertProviderResponse = jest.fn();
const mockCreateSnapshotRecorder = jest.fn(async () => ({ record: () => {} }));
const logStageSpy = jest.fn();

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge/provider-response-converter-host.js', () => ({
  convertProviderResponse: mockConvertProviderResponse,
  asFlatRecord: jest.fn((value) => (
    value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  )),
  buildChoicesArrayBridgeDebugDetailsWithNative: jest.fn((args) => {
    const seed = args?.bridgeSeed as Record<string, unknown> | undefined;
    const payload = args?.bridgePayload as Record<string, unknown> | undefined;
    const data = payload?.data as Record<string, unknown> | undefined;
    return {
      bridgeProviderProtocol: args?.bridgeProviderProtocol,
      bridgePayloadHasChoices: Array.isArray(payload?.choices),
      bridgePayloadHasDataChoices: Array.isArray(data?.choices),
      bridgeSeedKeys: seed ? Object.keys(seed) : [],
      bridgePayloadKeys: payload ? Object.keys(payload) : [],
    };
  }),
  buildProviderResponseTimingBreakdownWithNative: jest.fn((value) => value),
  extractBridgeProviderResponsePayload: jest.fn((value) => {
    const record = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
    return record?.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? record.data
      : undefined;
  }),
  extractContentTextForStoplessScan: jest.fn(() => ''),
  extractFirstBalancedJsonObject: jest.fn(() => undefined),
  extractLatestUserTextForStoplessScan: jest.fn(() => ''),
  findNestedErrorMarker: jest.fn(() => undefined),
  findNestedRawString: jest.fn(() => undefined),
  hasStoplessDirectiveInRequestPayload: jest.fn(() => false),
  isContextLengthExceededError: jest.fn(() => false),
  isGenericBridgeResponseContractError: jest.fn(() => false),
  isRetryableNetworkSseWrapperError: jest.fn(() => false),
  shouldAllowDirectResponsesPrebuiltSsePassthroughWithNative: jest.fn(() => false),
  tryParseJsonLikeString: jest.fn(() => undefined),
  validateCanonicalClientToolCall: jest.fn(() => true),
}));

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge/snapshot-recorder.js', () => ({
  createSnapshotRecorder: mockCreateSnapshotRecorder,
}));

jest.unstable_mockModule('../../../../../src/server/utils/stage-logger.js', () => ({
  logPipelineStage: logStageSpy
}));

const TEST_METADATA_WRITER = {
  module: 'tests/server/runtime/http-server/executor/provider-response-converter.error-logging.spec.ts',
  symbol: 'buildPipelineMetadata',
  stage: 'test_runtime_control_provider_protocol'
} as const;

function buildPipelineMetadata(providerProtocol: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  MetadataCenter.attach(metadata).writeRuntimeControl(
    'providerProtocol',
    providerProtocol,
    TEST_METADATA_WRITER,
    'seed provider protocol for error logging test'
  );
  return metadata;
}

describe('provider-response-converter error logging', () => {
  it('surfaces SSE wrapper error in chat mode', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
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
        pipelineMetadata: buildPipelineMetadata('openai-responses')
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    )).rejects.toMatchObject({
      message: 'Upstream SSE error event [UPSTREAM_UNAVAILABLE]: gateway unavailable',
      response: {
        status: 503,
        data: {
          error: {
            code: 'UPSTREAM_UNAVAILABLE',
            message: 'gateway unavailable',
            status: 503
          }
        }
      },
      details: {
        source: 'provider_response_sse_wrapper',
        rawCode: 'UPSTREAM_UNAVAILABLE',
        rawStatusCode: 503
      }
    });

    expect(mockConvertProviderResponse).not.toHaveBeenCalled();
  });

  it('does not apply provider configured error mapping before ErrorErr capture', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
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
        pipelineMetadata: buildPipelineMetadata('openai-responses')
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
      message: 'Upstream SSE error event [HTTP_400]: All available accounts exhausted',
      response: {
        status: 400,
        data: {
          error: {
            code: 'HTTP_400',
            status: 400,
            message: 'All available accounts exhausted'
          }
        }
      },
      details: {
        source: 'provider_response_sse_wrapper',
        rawCode: 'HTTP_400',
        rawStatusCode: 400
      }
    });

    expect(mockConvertProviderResponse).not.toHaveBeenCalled();
  });

  it('preserves the same raw wrapper evidence without provider runtime mapping', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
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
        pipelineMetadata: buildPipelineMetadata('openai-responses')
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    )).rejects.toMatchObject({
      message: 'Upstream SSE error event [HTTP_400]: All available accounts exhausted',
      response: {
        status: 400,
        data: {
          error: {
            code: 'HTTP_400',
            status: 400,
            message: 'All available accounts exhausted'
          }
        }
      },
      details: {
        source: 'provider_response_sse_wrapper',
        rawCode: 'HTTP_400',
        rawStatusCode: 400
      }
    });

    expect(mockConvertProviderResponse).not.toHaveBeenCalled();
  });

  it('does not emit convert.bridge.error stage for provider business error 2056', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
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
        pipelineMetadata: buildPipelineMetadata('openai-responses')
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

  it('logs bridge payload diagnostics when choices-array materialization fails on body.data chat sample', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    logStageSpy.mockReset();

    mockConvertProviderResponse.mockRejectedValueOnce(new Error(
      'Rust HubPipeline response path failed: hub_pipeline_error: OpenAI chat response must contain choices array'
    ));

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await expect(convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-chat',
        requestId: 'req_choices_array_diag_1',
        wantsStream: true,
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json'
          },
          body: {
            sseStream: { on() {}, off() {} },
            data: {
              id: 'chatcmpl_choices_diag_1',
              object: 'chat.completion',
              model: 'glm-5.2',
              choices: [
                {
                  index: 0,
                  finish_reason: 'tool_calls',
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_diag_1',
                        type: 'function',
                        function: {
                          name: 'exec_command',
                          arguments: JSON.stringify({ cmd: 'pwd' })
                        }
                      }
                    ]
                  }
                }
              ]
            }
          }
        } as any,
        pipelineMetadata: buildPipelineMetadata('openai-chat')
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    )).rejects.toThrow('choices array');

    const convertBridgeErrorCall = logStageSpy.mock.calls.find(
      (call) => call[0] === 'convert.bridge.error' && call[1] === 'req_choices_array_diag_1'
    );
    expect(convertBridgeErrorCall).toBeDefined();
    expect(convertBridgeErrorCall?.[2]).toMatchObject({
      bridgeProviderProtocol: 'openai-chat',
      bridgePayloadHasChoices: true,
      bridgePayloadHasDataChoices: false
    });
    expect(convertBridgeErrorCall?.[2]).toEqual(expect.objectContaining({
      bridgeSeedKeys: expect.arrayContaining(['data', 'sseStream']),
      bridgePayloadKeys: expect.arrayContaining(['choices', 'id', 'model', 'object'])
    }));
  });
});
