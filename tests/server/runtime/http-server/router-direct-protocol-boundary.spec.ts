import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { resetSessionStormBackoffStateForTests } from '../../../../src/server/runtime/http-server/executor/request-executor-session-storm-backoff';
import { MetadataCenter } from '../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';
import { readRuntimeControlProjection } from '../../../../src/server/runtime/http-server/metadata-center/request-truth-readers.js';

describe('router direct protocol boundary', () => {
  afterEach(() => {
    jest.useRealTimers();
    resetSessionStormBackoffStateForTests();
  });

  function createRouterServer() {
    return {
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any;
  }

  function attachRouterPort(server: any): void {
    server.userConfig = {
      httpserver: {
        ports: [{
          port: 5555,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    server.hubPipeline = { execute: jest.fn(), updateVirtualRouterConfig: jest.fn() };
    server.hubPipelinesByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', server.hubPipeline],
    ]);
  }

  function attachRouterPortWithStoplessRelay(server: any): void {
    server.userConfig = {
      httpserver: {
        ports: [{
          port: 5555,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
          stopMessage: {
            enabled: true,
            includeDirect: true,
          },
        }],
      },
      servertool: {
        apply_patch: {
          mode: 'client',
        },
      },
    };
    server.hubPipeline = { execute: jest.fn(), updateVirtualRouterConfig: jest.fn() };
    server.hubPipelinesByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', server.hubPipeline],
    ]);
  }

  function bindTestRequestTruth(metadata: Record<string, unknown>, requestId: string, sessionId: string): void {
    MetadataCenter.attach(metadata).writeRequestTruth(
      'sessionId',
      sessionId,
      {
        module: 'tests/server/runtime/http-server/router-direct-protocol-boundary.spec.ts',
        symbol: 'buildResponsesInput',
        stage: 'test_request_truth',
      },
      requestId
    );
  }

  function buildResponsesInput(
    requestId: string,
    sessionId = 'router-direct-protocol-boundary',
  ) {
    const metadata: Record<string, unknown> = { sessionId };
    bindTestRequestTruth(metadata, requestId, sessionId);
    return {
      requestId,
      entryEndpoint: '/v1/responses',
      method: 'POST',
      headers: {},
      query: {},
      body: {
        model: 'router-gpt-5.5',
        stream: true,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'search' }] }],
      },
      metadata,
    };
  }

  it('relays into Hub when router-direct reports protocol mismatch', async () => {
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');
    const server = new RouteCodexHttpServer(createRouterServer());
    attachRouterPort(server as any);
    const directSpy = jest.spyOn(server as any, 'executeRouterDirectPipelineForPort').mockResolvedValue({
      used: false,
      reason: 'protocol mismatch: inbound=openai-responses, provider=openai-chat',
    } as any);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline').mockResolvedValue({
      status: 200,
      body: { id: 'relay_after_protocol_mismatch', object: 'response' },
      metadata: { relayed: true },
    } as any);
    const logStageSpy = jest.spyOn(server as any, 'logStage');

    const result = await (server as any).executePortAwarePipeline(
      5555,
      buildResponsesInput('req_router_direct_mismatch_no_relay'),
    );

    expect(directSpy).toHaveBeenCalledTimes(1);
    expect(executePipelineSpy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 200,
      body: { id: 'relay_after_protocol_mismatch', object: 'response' },
      metadata: { relayed: true },
    });
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.failed_no_relay')).toHaveLength(0);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.relay')).toHaveLength(1);
  });


  it('reuses preselected route on router-direct relayable skip so Hub does not route twice', async () => {
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');
    const server = new RouteCodexHttpServer(createRouterServer());
    attachRouterPort(server as any);
    const preselectedRoute = {
      target: {
        providerKey: 'minimax.key1.MiniMax-M3',
        providerType: 'anthropic',
        runtimeKey: 'minimax.key1.MiniMax-M3',
        modelId: 'MiniMax-M3',
      },
      decision: {
        routeName: 'search',
        pool: ['minimax.key1.MiniMax-M3'],
        poolId: 'gateway-priority-5555-priority-search',
        reasoning: 'search:last-tool-search',
      },
      diagnostics: { reused: true },
    };
    jest.spyOn(server as any, 'executeRouterDirectPipelineForPort').mockResolvedValue({
      used: false,
      reason: 'protocol mismatch: inbound=openai-responses, provider=anthropic-messages',
      preselectedRoute,
    } as any);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline').mockResolvedValue({
      status: 200,
      body: { id: 'relay_after_protocol_mismatch_preselected', object: 'response' },
      metadata: { relayed: true },
    } as any);

    await (server as any).executePortAwarePipeline(
      5555,
      buildResponsesInput('req_router_direct_mismatch_preselected_route'),
    );

    expect(executePipelineSpy).toHaveBeenCalledTimes(1);
    const relayMetadata = executePipelineSpy.mock.calls[0]?.[0]?.metadata as Record<string, unknown>;
    expect(relayMetadata.__rt as Record<string, unknown> | undefined).not.toEqual(expect.objectContaining({
      preselectedRoute,
    }));
    expect(readRuntimeControlProjection(relayMetadata).preselectedRoute).toEqual(preselectedRoute);
  });

  it('does not record router-direct storm backoff when protocol mismatch is relayed', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-09T00:00:00.000Z'));

    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');
    const server = new RouteCodexHttpServer(createRouterServer());
    attachRouterPort(server as any);
    jest.spyOn(server as any, 'executeRouterDirectPipelineForPort').mockResolvedValue({
      used: false,
      reason: 'protocol mismatch: inbound=openai-responses, provider=openai-chat',
    } as any);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline').mockResolvedValue({
      status: 202,
      body: { id: 'relay_after_protocol_mismatch_repeat', object: 'response' },
      metadata: {},
    } as any);
    const logStageSpy = jest.spyOn(server as any, 'logStage');

    await expect((server as any).executePortAwarePipeline(
      5555,
      buildResponsesInput('req_router_direct_mismatch_1', 'router-direct-protocol-mismatch-storm'),
    )).resolves.toMatchObject({
      status: 202,
      body: { id: 'relay_after_protocol_mismatch_repeat', object: 'response' },
    });

    await expect((server as any).executePortAwarePipeline(
      5555,
      buildResponsesInput('req_router_direct_mismatch_2', 'router-direct-protocol-mismatch-storm'),
    )).resolves.toMatchObject({
      status: 202,
      body: { id: 'relay_after_protocol_mismatch_repeat', object: 'response' },
    });

    await jest.advanceTimersByTimeAsync(1000);

    expect(executePipelineSpy).toHaveBeenCalledTimes(2);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'request.session_storm_backoff_wait')).toHaveLength(0);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'request.session_storm_backoff.recorded')).toHaveLength(0);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.failed_no_relay')).toHaveLength(0);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.relay')).toHaveLength(2);
  });

  it('fails fast and records storm backoff for non-relayable router-direct skip errors', async () => {
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');
    const server = new RouteCodexHttpServer(createRouterServer());
    attachRouterPort(server as any);
    jest.spyOn(server as any, 'executeRouterDirectPipelineForPort').mockResolvedValue({
      used: false,
      reason: 'provider not found for runtimeKey: missing.runtime',
    } as any);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline');
    const logStageSpy = jest.spyOn(server as any, 'logStage');

    await expect((server as any).executePortAwarePipeline(
      5555,
      buildResponsesInput('req_router_direct_missing_runtime', 'router-direct-missing-runtime-storm'),
    )).rejects.toThrow('router-direct failed without relay: provider not found for runtimeKey: missing.runtime');

    expect(executePipelineSpy).not.toHaveBeenCalled();
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.failed_no_relay')).toHaveLength(1);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'request.session_storm_backoff.recorded')).toHaveLength(0);
  });

  it('backs off repeated router-direct VR provider-unavailable failures without rewriting the error', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-09T00:00:00.000Z'));

    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');
    const server = new RouteCodexHttpServer(createRouterServer());
    attachRouterPort(server as any);
    const error = Object.assign(
      new Error('No available providers after applying routing instructions'),
      { code: 'PROVIDER_NOT_AVAILABLE' },
    );
    jest.spyOn(server as any, 'executeRouterDirectPipelineForPort').mockRejectedValue(error);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline');
    const logStageSpy = jest.spyOn(server as any, 'logStage');

    await expect((server as any).executePortAwarePipeline(
      5555,
      buildResponsesInput('req_router_direct_vr_1', 'router-direct-vr-provider-unavailable-storm'),
    )).rejects.toThrow('No available providers after applying routing instructions');

    const second = (server as any).executePortAwarePipeline(
      5555,
      buildResponsesInput('req_router_direct_vr_2', 'router-direct-vr-provider-unavailable-storm'),
    );
    const secondExpectation = expect(second)
      .rejects.toThrow('No available providers after applying routing instructions');
    await jest.advanceTimersByTimeAsync(999);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'request.session_storm_backoff_wait')).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
    await secondExpectation;

    expect(executePipelineSpy).not.toHaveBeenCalled();
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'request.session_storm_backoff.recorded')).toHaveLength(0);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.failed_no_relay')).toHaveLength(0);
  });

  it('returns a protocol mismatch skip from router-direct port pipeline without provider transport', async () => {
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');
    const runtimeKey = 'anthropic.key1.claude-test';
    const server = new RouteCodexHttpServer(createRouterServer());
    attachRouterPort(server as any);
    const directSend = jest.fn();
    (server as any).providerHandles = new Map([[runtimeKey, {
      runtimeKey,
      providerId: 'anthropic',
      providerType: 'anthropic',
      providerFamily: 'anthropic',
      providerProtocol: 'anthropic-messages',
      runtime: {},
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: directSend,
        processIncomingDirect: directSend,
      },
    }]]);
    (server as any).hubPipeline = {
      execute: jest.fn(),
      updateVirtualRouterConfig: jest.fn(),
      getVirtualRouter: jest.fn(() => ({
        route: jest.fn(() => ({
          target: {
            providerKey: runtimeKey,
            providerType: 'anthropic',
            runtimeKey,
            modelId: 'claude-test',
          },
          decision: { routeName: 'search', pool: [runtimeKey] },
          diagnostics: {},
        })),
      })),
    };
    (server as any).hubPipelinesByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', (server as any).hubPipeline],
    ]);

    const result = await (server as any).executeRouterDirectPipelineForPort(
      {
        port: 5555,
        host: '127.0.0.1',
        mode: 'router',
        routingPolicyGroup: 'gateway_priority_5555',
        sameProtocolBehavior: 'direct',
      },
      buildResponsesInput('req_router_direct_protocol_mismatch_skip'),
    );

    expect(result).toMatchObject({
      used: false,
      reason: expect.stringContaining('protocol mismatch'),
    });
    expect(result).not.toHaveProperty('requiresHubRelay');
    expect(directSend).not.toHaveBeenCalled();
  });

  it('backs off direct route pool exhaustion three times before surfacing the original error', async () => {
    jest.useFakeTimers();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');
    const server = new RouteCodexHttpServer(createRouterServer());
    attachRouterPort(server as any);
    const routeError = Object.assign(
      new Error('All providers unavailable for model mini27.MiniMax-M2.7'),
      { code: 'PROVIDER_NOT_AVAILABLE' },
    );
    (server as any).hubPipeline = {
      execute: jest.fn(),
      updateVirtualRouterConfig: jest.fn(),
      getVirtualRouter: jest.fn(() => ({
        route: jest.fn(() => {
          throw routeError;
        }),
      })),
    };
    (server as any).hubPipelinesByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', (server as any).hubPipeline],
    ]);
    const logStageSpy = jest.spyOn(server as any, 'logStage');

    const pending = (server as any).executeRouterDirectPipelineForPort(
      {
        port: 5555,
        host: '127.0.0.1',
        mode: 'router',
        routingPolicyGroup: 'gateway_priority_5555',
        sameProtocolBehavior: 'direct',
      },
      buildResponsesInput('req_router_direct_route_failed_no_inner_record'),
    );
    const expectation = expect(pending).rejects.toThrow('All providers unavailable for model mini27.MiniMax-M2.7');

    await jest.advanceTimersByTimeAsync(999);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.pool_exhausted.backoff_wait.completed')).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
    await jest.advanceTimersByTimeAsync(2_000);
    await jest.advanceTimersByTimeAsync(3_000);
    await expectation;

    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.pool_exhausted.backoff_wait')).toHaveLength(3);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.pool_exhausted.backoff_wait.completed')).toHaveLength(3);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.route_failed')).toHaveLength(0);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'request.session_storm_backoff.recorded')).toHaveLength(0);
  });
});
