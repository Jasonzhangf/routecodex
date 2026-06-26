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
        metadata: {
          requestId: 'req_preselected_route',
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
                  symbol: 'projects MetadataCenter runtime stop-message control into native request metadata',
                  stage: 'test'
                },
                reason: 'test route pin'
              },
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
        },
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
        metadata: {
          requestId: 'req_preselected_route',
          routeHint: 'flat-route-should-not-enter-snapshot',
          __rt: {
            stopMessageEnabled: false,
            retryProviderKey: 'legacy.retry.should-not-enter-snapshot',
          },
          runtime_control: {
            retryProviderKey: 'payload.retry.should-not-enter-snapshot',
          },
          __metadataCenter: {
            version: 1,
            requestTruth: {
              sessionId: {
                value: 'sess-center-1',
                status: 'active',
                writer: {
                  module: 'tests/sharedmodule/hub-pipeline-preselected-route.spec.ts',
                  symbol: 'builds metadataCenterSnapshot only from MetadataCenter families before native request dispatch',
                  stage: 'test',
                },
                reason: 'request truth from center',
              },
            },
            continuationContext: {
              responsesResume: {
                value: {
                  providerKey: 'resume.provider.key',
                  routeHint: 'resume-hint',
                },
                status: 'active',
                writer: {
                  module: 'tests/sharedmodule/hub-pipeline-preselected-route.spec.ts',
                  symbol: 'builds metadataCenterSnapshot only from MetadataCenter families before native request dispatch',
                  stage: 'test',
                },
                reason: 'continuation context from center',
              },
            },
            providerObservation: {},
            runtimeControl: {
              retryProviderKey: {
                value: 'center.retry.provider',
                status: 'active',
                writer: {
                  module: 'tests/sharedmodule/hub-pipeline-preselected-route.spec.ts',
                  symbol: 'builds metadataCenterSnapshot only from MetadataCenter families before native request dispatch',
                  stage: 'test',
                },
                reason: 'runtime control from center',
              },
            },
          },
        },
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
        metadata: {
          requestId: 'req_preselected_route',
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
                  symbol: 'projects stopless runtime control into native top-level metadata for relay request owners',
                  stage: 'test'
                },
                reason: 'test route pin'
              },
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
        metadata: {
          requestId: 'req_preselected_route',
          __metadataCenter: {
            version: 1,
            requestTruth: {
              sessionId: {
                value: 'sess-resume-1',
                status: 'active',
                writer: {
                  module: 'tests/sharedmodule/hub-pipeline-preselected-route.spec.ts',
                  symbol: 'projects resumed continuation session scope and provider pin from MetadataCenter into native request metadata',
                  stage: 'test'
                }
              },
              conversationId: {
                value: 'conv-resume-1',
                status: 'active',
                writer: {
                  module: 'tests/sharedmodule/hub-pipeline-preselected-route.spec.ts',
                  symbol: 'projects resumed continuation session scope and provider pin from MetadataCenter into native request metadata',
                  stage: 'test'
                }
              }
            },
            continuationContext: {
              responsesResume: {
                value: {
                  responseId: 'resp-resume-1',
                  routeHint: 'search/gateway-priority-5555-priority-search',
                  providerKey: 'minimonth.key1.MiniMax-M2.7',
                  sessionId: 'sess-resume-1',
                  conversationId: 'conv-resume-1',
                  continuationOwner: 'relay'
                },
                status: 'active',
                writer: {
                  module: 'tests/sharedmodule/hub-pipeline-preselected-route.spec.ts',
                  symbol: 'projects resumed continuation session scope and provider pin from MetadataCenter into native request metadata',
                  stage: 'test'
                }
              }
            },
            providerObservation: {},
            runtimeControl: {
              preselectedRoute: {
                value: preselectedRoute,
                status: 'active',
                writer: {
                  module: 'tests/sharedmodule/hub-pipeline-preselected-route.spec.ts',
                  symbol: 'projects resumed continuation session scope and provider pin from MetadataCenter into native request metadata',
                  stage: 'test'
                }
              },
              routeHint: {
                value: 'search/gateway-priority-5555-priority-search',
                status: 'active',
                writer: {
                  module: 'tests/sharedmodule/hub-pipeline-preselected-route.spec.ts',
                  symbol: 'projects resumed continuation session scope and provider pin from MetadataCenter into native request metadata',
                  stage: 'test'
                }
              }
            }
          },
        },
      }),
      routerEngine: routerEngine as never,
      config: { virtualRouter: { providers: {}, routes: {}, routing: {} } } as never,
    });

    expect(mockRunHubPipelineLibWithNative).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        metadata: expect.objectContaining({
          sessionId: 'sess-resume-1',
          conversationId: 'conv-resume-1',
          responsesResume: expect.objectContaining({
            responseId: 'resp-resume-1',
            providerKey: 'minimonth.key1.MiniMax-M2.7',
            routeHint: 'search/gateway-priority-5555-priority-search',
            sessionId: 'sess-resume-1',
            conversationId: 'conv-resume-1',
            continuationOwner: 'relay'
          }),
          runtime_control: expect.objectContaining({
            routeHint: 'search/gateway-priority-5555-priority-search',
            preselectedRoute,
          }),
        }),
      }),
    }));
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

  it('whitelists only stopless followup legacy __rt fields into native request metadata', async () => {
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
    expect(mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadata?.__rt).toEqual({
      serverToolFollowup: true,
      serverToolFollowupSource: 'servertool.stop_message_flow',
      stopless: {
        flowId: 'stopless-flow-1',
        repeatCount: 2,
      },
    });
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
        metadata: {
          requestId: 'req_preselected_route',
          __metadataCenter: {
            version: 1,
            requestTruth: {
              sessionId: {
                value: 'sess-route-1',
                status: 'active',
                writer: {
                  module: 'tests/sharedmodule/hub-pipeline-preselected-route.spec.ts',
                  symbol: 'hydrates resumed continuation session scope and provider pin before routerEngine.route consumes metadata',
                  stage: 'test'
                }
              },
              conversationId: {
                value: 'conv-route-1',
                status: 'active',
                writer: {
                  module: 'tests/sharedmodule/hub-pipeline-preselected-route.spec.ts',
                  symbol: 'hydrates resumed continuation session scope and provider pin before routerEngine.route consumes metadata',
                  stage: 'test'
                }
              }
            },
            continuationContext: {
              responsesResume: {
                value: {
                  responseId: 'resp-route-1',
                  routeHint: 'search/gateway-priority-5555-priority-search',
                  providerKey: 'minimonth.key1.MiniMax-M2.7',
                  sessionId: 'sess-route-1',
                  conversationId: 'conv-route-1',
                  continuationOwner: 'relay'
                },
                status: 'active',
                writer: {
                  module: 'tests/sharedmodule/hub-pipeline-preselected-route.spec.ts',
                  symbol: 'hydrates resumed continuation session scope and provider pin before routerEngine.route consumes metadata',
                  stage: 'test'
                }
              }
            },
            providerObservation: {},
            runtimeControl: {
              routeHint: {
                value: 'search/gateway-priority-5555-priority-search',
                status: 'active',
                writer: {
                  module: 'tests/sharedmodule/hub-pipeline-preselected-route.spec.ts',
                  symbol: 'hydrates resumed continuation session scope and provider pin before routerEngine.route consumes metadata',
                  stage: 'test'
                }
              },
              retryProviderKey: {
                value: 'minimonth.key1.MiniMax-M2.7',
                status: 'active',
                writer: {
                  module: 'tests/sharedmodule/hub-pipeline-preselected-route.spec.ts',
                  symbol: 'hydrates resumed continuation session scope and provider pin before routerEngine.route consumes metadata',
                  stage: 'test'
                }
              }
            }
          },
          __rt: {},
        },
      }),
      routerEngine: routerEngine as never,
      config: { virtualRouter: { providers: {}, routes: {}, routing: {} } } as never,
    });

    expect(routerEngine.route).toHaveBeenCalledTimes(1);
    expect(routedMetadataSnapshots[0]).toEqual(expect.objectContaining({
      sessionId: 'sess-route-1',
      conversationId: 'conv-route-1',
      retryProviderKey: 'minimonth.key1.MiniMax-M2.7',
      responsesResume: expect.objectContaining({
        responseId: 'resp-route-1',
        providerKey: 'minimonth.key1.MiniMax-M2.7',
        sessionId: 'sess-route-1',
        conversationId: 'conv-route-1',
        continuationOwner: 'relay'
      })
    }));
    expect(mockRunHubPipelineLibWithNative.mock.calls[0]?.[0]?.request?.metadataCenterSnapshot?.runtimeControl).toEqual(
      expect.objectContaining({
        routeHint: 'search/gateway-priority-5555-priority-search',
        retryProviderKey: 'minimonth.key1.MiniMax-M2.7'
      })
    );
  });
});
