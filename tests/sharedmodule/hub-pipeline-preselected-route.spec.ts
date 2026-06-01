import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const mockRunHubPipelineLibWithNative = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics-protocol.js',
  () => ({
    runHubPipelineLibWithNative: mockRunHubPipelineLibWithNative,
  })
);

const { executeRequestStagePipeline } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.js'
);
const { executeChatProcessEntryPipeline } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-chat-process-entry.js'
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
      __routecodexPreselectedRoute: preselectedRoute,
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
          __routecodexPreselectedRoute: preselectedRoute,
        }),
      }),
    }));
  });

  it('chat process entry reuses preselected route without routing again', async () => {
    const routerEngine = { route: jest.fn(() => { throw new Error('route should not be called'); }) };

    await executeChatProcessEntryPipeline({
      normalized: createNormalized({ hubEntryMode: 'chat_process' }),
      routerEngine: routerEngine as never,
      config: { virtualRouter: { providers: {}, routes: {}, routing: {} } } as never,
    });

    expect(routerEngine.route).not.toHaveBeenCalled();
    expect(mockRunHubPipelineLibWithNative).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        metadata: expect.objectContaining({
          __routecodexPreselectedRoute: preselectedRoute,
        }),
      }),
    }));
  });
});
