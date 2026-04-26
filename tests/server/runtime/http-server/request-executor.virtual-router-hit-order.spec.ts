import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockConvertProviderResponseIfNeeded = jest.fn();
const mockRecordVirtualRouterHitRollup = jest.fn();

jest.unstable_mockModule('../../../../src/server/runtime/http-server/executor/provider-response-converter.js', () => ({
  convertProviderResponseIfNeeded: mockConvertProviderResponseIfNeeded
}));
jest.unstable_mockModule('../../../../src/server/runtime/http-server/executor/provider-response-converter.ts', () => ({
  convertProviderResponseIfNeeded: mockConvertProviderResponseIfNeeded
}));
jest.unstable_mockModule('../../../../src/server/runtime/http-server/executor/log-rollup.js', () => ({
  recordVirtualRouterHitRollup: mockRecordVirtualRouterHitRollup
}));
jest.unstable_mockModule('../../../../src/server/runtime/http-server/executor/log-rollup.ts', () => ({
  recordVirtualRouterHitRollup: mockRecordVirtualRouterHitRollup
}));

const { HubRequestExecutor } = await import('../../../../src/server/runtime/http-server/request-executor.js');

function createRuntimeHandle() {
  return {
    providerType: 'anthropic',
    providerFamily: 'anthropic',
    providerId: 'mock-anthropic',
    instance: {
      processIncoming: jest.fn(async () => ({
        status: 200,
        body: {
          id: 'provider_resp_virtual_router_hit_order',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn'
        }
      })),
      cleanup: jest.fn()
    }
  } as any;
}

function createExecutor() {
  const handle = createRuntimeHandle();
  const pipelineResult = {
    providerPayload: {
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'ping' }]
    },
    target: {
      providerKey: 'mock.key1.claude-sonnet-4-5',
      providerType: 'anthropic',
      outboundProfile: 'anthropic-messages',
      runtimeKey: 'runtime:key',
      processMode: 'standard'
    },
    routingDecision: {
      routeName: 'coding',
      poolId: 'primary',
      reasoning: 'route_matched'
    },
    processMode: 'standard',
    metadata: {
      sessionId: 'sess_virtual_router_hit_order',
      clientWorkdir: '/tmp/project'
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
    logStage: deps.logStage
  };
}

describe('request-executor virtual-router-hit timing', () => {
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(() => {
    mockConvertProviderResponseIfNeeded.mockReset();
    mockRecordVirtualRouterHitRollup.mockReset();
    warnSpy.mockClear();
    logSpy.mockClear();
  });

  it('prints unified virtual-router-hit before provider.send.start and before provider processIncoming', async () => {
    mockConvertProviderResponseIfNeeded.mockResolvedValue({
      status: 200,
      body: {
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }]
          }
        ]
      }
    });

    const { executor, handle, logStage } = createExecutor();

    await executor.execute({
      requestId: 'req_virtual_router_hit_order',
      entryEndpoint: '/v1/responses',
      method: 'POST',
      headers: {},
      query: {},
      body: {
        model: 'claude-sonnet-4-5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }]
      },
      metadata: {
        stream: false,
        inboundStream: false,
        sessionId: 'sess_virtual_router_hit_order',
        clientWorkdir: '/tmp/project'
      }
    } as any);

    expect(mockRecordVirtualRouterHitRollup).toHaveBeenCalledTimes(1);
    expect(mockRecordVirtualRouterHitRollup).toHaveBeenCalledWith(expect.objectContaining({
      routeName: 'coding',
      poolId: 'primary',
      providerKey: 'mock.key1.claude-sonnet-4-5',
      model: 'claude-sonnet-4-5',
      sessionId: 'sess_virtual_router_hit_order'
    }));

    const providerSendStartIndex = logStage.mock.calls.findIndex(([stage]: [string]) => stage === 'provider.send.start');
    expect(providerSendStartIndex).toBeGreaterThanOrEqual(0);

    const virtualRouterHitOrder = mockRecordVirtualRouterHitRollup.mock.invocationCallOrder[0];
    const providerSendStartOrder = logStage.mock.invocationCallOrder[providerSendStartIndex];
    const providerProcessIncomingOrder = handle.instance.processIncoming.mock.invocationCallOrder[0];

    expect(virtualRouterHitOrder).toBeLessThan(providerSendStartOrder);
    expect(virtualRouterHitOrder).toBeLessThan(providerProcessIncomingOrder);
  });

  afterAll(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });
});
