import { describe, expect, it, jest } from '@jest/globals';

describe('direct passthrough route-level', () => {
  it('provider-mode direct sends metadata.__raw_request_body instead of mutated body', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    let sentPayload: Record<string, unknown> | undefined;
    (server as any).resolveRuntimeKeyForProviderBinding = jest.fn(() => 'dbittai-gpt.key1.gpt-5.3-codex');
    (server as any).resolveProviderHandleForBinding = jest.fn(() => ({
      runtimeKey: 'dbittai-gpt.key1.gpt-5.3-codex',
      providerId: 'dbittai-gpt',
      providerType: 'responses',
      providerFamily: 'responses',
      providerProtocol: 'openai-responses',
      runtime: {},
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, body: { ok: true } };
        },
        processIncomingDirect: async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, body: { ok: true, direct: true } };
        },
      },
    }));

    await (server as any).executeProviderDirectPipelineForPort(
      {
        port: 5555,
        host: '0.0.0.0',
        mode: 'provider',
        protocolBehavior: 'auto',
        providerBinding: 'dbittai-gpt.key1.gpt-5.3-codex',
      },
      {
        requestId: 'req_provider_route_level_raw',
        entryEndpoint: '/v1/responses',
        method: 'POST',
        headers: {},
        query: {},
        body: {
          model: 'mutated-model',
          instructions: 'mutated-system-prompt',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'mutated' }] }],
        },
        metadata: {
          __raw_request_body: {
            model: 'raw-model',
            previous_response_id: 'resp_prev_raw',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
          },
        },
      },
    );

    expect(sentPayload).toEqual({
      model: 'raw-model',
      previous_response_id: 'resp_prev_raw',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
    });
    expect((sentPayload as Record<string, unknown>).instructions).toBeUndefined();
  });

  it('router same-protocol direct keeps ingress payload transparent and preserves previous_response_id for responses providers', async () => {
    jest.resetModules();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5520 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    let sentPayload: Record<string, unknown> | undefined;
    const providerHandle = {
      runtimeKey: 'dbittai-gpt.key1.gpt-5.3-codex',
      providerId: 'dbittai-gpt',
      providerType: 'responses',
      providerFamily: 'responses',
      providerProtocol: 'openai-responses',
      runtime: {},
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, body: { ok: true } };
        },
        processIncomingDirect: async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, body: { ok: true, direct: true } };
        },
      },
    };

    (server as any).providerHandles = new Map([[providerHandle.runtimeKey, providerHandle]]);
    (server as any).hubPipeline = {
      execute: jest.fn(async () => ({
        providerPayload: {
          model: 'gpt-5.3-codex',
          reasoning: { effort: 'high' },
          instructions: 'must-not-copy',
        },
        target: {
          providerKey: 'dbittai-gpt.key1.gpt-5.3-codex',
          providerType: 'responses',
          outboundProfile: 'openai-responses',
          runtimeKey: providerHandle.runtimeKey,
          processMode: 'chat',
        },
        routingDecision: { routeName: 'default', pool: ['dbittai-gpt.key1.gpt-5.3-codex'] },
        metadata: { processMode: 'chat' },
      })),
    };

    const directResult = await (server as any).executeRouterDirectPipelineForPort(
      {
        port: 5520,
        host: '0.0.0.0',
        mode: 'router',
        routingPolicyGroup: 'default',
        sameProtocolBehavior: 'direct',
      },
      {
        requestId: 'req_router_route_level_raw',
        entryEndpoint: '/v1/responses',
        method: 'POST',
        headers: {},
        query: {},
        body: {
          model: 'mutated-model',
          instructions: 'mutated-system-prompt',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'mutated' }] }],
        },
        metadata: {
          __raw_request_body: {
            model: 'raw-model',
            previous_response_id: 'resp_prev_router',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
          },
        },
      },
    );

    expect(directResult.used).toBe(true);
    expect(sentPayload).toEqual({
      model: 'gpt-5.3-codex',
      previous_response_id: 'resp_prev_router',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
      reasoning: { effort: 'high' },
    });
    expect((sentPayload as Record<string, unknown>).instructions).toBeUndefined();
  });
});
