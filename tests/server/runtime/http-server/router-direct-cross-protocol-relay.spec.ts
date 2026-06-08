import { describe, expect, it, jest } from '@jest/globals';

describe('router direct cross-protocol relay', () => {
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
});
