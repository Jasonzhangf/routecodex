import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const mockRunHubPipelineLibWithNative = jest.fn();
const mockBuildRequestStageRuntimeControlWritePlanWithNative = jest.fn((input: {
  outputMetadata: Record<string, unknown>;
}) => {
  const runtimeControl = input.outputMetadata.runtime_control;
  const normalizedRuntimeControl = runtimeControl && typeof runtimeControl === 'object' && !Array.isArray(runtimeControl)
    ? runtimeControl as Record<string, unknown>
    : null;
  return {
    runtimeControl: normalizedRuntimeControl && Object.keys(normalizedRuntimeControl).length > 0
      ? normalizedRuntimeControl
      : null
  };
});
const mockBuildRequestStageNativeResultPlanWithNative = jest.fn((input: {
  nativePlan: Record<string, any>;
  entryMode: 'request_stage' | 'chat_process';
}) => {
  if (input.nativePlan.success !== true) {
    const error = input.nativePlan.error ?? {};
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message ?? 'Rust HubPipeline request path failed',
        details: error.details,
        ...(error.code === 'MALFORMED_REQUEST' ? { status: 400, statusCode: 400 } : {})
      }
    };
  }
  return {
    ok: true,
    providerPayload: input.nativePlan.payload,
    metadata: input.nativePlan.metadata ?? {},
    diagnostics: input.nativePlan.diagnostics ?? [],
    ...(input.entryMode !== 'chat_process' && input.nativePlan.standardizedRequest
      ? { standardizedRequest: input.nativePlan.standardizedRequest }
      : {})
  };
});
const mockBuildRequestStageHubPipelineResultWithNative = jest.fn((input: {
  requestId: string;
  resultPlan: Record<string, any>;
  entryMode: 'request_stage' | 'chat_process';
}) => {
  const metadata = input.resultPlan.metadata ?? {};
  return {
    requestId: input.requestId,
    providerPayload: input.resultPlan.providerPayload,
    ...(metadata.target ? { target: metadata.target } : {}),
    ...(metadata.routingDecision ? { routingDecision: metadata.routingDecision } : {}),
    ...(metadata.routingDiagnostics ? { routingDiagnostics: metadata.routingDiagnostics } : {}),
    metadata,
    nodeResults: input.resultPlan.diagnostics ?? [],
    ...(input.entryMode !== 'chat_process' && input.resultPlan.standardizedRequest
      ? { standardizedRequest: input.resultPlan.standardizedRequest }
      : {})
  };
});
const mockBuildRequestStageMetadataDispatchWithNative = jest.fn((input: {
  sourceMetadata: Record<string, unknown>;
  requestTruth: Record<string, unknown>;
  continuationContext: Record<string, unknown>;
  runtimeControl: Record<string, unknown>;
  providerProtocol: string;
  excludedProviderKeys?: unknown;
}) => {
  const metadata = { ...input.sourceMetadata };
  delete metadata.__rt;
  delete metadata.__metadataCenter;
  metadata.runtime_control = {
    ...(
      input.sourceMetadata.runtime_control
      && typeof input.sourceMetadata.runtime_control === 'object'
      && !Array.isArray(input.sourceMetadata.runtime_control)
        ? input.sourceMetadata.runtime_control as Record<string, unknown>
        : {}
    ),
    ...input.runtimeControl,
  };
  const runtimeControlSnapshot = {
    ...input.runtimeControl,
    ...(input.providerProtocol.trim() ? { providerProtocol: input.providerProtocol.trim() } : {}),
  };
  const snapshot: Record<string, unknown> = {
    ...(Object.keys(input.requestTruth).length > 0 ? { requestTruth: input.requestTruth } : {}),
    ...(Object.keys(input.continuationContext).length > 0 ? { continuationContext: input.continuationContext } : {}),
    ...(Object.keys(runtimeControlSnapshot).length > 0 ? { runtimeControl: runtimeControlSnapshot } : {}),
  };
  const excludedProviderKeys = Array.isArray(input.excludedProviderKeys)
    ? input.excludedProviderKeys.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim())
    : [];
  if (excludedProviderKeys.length > 0) {
    snapshot.excludedProviderKeys = excludedProviderKeys;
  }
  return {
    metadata,
    metadataCenterSnapshot: Object.keys(snapshot).length > 0 ? snapshot : null,
  };
});

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.js',
  () => ({
    runHubPipelineLibWithNative: mockRunHubPipelineLibWithNative,
    buildRequestStageMetadataDispatchWithNative: mockBuildRequestStageMetadataDispatchWithNative,
    buildRequestStageHubPipelineResultWithNative: mockBuildRequestStageHubPipelineResultWithNative,
    buildRequestStageNativeResultPlanWithNative: mockBuildRequestStageNativeResultPlanWithNative,
    buildRequestStageRuntimeControlWritePlanWithNative: mockBuildRequestStageRuntimeControlWritePlanWithNative,
    projectMetadataWritePlanToRuntimeControlWithNative: jest.fn(({ plan }: { plan: Record<string, unknown> }) => plan),
    projectMetadataWritePlanToRuntimeControlWritePlanWithNative: jest.fn(({ plan }: { plan: Record<string, unknown> }) => ({
      runtimeControl: Object.keys(plan).length > 0 ? plan : null
    })),
  })
);

const { executeRequestStagePipelineDirectNative: executeRequestStagePipeline } = await import(
  './helpers/request-stage-direct-native.js'
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
    mockBuildRequestStageRuntimeControlWritePlanWithNative.mockClear();
    mockBuildRequestStageNativeResultPlanWithNative.mockClear();
    mockBuildRequestStageHubPipelineResultWithNative.mockClear();
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

  it('syncs Rust request ChatProcess stopless runtime control into MetadataCenter', async () => {
    const routerEngine = { route: jest.fn(() => { throw new Error('route should not be called'); }) };
    const metadata = withMetadataCenter({
      requestId: 'req_preselected_route',
    }, (center) => {
      center.writeRuntimeControl('preselectedRoute', preselectedRoute, TEST_WRITER, 'test route pin');
    });
    mockRunHubPipelineLibWithNative.mockReturnValueOnce({
      ...createNativeSuccess(),
      metadata: {
        target: preselectedRoute.target,
        routingDecision: preselectedRoute.decision,
        routingDiagnostics: preselectedRoute.diagnostics,
        runtime_control: {
          stopless: {
            flowId: 'stop_message_flow',
            repeatCount: 1,
            maxRepeats: 3,
            triggerHint: 'stop_schema_missing',
            schemaFeedback: {
              reasonCode: 'stop_schema_missing',
              missingFields: ['stopreason'],
            },
            active: true,
            updatedAt: 1782600000000,
          },
        },
      },
    });

    await executeRequestStagePipeline({
      normalized: createNormalized({ metadata }),
      routerEngine: routerEngine as never,
      config: { virtualRouter: { providers: {}, routes: {}, routing: {} } } as never,
    });

    expect(MetadataCenter.read(metadata)?.readRuntimeControl().stopless).toMatchObject({
      flowId: 'stop_message_flow',
      repeatCount: 1,
      maxRepeats: 3,
      triggerHint: 'stop_schema_missing',
      active: true,
    });
  });

  it('fails fast when Rust request ChatProcess returns stopless control without MetadataCenter', async () => {
    const routerEngine = { route: jest.fn(() => preselectedRoute) };
    mockRunHubPipelineLibWithNative.mockReturnValueOnce({
      ...createNativeSuccess(),
      metadata: {
        target: preselectedRoute.target,
        routingDecision: preselectedRoute.decision,
        routingDiagnostics: preselectedRoute.diagnostics,
        runtime_control: {
          stopless: {
            flowId: 'stop_message_flow',
            repeatCount: 0,
            maxRepeats: 3,
            active: true,
          },
        },
      },
    });

    await expect(executeRequestStagePipeline({
      normalized: createNormalized({
        metadata: {
          requestId: 'req_preselected_route',
        },
      }),
      routerEngine: routerEngine as never,
      config: { virtualRouter: { providers: {}, routes: {}, routing: {} } } as never,
    })).rejects.toThrow('MetadataCenter runtime_control write failed: bound MetadataCenter missing');
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
            providerProtocol: 'openai-responses',
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
    expect(mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadataCenterSnapshot?.runtimeControl?.providerProtocol)
      .toBe('openai-responses');
  });

  it('projects retry excludedProviderKeys into metadataCenterSnapshot for Rust VR retry selection', async () => {
    const routerEngine = { route: jest.fn(() => { throw new Error('route should not be called'); }) };

    await executeRequestStagePipeline({
      normalized: createNormalized({
        metadata: withMetadataCenter({
          requestId: 'req_retry_exclusion_snapshot',
          excludedProviderKeys: ['preselected.key1.gpt-5.5'],
        }, (center) => {
          center.writeRuntimeControl('providerProtocol', 'openai-responses', TEST_WRITER, 'test provider protocol');
        }),
      }),
      routerEngine: routerEngine as never,
      config: {
        virtualRouter: {
          providers: {
            'preselected.key1.gpt-5.5': {
              providerKey: 'preselected.key1.gpt-5.5',
              providerType: 'openai',
              runtimeKey: 'preselected.key1',
              modelId: 'gpt-5.5',
              endpoint: 'mock://preselected-1',
              auth: { type: 'apikey', apiKey: 'k1' },
            },
            'preselected.key2.gpt-5.5': {
              providerKey: 'preselected.key2.gpt-5.5',
              providerType: 'openai',
              runtimeKey: 'preselected.key2',
              modelId: 'gpt-5.5',
              endpoint: 'mock://preselected-2',
              auth: { type: 'apikey', apiKey: 'k2' },
            },
          },
          routing: {
            default: [
              {
                id: 'default',
                mode: 'priority',
                targets: ['preselected.key1.gpt-5.5', 'preselected.key2.gpt-5.5'],
              },
            ],
          },
        },
      } as never,
    });

    expect(mockRunHubPipelineLibWithNative).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        metadata: expect.objectContaining({
          excludedProviderKeys: ['preselected.key1.gpt-5.5'],
        }),
        metadataCenterSnapshot: expect.objectContaining({
          excludedProviderKeys: ['preselected.key1.gpt-5.5'],
        }),
      }),
    }));
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

  it('projects stopless runtime control through runtime_control without reviving top-level mirror', async () => {
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

    const nativeMetadata = mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadata as Record<string, unknown>;
    const runtimeControl = nativeMetadata.runtime_control as Record<string, unknown>;
    expect(nativeMetadata.stopless).toBeUndefined();
    expect(runtimeControl.preselectedRoute).toEqual(preselectedRoute);
    expect(runtimeControl.stopless).toEqual(expect.objectContaining({
      sessionId: 'sess-stopless-1',
      flowId: 'stop_message_flow',
      repeatCount: 2,
      maxRepeats: 3,
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

    expect(routerEngine.route).not.toHaveBeenCalled();
    expect(mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadata?.runtime_control?.preselectedRoute)
      .toBeUndefined();
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

    expect(routerEngine.route).not.toHaveBeenCalled();
    expect(mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadata?.__rt).toBeUndefined();
    expect(mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadata?.runtime_control?.stopless)
      .toBeUndefined();
  });

  it('hydrates resumed continuation session scope and provider pin into native metadata without bridge routing', async () => {
    const routerEngine = {
      route: jest.fn(() => preselectedRoute)
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

    expect(routerEngine.route).not.toHaveBeenCalled();
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
