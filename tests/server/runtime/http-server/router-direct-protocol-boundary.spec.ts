import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { resetSessionStormBackoffStateForTests } from '../../../../src/server/runtime/http-server/executor/request-executor-session-storm-backoff';

describe('router direct protocol boundary', () => {
  afterEach(() => {
    jest.useRealTimers();
    resetSessionStormBackoffStateForTests();
    delete process.env.ROUTECODEX_SESSION_STORM_BACKOFF_BASE_MS;
    delete process.env.RCC_SESSION_STORM_BACKOFF_BASE_MS;
    delete process.env.ROUTECODEX_SESSION_STORM_BACKOFF_MAX_MS;
    delete process.env.RCC_SESSION_STORM_BACKOFF_MAX_MS;
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

  function buildResponsesInput(requestId: string, sessionId = 'router-direct-protocol-boundary') {
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
      metadata: { sessionId },
    };
  }

  it('fails fast when router-direct reports protocol mismatch and does not relay into Hub', async () => {
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');
    const server = new RouteCodexHttpServer(createRouterServer());
    attachRouterPort(server as any);
    const directSpy = jest.spyOn(server as any, 'executeRouterDirectPipelineForPort').mockResolvedValue({
      used: false,
      reason: 'protocol mismatch: inbound=openai-responses, provider=openai-chat',
    } as any);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline').mockResolvedValue({
      status: 200,
      body: { id: 'must_not_relay', object: 'response' },
      metadata: {},
    } as any);
    const logStageSpy = jest.spyOn(server as any, 'logStage');

    await expect((server as any).executePortAwarePipeline(
      5555,
      buildResponsesInput('req_router_direct_mismatch_no_relay'),
    )).rejects.toThrow('router-direct failed without relay: protocol mismatch: inbound=openai-responses, provider=openai-chat');

    expect(directSpy).toHaveBeenCalledTimes(1);
    expect(executePipelineSpy).not.toHaveBeenCalled();
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.failed_no_relay')).toHaveLength(1);
    expect(logStageSpy.mock.calls.some(([stage]) => stage === 'router-direct.relay')).toBe(false);
  });

  it('backs off repeated router-direct protocol mismatch failures without rewriting the error', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-09T00:00:00.000Z'));
    process.env.ROUTECODEX_SESSION_STORM_BACKOFF_BASE_MS = '1000';
    process.env.ROUTECODEX_SESSION_STORM_BACKOFF_MAX_MS = '8000';

    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');
    const server = new RouteCodexHttpServer(createRouterServer());
    attachRouterPort(server as any);
    jest.spyOn(server as any, 'executeRouterDirectPipelineForPort').mockResolvedValue({
      used: false,
      reason: 'protocol mismatch: inbound=openai-responses, provider=openai-chat',
    } as any);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline').mockResolvedValue({
      status: 200,
      body: { id: 'must_not_relay', object: 'response' },
      metadata: {},
    } as any);
    const logStageSpy = jest.spyOn(server as any, 'logStage');

    await expect((server as any).executePortAwarePipeline(
      5555,
      buildResponsesInput('req_router_direct_mismatch_1', 'router-direct-protocol-mismatch-storm'),
    )).rejects.toThrow('router-direct failed without relay: protocol mismatch: inbound=openai-responses, provider=openai-chat');

    const second = (server as any).executePortAwarePipeline(
      5555,
      buildResponsesInput('req_router_direct_mismatch_2', 'router-direct-protocol-mismatch-storm'),
    );
    const secondExpectation = expect(second)
      .rejects.toThrow('router-direct failed without relay: protocol mismatch: inbound=openai-responses, provider=openai-chat');
    await jest.advanceTimersByTimeAsync(999);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'request.session_storm_backoff_wait')).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    await secondExpectation;

    expect(executePipelineSpy).not.toHaveBeenCalled();
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'request.session_storm_backoff.recorded')).toHaveLength(2);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.failed_no_relay')).toHaveLength(2);
    expect(logStageSpy.mock.calls.some(([stage]) => stage === 'router-direct.relay')).toBe(false);
  });

  it('backs off repeated router-direct VR provider-unavailable failures without rewriting the error', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-09T00:00:00.000Z'));
    process.env.ROUTECODEX_SESSION_STORM_BACKOFF_BASE_MS = '1000';
    process.env.ROUTECODEX_SESSION_STORM_BACKOFF_MAX_MS = '8000';

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
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'request.session_storm_backoff_wait')).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    await secondExpectation;

    expect(executePipelineSpy).not.toHaveBeenCalled();
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'request.session_storm_backoff.recorded')).toHaveLength(2);
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

  it('does not double-record storm backoff inside router-direct route failure', async () => {
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

    await expect((server as any).executeRouterDirectPipelineForPort(
      {
        port: 5555,
        host: '127.0.0.1',
        mode: 'router',
        routingPolicyGroup: 'gateway_priority_5555',
        sameProtocolBehavior: 'direct',
      },
      buildResponsesInput('req_router_direct_route_failed_no_inner_record'),
    )).rejects.toThrow('All providers unavailable for model mini27.MiniMax-M2.7');

    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.route_failed')).toHaveLength(1);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'request.session_storm_backoff.recorded')).toHaveLength(0);
  });
});
