import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { resetSessionStormBackoffStateForTests } from '../../../../src/server/runtime/http-server/executor/request-executor-session-storm-backoff';

describe('router direct cross-protocol relay', () => {
  afterEach(() => {
    jest.useRealTimers();
    resetSessionStormBackoffStateForTests();
    delete process.env.ROUTECODEX_SESSION_STORM_BACKOFF_BASE_MS;
    delete process.env.RCC_SESSION_STORM_BACKOFF_BASE_MS;
    delete process.env.ROUTECODEX_SESSION_STORM_BACKOFF_MAX_MS;
    delete process.env.RCC_SESSION_STORM_BACKOFF_MAX_MS;
  });

  it('source and runtime artifacts keep protocol mismatch out of failed_no_relay', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');

    const root = process.cwd();
    const candidates = [
      path.join(root, 'src/server/runtime/http-server/index.ts'),
      path.join(root, 'dist/server/runtime/http-server/index.js'),
      path.join(os.homedir(), '.rcc/install/current/dist/server/runtime/http-server/index.js'),
    ].filter((filePath) => fs.existsSync(filePath));

    expect(candidates.length).toBeGreaterThan(0);
    for (const filePath of candidates) {
      const source = fs.readFileSync(filePath, 'utf8');
      const failedNoRelayIndex = source.indexOf("router-direct.failed_no_relay");
      const relayIndex = source.indexOf("directResult.requiresHubRelay === true");
      expect(relayIndex).toBeGreaterThanOrEqual(0);
      expect(failedNoRelayIndex).toBeGreaterThan(relayIndex);
    }
  });

  it('relays /v1/responses cross-protocol target once without failed_no_relay storm', async () => {
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);
    const preselectedRoute = {
      target: {
        providerKey: 'anthropic.key1.claude-test',
        providerType: 'anthropic',
        runtimeKey: 'anthropic.key1.claude-test',
        modelId: 'claude-test',
      },
      decision: { routeName: 'search', pool: ['anthropic.key1.claude-test'] },
      diagnostics: {},
    };
    (server as any).userConfig = {
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
    (server as any).hubPipeline = { execute: jest.fn(), updateVirtualRouterConfig: jest.fn() };
    (server as any).hubPipelinesByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', (server as any).hubPipeline],
    ]);
    const directSpy = jest.spyOn(server as any, 'executeRouterDirectPipelineForPort').mockResolvedValue({
      used: false,
      reason: 'protocol mismatch: inbound=openai-responses, provider=anthropic-messages',
      requiresHubRelay: true,
      preselectedRoute,
    } as any);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline').mockResolvedValue({
      status: 200,
      body: { id: 'resp_cross_protocol_relay', object: 'response' },
      metadata: {},
    } as any);
    const logStageSpy = jest.spyOn(server as any, 'logStage');

    const result = await (server as any).executePortAwarePipeline(5555, {
      requestId: 'req_router_direct_cross_protocol_relay_no_storm',
      entryEndpoint: '/v1/responses',
      method: 'POST',
      headers: {},
      query: {},
      body: {
        model: 'router-gpt-5.5',
        stream: true,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'search' }] }],
      },
      metadata: {},
    });

    expect(result.body).toEqual({ id: 'resp_cross_protocol_relay', object: 'response' });
    expect(directSpy).toHaveBeenCalledTimes(1);
    expect(executePipelineSpy).toHaveBeenCalledTimes(1);
    expect(executePipelineSpy.mock.calls[0]?.[0]?.metadata).toEqual(expect.objectContaining({
      __routecodexPreselectedRoute: preselectedRoute,
      routecodexRoutingPolicyGroup: 'gateway_priority_5555',
    }));
    expect(logStageSpy).toHaveBeenCalledWith(
      'router-direct.relay',
      'req_router_direct_cross_protocol_relay_no_storm',
      expect.objectContaining({
        reason: 'protocol mismatch: inbound=openai-responses, provider=anthropic-messages',
        providerKey: 'anthropic.key1.claude-test',
        routeName: 'search',
      })
    );
    expect(logStageSpy).not.toHaveBeenCalledWith(
      'router-direct.failed_no_relay',
      expect.any(String),
      expect.anything()
    );
  });

  it('keeps protocol mismatch errors separate from request storm handling', async () => {
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);
    const preselectedRoute = {
      target: {
        providerKey: 'mini27.key1.MiniMax-M2.7.MiniMax-M2.7',
        providerType: 'openai',
        runtimeKey: 'mini27.key1.MiniMax-M2.7.MiniMax-M2.7',
        modelId: 'MiniMax-M2.7',
      },
      decision: { routeName: 'search', pool: ['mini27.key1.MiniMax-M2.7.MiniMax-M2.7'] },
      diagnostics: {},
    };
    (server as any).userConfig = {
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
    (server as any).hubPipeline = { execute: jest.fn(), updateVirtualRouterConfig: jest.fn() };
    (server as any).hubPipelinesByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', (server as any).hubPipeline],
    ]);
    const directSpy = jest.spyOn(server as any, 'executeRouterDirectPipelineForPort').mockResolvedValue({
      used: false,
      reason: 'protocol mismatch: inbound=openai-responses, provider=openai-chat',
      requiresHubRelay: true,
      preselectedRoute,
    } as any);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline').mockImplementation(async (input: any) => ({
      status: 200,
      body: { id: `resp_${input.requestId}`, object: 'response' },
      metadata: {},
    }) as any);
    const logStageSpy = jest.spyOn(server as any, 'logStage');

    const requests = ['req_storm_1', 'req_storm_2', 'req_storm_3'].map((requestId) => {
      return (server as any).executePortAwarePipeline(5555, {
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
        metadata: {},
      });
    });

    const results = await Promise.all(requests);

    expect(results.map((result: any) => result.body.id)).toEqual([
      'resp_req_storm_1',
      'resp_req_storm_2',
      'resp_req_storm_3',
    ]);
    expect(directSpy).toHaveBeenCalledTimes(3);
    expect(executePipelineSpy).toHaveBeenCalledTimes(3);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.relay')).toHaveLength(3);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.failed_no_relay')).toHaveLength(0);
    for (const call of executePipelineSpy.mock.calls) {
      expect(call[0].metadata).toEqual(expect.objectContaining({
        __routecodexPreselectedRoute: preselectedRoute,
        routecodexRoutingPolicyGroup: 'gateway_priority_5555',
      }));
    }
  });

  it('backs off repeated router-direct protocol mismatch failures without rewriting the error', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-09T00:00:00.000Z'));
    process.env.ROUTECODEX_SESSION_STORM_BACKOFF_BASE_MS = '1000';
    process.env.ROUTECODEX_SESSION_STORM_BACKOFF_MAX_MS = '8000';

    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);
    (server as any).userConfig = {
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
    (server as any).hubPipeline = { execute: jest.fn(), updateVirtualRouterConfig: jest.fn() };
    (server as any).hubPipelinesByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', (server as any).hubPipeline],
    ]);
    jest.spyOn(server as any, 'executeRouterDirectPipelineForPort').mockResolvedValue({
      used: false,
      reason: 'protocol mismatch: inbound=openai-responses, provider=openai-chat',
    } as any);
    const logStageSpy = jest.spyOn(server as any, 'logStage');

    const buildInput = (requestId: string) => ({
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
      metadata: { sessionId: 'router-direct-protocol-mismatch-storm' },
    });

    await expect((server as any).executePortAwarePipeline(5555, buildInput('req_router_direct_mismatch_1')))
      .rejects.toThrow('router-direct failed without relay: protocol mismatch: inbound=openai-responses, provider=openai-chat');

    const second = (server as any).executePortAwarePipeline(5555, buildInput('req_router_direct_mismatch_2'));
    const secondExpectation = expect(second)
      .rejects.toThrow('router-direct failed without relay: protocol mismatch: inbound=openai-responses, provider=openai-chat');
    await jest.advanceTimersByTimeAsync(999);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'request.session_storm_backoff_wait')).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    await secondExpectation;

    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'request.session_storm_backoff.recorded')).toHaveLength(2);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.failed_no_relay')).toHaveLength(2);
  });

  it('propagates real direct protocol mismatch into Hub relay', async () => {
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const runtimeKey = 'mini27.key1.MiniMax-M2.7.MiniMax-M2.7';
    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);
    (server as any).userConfig = {
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
    (server as any).providerHandles = new Map([[runtimeKey, {
      runtimeKey,
      providerId: 'mini27',
      providerType: 'openai',
      providerFamily: 'openai',
      providerProtocol: 'openai-chat',
      runtime: {},
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: jest.fn(async () => {
          throw new Error('cross-protocol direct must not call provider transport');
        }),
        processIncomingDirect: jest.fn(async () => {
          throw new Error('cross-protocol direct must not call provider transport');
        }),
      },
    }]]);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline').mockResolvedValue({
      status: 200,
      body: { id: 'resp_real_cross_protocol_relay', object: 'response' },
      metadata: {},
    } as any);
    (server as any).hubPipeline = {
      execute: jest.fn(async () => {
        throw new Error('relay boundary is owned by executePipeline in this test');
      }),
      updateVirtualRouterConfig: jest.fn(),
      getVirtualRouter: jest.fn(() => ({
        route: jest.fn(() => ({
          target: {
            providerKey: runtimeKey,
            providerType: 'openai',
            runtimeKey,
            modelId: 'MiniMax-M2.7',
          },
          decision: { routeName: 'search', pool: [runtimeKey] },
          diagnostics: {},
        })),
      })),
    };
    (server as any).hubPipelinesByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', (server as any).hubPipeline],
    ]);
    const logStageSpy = jest.spyOn(server as any, 'logStage');

    const result = await (server as any).executePortAwarePipeline(5555, {
      requestId: 'req_real_router_direct_cross_protocol_relay',
      entryEndpoint: '/v1/responses',
      method: 'POST',
      headers: {},
      query: {},
      body: {
        model: 'router-gpt-5.5',
        stream: true,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'search' }] }],
      },
      metadata: {},
    });

    expect(result.body).toEqual({ id: 'resp_real_cross_protocol_relay', object: 'response' });
    expect(executePipelineSpy).toHaveBeenCalledTimes(1);
    expect(executePipelineSpy.mock.calls[0]?.[0]?.metadata).toEqual(expect.objectContaining({
      __routecodexPreselectedRoute: expect.objectContaining({
        target: expect.objectContaining({ providerKey: runtimeKey }),
      }),
      routecodexRoutingPolicyGroup: 'gateway_priority_5555',
    }));
    expect((server as any).providerHandles.get(runtimeKey).instance.processIncoming).not.toHaveBeenCalled();
    expect((server as any).providerHandles.get(runtimeKey).instance.processIncomingDirect).not.toHaveBeenCalled();
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.relay')).toHaveLength(1);
    expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.failed_no_relay')).toHaveLength(0);
  });

  it('HTTP BLACKBOX: /v1/responses cross-protocol direct miss enters Hub relay', async () => {
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const runtimeKey = 'mini27.key1.MiniMax-M2.7.MiniMax-M2.7';
    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);
    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 0,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'direct',
          stopMessage: { enabled: false },
        }],
      },
    };
    const directSend = jest.fn(async () => {
      throw new Error('cross-protocol direct must not call provider transport');
    });
    (server as any).providerHandles = new Map([[runtimeKey, {
      runtimeKey,
      providerId: 'mini27',
      providerType: 'openai',
      providerFamily: 'openai',
      providerProtocol: 'openai-chat',
      runtime: { modelId: 'MiniMax-M2.7' },
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: directSend,
        processIncomingDirect: directSend,
      },
    }]]);
    const executePipelineSpy = jest.spyOn(server as any, 'executePipeline').mockResolvedValue({
      status: 200,
      body: {
        id: 'resp_http_cross_protocol_relay',
        object: 'response',
        status: 'completed',
        output_text: 'ok',
      },
      metadata: {},
    } as any);
    (server as any).hubPipeline = {
      execute: jest.fn(async () => {
        throw new Error('relay boundary is owned by executePipeline in this test');
      }),
      updateVirtualRouterConfig: jest.fn(),
      getVirtualRouter: jest.fn(() => ({
        route: jest.fn(() => ({
          target: {
            providerKey: runtimeKey,
            providerType: 'openai',
            runtimeKey,
            modelId: 'MiniMax-M2.7',
          },
          decision: { routeName: 'search', pool: [runtimeKey] },
          diagnostics: {},
        })),
      })),
    };
    (server as any).hubPipelinesByRoutingPolicyGroup = new Map([
      ['gateway_priority_5555', (server as any).hubPipeline],
    ]);
    const logStageSpy = jest.spyOn(server as any, 'logStage');

    await (server as any).initialize();
    (server as any).runtimeReadyResolved = true;
    (server as any).runtimeReadyResolve?.();
    await (server as any).startPortListener({
      port: 0,
      host: '127.0.0.1',
      mode: 'router',
      routingPolicyGroup: 'gateway_priority_5555',
      sameProtocolBehavior: 'direct',
      stopMessage: { enabled: false },
    });
    const boundPort = (server as any).server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${boundPort}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'router-gpt-5.5',
          stream: false,
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'search' }] }],
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toEqual(expect.objectContaining({
        id: 'resp_http_cross_protocol_relay',
        object: 'response',
      }));
      expect(directSend).not.toHaveBeenCalled();
      expect(executePipelineSpy).toHaveBeenCalledTimes(1);
      expect(executePipelineSpy.mock.calls[0]?.[0]?.metadata).toEqual(expect.objectContaining({
        __routecodexPreselectedRoute: expect.objectContaining({
          target: expect.objectContaining({ providerKey: runtimeKey }),
        }),
        routecodexRoutingPolicyGroup: 'gateway_priority_5555',
      }));
      expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.relay')).toHaveLength(1);
      expect(logStageSpy.mock.calls.filter(([stage]) => stage === 'router-direct.failed_no_relay')).toHaveLength(0);
    } finally {
      await server.stop();
    }
  }, 15000);
});
