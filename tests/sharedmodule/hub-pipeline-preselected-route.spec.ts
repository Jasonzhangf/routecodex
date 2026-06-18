import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const mockRunHubPipelineLibWithNative = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.js',
  () => ({
    runHubPipelineLibWithNative: mockRunHubPipelineLibWithNative,
  })
);

const { executeRequestStagePipeline } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.js'
);

const preselectedRoute = {
  target: {
    providerKey: 'preselected.key1.gpt-5.5',
    providerType: 'openai',
    outboundProfile: 'openai-responses',
    modelId: 'gpt-5.5',
  },
  decision: {
    routeName: 'thinking/gateway-priority-5555-priority-thinking',
    poolId: 'primary',
    reasoning: 'preselected',
  },
  diagnostics: {},
};

function createNormalized(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req_preselected_route',
    endpoint: '/v1/responses',
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses',
    payload: {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
    },
    metadata: {
      requestId: 'req_preselected_route',
      __rt: {
        preselectedRoute,
      },
    },
    processMode: 'chat',
    direction: 'request',
    stage: 'inbound',
    stream: true,
    ...overrides,
  };
}

function createNativeSuccess() {
  return {
    requestId: 'req_preselected_route',
    success: true,
    payload: { model: 'gpt-5.5', input: [] },
    metadata: {
      target: preselectedRoute.target,
      routingDecision: preselectedRoute.decision,
      routingDiagnostics: preselectedRoute.diagnostics,
    },
    diagnostics: [],
  };
}

describe('HubPipeline preselected route ownership', () => {
  beforeEach(() => {
    mockRunHubPipelineLibWithNative.mockReset();
    mockRunHubPipelineLibWithNative.mockReturnValue(createNativeSuccess());
  });

  it('request stage reuses preselected route without routing again', async () => {
    const routerEngine = { route: jest.fn(() => { throw new Error('route should not be called'); }) };

    await executeRequestStagePipeline({
      normalized: createNormalized(),
      routerEngine: routerEngine as never,
      config: { virtualRouter: { providers: {}, routes: {}, routing: {} } } as never,
    });

    expect(routerEngine.route).not.toHaveBeenCalled();
    expect(mockRunHubPipelineLibWithNative).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        metadata: expect.objectContaining({
          __rt: expect.objectContaining({
            preselectedRoute,
          }),
        }),
      }),
    }));
  });

  it('chat process entry reuses preselected route without routing again', async () => {
    const routerEngine = { route: jest.fn(() => { throw new Error('route should not be called'); }) };

    await executeRequestStagePipeline({
      normalized: createNormalized({ hubEntryMode: 'chat_process' }),
      routerEngine: routerEngine as never,
      config: { virtualRouter: { providers: {}, routes: {}, routing: {} } } as never,
      entryMode: 'chat_process',
    });

    expect(routerEngine.route).not.toHaveBeenCalled();
    expect(mockRunHubPipelineLibWithNative).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        metadata: expect.objectContaining({
          __rt: expect.objectContaining({
            preselectedRoute,
          }),
        }),
      }),
    }));
  });

  it('projects MetadataCenter runtime stop-message control into native request metadata', async () => {
    const routerEngine = { route: jest.fn(() => { throw new Error('route should not be called'); }) };

    await executeRequestStagePipeline({
      normalized: createNormalized({
        metadata: {
          requestId: 'req_preselected_route',
          __metadataCenter: {
            version: 1,
            requestTruth: {},
            providerObservation: {},
            runtimeControl: {
              stopMessageEnabled: {
                value: true,
                status: 'active',
                writer: {
                  module: 'src/server/runtime/http-server/index.ts',
                  symbol: 'HttpServerV2.executePipelineForPort',
                  stage: 'ServerReqInbound01ClientRaw'
                },
                reason: 'port stop-message enablement'
              }
            }
          },
          __rt: {
            preselectedRoute,
            stopMessageEnabled: false,
          },
        },
      }),
      routerEngine: routerEngine as never,
      config: { virtualRouter: { providers: {}, routes: {}, routing: {} } } as never,
    });

    expect(mockRunHubPipelineLibWithNative).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        metadata: expect.objectContaining({
          stopMessageEnabled: true,
          routecodexPortStopMessageEnabled: true,
          __rt: expect.objectContaining({
            preselectedRoute,
            stopMessageEnabled: true,
          }),
        }),
      }),
    }));
  });

  it('reuses MetadataCenter runtime preselectedRoute without reading flat routecodex residue', async () => {
    const routerEngine = { route: jest.fn(() => { throw new Error('route should not be called'); }) };

    await executeRequestStagePipeline({
      normalized: createNormalized({
        metadata: {
          requestId: 'req_preselected_route',
          __routecodexPreselectedRoute: {
            target: {
              providerKey: 'legacy.flat.should-not-win',
              providerType: 'openai',
              outboundProfile: 'openai-responses',
              modelId: 'legacy-model',
            },
            decision: {
              routeName: 'legacy-flat',
              poolId: 'legacy',
              reasoning: 'legacy-flat',
            },
            diagnostics: {},
          },
          __metadataCenter: {
            version: 1,
            requestTruth: {},
            providerObservation: {},
            runtimeControl: {
              preselectedRoute: {
                value: preselectedRoute,
                status: 'active',
                writer: {
                  module: 'tests/sharedmodule/hub-pipeline-preselected-route.spec.ts',
                  symbol: 'reuses MetadataCenter runtime preselectedRoute without reading flat routecodex residue',
                  stage: 'test'
                },
                reason: 'test route pin'
              }
            }
          },
        },
      }),
      routerEngine: routerEngine as never,
      config: { virtualRouter: { providers: {}, routes: {}, routing: {} } } as never,
    });

    expect(routerEngine.route).not.toHaveBeenCalled();
    expect(mockRunHubPipelineLibWithNative).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        metadata: expect.objectContaining({
          __rt: expect.objectContaining({
            preselectedRoute,
          }),
        }),
      }),
    }));
    expect(mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadata?.__rt?.preselectedRoute?.target?.providerKey)
      .toBe('preselected.key1.gpt-5.5');
  });

  it('projects stopless runtime control into native top-level metadata for relay request owners', async () => {
    const routerEngine = { route: jest.fn(() => { throw new Error('route should not be called'); }) };

    await executeRequestStagePipeline({
      normalized: createNormalized({
        metadata: {
          requestId: 'req_preselected_route',
          __metadataCenter: {
            version: 1,
            requestTruth: {},
            providerObservation: {},
            runtimeControl: {
              stopless: {
                value: {
                  sessionId: 'sess-stopless-1',
                  flowId: 'stop_message_flow',
                  repeatCount: 2,
                  maxRepeats: 3,
                  triggerHint: 'no_schema',
                  continuationPrompt: '继续做下一步',
                  schemaFeedback: {
                    reasonCode: 'stop_schema_missing',
                    missingFields: ['stopreason', 'reason']
                  },
                  active: true
                },
                status: 'active',
                writer: {
                  module: 'src/servertool/handlers/stop-message-auto.ts',
                  symbol: 'writeStoplessRuntimeControlToBoundMetadataCenter',
                  stage: 'stop_message_auto_runtime_control_writer'
                },
                reason: 'stopless-runtime-state'
              }
            }
          },
          __rt: {
            preselectedRoute,
          },
        },
      }),
      routerEngine: routerEngine as never,
      config: { virtualRouter: { providers: {}, routes: {}, routing: {} } } as never,
    });

    expect(mockRunHubPipelineLibWithNative).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        metadata: expect.objectContaining({
          stopless: expect.objectContaining({
            sessionId: 'sess-stopless-1',
            flowId: 'stop_message_flow',
            repeatCount: 2,
            maxRepeats: 3,
          }),
          __rt: expect.objectContaining({
            stopless: expect.objectContaining({
              sessionId: 'sess-stopless-1',
              flowId: 'stop_message_flow',
              repeatCount: 2,
              maxRepeats: 3,
            }),
          }),
        }),
      }),
    }));
  });
});
