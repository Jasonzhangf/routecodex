import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

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

const TEST_WRITER = {
  module: 'tests/sharedmodule/hub-pipeline-preselected-route.spec.ts',
  symbol: 'bindMetadataCenter',
  stage: 'test_runtime_control_owner',
} as const;

function withMetadataCenter<T extends Record<string, unknown>>(
  metadata: T,
  setup?: (center: MetadataCenter) => void,
): T {
  const center = MetadataCenter.attach(metadata);
  setup?.(center);
  return metadata;
}

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
      runtime_control: {
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
          runtime_control: expect.objectContaining({
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
          runtime_control: expect.objectContaining({
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
        metadata: withMetadataCenter({
          requestId: 'req_preselected_route',
        }, (center) => {
          center.writeRuntimeControl('preselectedRoute', preselectedRoute, TEST_WRITER, 'test route pin');
          center.writeRuntimeControl('stopMessageEnabled', true, TEST_WRITER, 'port stop-message enablement');
        }),
      }),
      routerEngine: routerEngine as never,
      config: { virtualRouter: { providers: {}, routes: {}, routing: {} } } as never,
    });

    expect(mockRunHubPipelineLibWithNative).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        metadata: expect.objectContaining({
          runtime_control: expect.objectContaining({
            preselectedRoute,
            stopMessageEnabled: true,
          }),
        }),
      }),
    }));
  });

  it('builds metadataCenterSnapshot only from MetadataCenter families before native request dispatch', async () => {
    const routerEngine = { route: jest.fn(() => preselectedRoute) };

    await executeRequestStagePipeline({
      normalized: createNormalized({
        metadata: withMetadataCenter({
          requestId: 'req_preselected_route',
          routeHint: 'flat-route-should-not-enter-snapshot',
          runtime_control: {
            retryProviderKey: 'payload.retry.should-not-enter-snapshot',
          },
        }, (center) => {
          center.writeRequestTruth('sessionId', 'sess-center-1', TEST_WRITER, 'request truth from center');
          center.writeContinuationContext(
            'responsesResume',
            {
              providerKey: 'resume.provider.key',
              routeHint: 'resume-hint',
            },
            TEST_WRITER,
            'continuation context from center',
          );
          center.writeRuntimeControl('retryProviderKey', 'center.retry.provider', TEST_WRITER, 'runtime control from center');
        }),
      }),
      routerEngine: routerEngine as never,
      config: { virtualRouter: { providers: {}, routes: {}, routing: {} } } as never,
    });

    expect(mockRunHubPipelineLibWithNative).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        metadataCenterSnapshot: {
          requestTruth: {
            sessionId: 'sess-center-1',
          },
          continuationContext: {
            responsesResume: {
              providerKey: 'resume.provider.key',
              routeHint: 'resume-hint',
            },
          },
          runtimeControl: {
            retryProviderKey: 'center.retry.provider',
          },
        },
      }),
    }));
    expect(mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadataCenterSnapshot?.requestTruth?.routeHint)
      .toBeUndefined();
    expect(mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadataCenterSnapshot?.runtimeControl?.routeHint)
      .toBeUndefined();
    expect(mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadataCenterSnapshot?.runtimeControl?.stopMessageEnabled)
      .toBeUndefined();
  });

  it('reuses MetadataCenter runtime preselectedRoute without reading flat routecodex residue', async () => {
    const routerEngine = { route: jest.fn(() => { throw new Error('route should not be called'); }) };

    await executeRequestStagePipeline({
      normalized: createNormalized({
        metadata: withMetadataCenter({
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
        }, (center) => {
          center.writeRuntimeControl('preselectedRoute', preselectedRoute, TEST_WRITER, 'test route pin');
        }),
      }),
      routerEngine: routerEngine as never,
      config: { virtualRouter: { providers: {}, routes: {}, routing: {} } } as never,
    });

    expect(routerEngine.route).not.toHaveBeenCalled();
    expect(mockRunHubPipelineLibWithNative).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        metadata: expect.objectContaining({
          runtime_control: expect.objectContaining({
            preselectedRoute,
          }),
        }),
      }),
    }));
    expect(mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadata?.__rt).toBeUndefined();
    expect(mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadata?.runtime_control?.preselectedRoute?.target?.providerKey)
      .toBe('preselected.key1.gpt-5.5');
  });

  it('projects stopless runtime control into native top-level metadata for relay request owners', async () => {
    const routerEngine = { route: jest.fn(() => { throw new Error('route should not be called'); }) };

    await executeRequestStagePipeline({
      normalized: createNormalized({
        metadata: withMetadataCenter({
          requestId: 'req_preselected_route',
        }, (center) => {
          center.writeRuntimeControl('preselectedRoute', preselectedRoute, TEST_WRITER, 'test route pin');
          center.writeRuntimeControl(
            'stopless',
            {
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
            TEST_WRITER,
            'stopless-runtime-state',
          );
        }),
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
          runtime_control: expect.objectContaining({
            preselectedRoute,
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

  it('projects resumed continuation session scope and provider pin from MetadataCenter into native request metadata', async () => {
    const routerEngine = { route: jest.fn(() => { throw new Error('route should not be called'); }) };

    await executeRequestStagePipeline({
      normalized: createNormalized({
        metadata: withMetadataCenter({
          requestId: 'req_preselected_route',
        }, (center) => {
          center.writeRequestTruth('sessionId', 'sess-resume-1', TEST_WRITER);
          center.writeRequestTruth('conversationId', 'conv-resume-1', TEST_WRITER);
          center.writeContinuationContext(
            'responsesResume',
            {
              responseId: 'resp-resume-1',
              routeHint: 'search/gateway-priority-5555-priority-search',
              providerKey: 'minimonth.key1.MiniMax-M2.7',
              sessionId: 'sess-resume-1',
              conversationId: 'conv-resume-1',
              continuationOwner: 'relay'
            },
            TEST_WRITER,
          );
          center.writeRuntimeControl('preselectedRoute', preselectedRoute, TEST_WRITER);
          center.writeRuntimeControl('routeHint', 'search/gateway-priority-5555-priority-search', TEST_WRITER);
        }),
      }),
      routerEngine: routerEngine as never,
      config: { virtualRouter: { providers: {}, routes: {}, routing: {} } } as never,
    });

    expect(mockRunHubPipelineLibWithNative).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        metadata: expect.objectContaining({
          runtime_control: expect.objectContaining({
            routeHint: 'search/gateway-priority-5555-priority-search',
            preselectedRoute,
          }),
        }),
        metadataCenterSnapshot: expect.objectContaining({
          requestTruth: expect.objectContaining({
            sessionId: 'sess-resume-1',
            conversationId: 'conv-resume-1',
          }),
          continuationContext: expect.objectContaining({
            responsesResume: expect.objectContaining({
              responseId: 'resp-resume-1',
              providerKey: 'minimonth.key1.MiniMax-M2.7',
              routeHint: 'search/gateway-priority-5555-priority-search',
              sessionId: 'sess-resume-1',
              conversationId: 'conv-resume-1',
              continuationOwner: 'relay'
            }),
          }),
        }),
      }),
    }));
    expect(mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadata?.sessionId)
      .toBeUndefined();
    expect(mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadata?.conversationId)
      .toBeUndefined();
    expect(mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadata?.responsesResume)
      .toBeUndefined();
    expect(mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadata?.routeHint)
      .toBeUndefined();
    expect(mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadata?.runtime_control?.retryProviderKey)
      .toBeUndefined();
  });

  it('does not reuse legacy __rt preselectedRoute when runtime_control route pin is absent', async () => {
    const routerEngine = { route: jest.fn(() => preselectedRoute) };

    await executeRequestStagePipeline({
      normalized: createNormalized({
        metadata: {
          requestId: 'req_preselected_route',
          __rt: {
            preselectedRoute,
          },
        },
      }),
      routerEngine: routerEngine as never,
      config: { virtualRouter: { providers: {}, routes: {}, routing: {} } } as never,
    });

    expect(routerEngine.route).toHaveBeenCalledTimes(1);
    expect(mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadata?.runtime_control?.preselectedRoute)
      .toEqual(preselectedRoute);
  });

  it('does not project legacy __rt fields back into native request metadata', async () => {
    const routerEngine = { route: jest.fn(() => preselectedRoute) };

    await executeRequestStagePipeline({
      normalized: createNormalized({
        metadata: {
          requestId: 'req_preselected_route',
          __rt: {
            preselectedRoute,
            retryProviderKey: 'legacy.retry.key',
            serverToolFollowup: true,
            serverToolFollowupSource: 'servertool.stop_message_flow',
            stopless: {
              flowId: 'stopless-flow-1',
              repeatCount: 2,
            },
            servertoolResponseOrchestration: true,
            providerFamily: 'should-not-leak',
            randomLegacyKey: 'should-not-leak',
          },
        },
      }),
      routerEngine: routerEngine as never,
      config: { virtualRouter: { providers: {}, routes: {}, routing: {} } } as never,
    });

    expect(routerEngine.route).toHaveBeenCalledTimes(1);
    expect(mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadata?.__rt).toBeUndefined();
    expect(mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadata?.runtime_control?.serverToolFollowup)
      .toBeUndefined();
    expect(mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadata?.runtime_control?.stopless)
      .toBeUndefined();
  });

  it('hydrates resumed continuation session scope and provider pin before routerEngine.route consumes metadata', async () => {
    const routedMetadataSnapshots: Record<string, unknown>[] = [];
    const routerEngine = {
      route: jest.fn((_payload: unknown, metadata: unknown) => {
        if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
          routedMetadataSnapshots.push({ ...(metadata as Record<string, unknown>) });
        }
        return preselectedRoute;
      })
    };

    await executeRequestStagePipeline({
      normalized: createNormalized({
        metadata: withMetadataCenter({
          requestId: 'req_preselected_route',
        }, (center) => {
          center.writeRequestTruth('sessionId', 'sess-route-1', TEST_WRITER);
          center.writeRequestTruth('conversationId', 'conv-route-1', TEST_WRITER);
          center.writeContinuationContext(
            'responsesResume',
            {
              responseId: 'resp-route-1',
              routeHint: 'search/gateway-priority-5555-priority-search',
              providerKey: 'minimonth.key1.MiniMax-M2.7',
              sessionId: 'sess-route-1',
              conversationId: 'conv-route-1',
              continuationOwner: 'relay'
            },
            TEST_WRITER,
          );
          center.writeRuntimeControl('routeHint', 'search/gateway-priority-5555-priority-search', TEST_WRITER);
          center.writeRuntimeControl('retryProviderKey', 'minimonth.key1.MiniMax-M2.7', TEST_WRITER);
        }),
      }),
      routerEngine: routerEngine as never,
      config: { virtualRouter: { providers: {}, routes: {}, routing: {} } } as never,
    });

    expect(routerEngine.route).toHaveBeenCalledTimes(1);
    expect(routedMetadataSnapshots[0]).toEqual(expect.objectContaining({
      retryProviderKey: 'minimonth.key1.MiniMax-M2.7',
    }));
    expect(routedMetadataSnapshots[0]?.sessionId).toBeUndefined();
    expect(routedMetadataSnapshots[0]?.conversationId).toBeUndefined();
    expect(routedMetadataSnapshots[0]?.responsesResume).toBeUndefined();
    expect(mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadataCenterSnapshot?.runtimeControl).toEqual(
      expect.objectContaining({
        routeHint: 'search/gateway-priority-5555-priority-search',
        retryProviderKey: 'minimonth.key1.MiniMax-M2.7'
      })
    );
    expect(mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadataCenterSnapshot?.requestTruth).toEqual(
      expect.objectContaining({
        sessionId: 'sess-route-1',
        conversationId: 'conv-route-1',
      })
    );
    expect(mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadataCenterSnapshot?.continuationContext).toEqual(
      expect.objectContaining({
        responsesResume: expect.objectContaining({
          responseId: 'resp-route-1',
          providerKey: 'minimonth.key1.MiniMax-M2.7',
          sessionId: 'sess-route-1',
          conversationId: 'conv-route-1',
          continuationOwner: 'relay'
        })
      })
    );
  });
});
