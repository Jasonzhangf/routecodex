import { describe, expect, it, jest } from '@jest/globals';

describe('direct server contract', () => {
  it('RED-GREEN: provider-direct forwards the original request body without stream/model repair', async () => {
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const requestBody = {
      model: 'deepseek-v4-flash',
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hello' }],
    };
    let sentPayload: Record<string, unknown> | undefined;

    (server as any).resolveRuntimeKeyForProviderBinding = jest.fn(() => 'provider.key1.model');
    (server as any).resolveProviderHandleForBinding = jest.fn(() => ({
      runtimeKey: 'provider.key1.model',
      providerId: 'provider',
      providerType: 'openai',
      providerFamily: 'openai',
      providerProtocol: 'openai-chat',
      runtime: {},
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, data: { ok: true, echoedModel: payload.model, stream: payload.stream ?? null } };
        },
        processIncomingDirect: async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return { status: 200, data: { ok: true, echoedModel: payload.model, stream: payload.stream ?? null } };
        },
      },
    }));

    const result = await (server as any).executeProviderDirectPipelineForPort(
      {
        port: 5555,
        host: '0.0.0.0',
        mode: 'provider',
        protocolBehavior: 'auto',
        providerBinding: 'provider.key1.model',
      },
      {
        requestId: 'req_direct_provider_no_repair',
        entryEndpoint: '/v1/chat/completions',
        method: 'POST',
        headers: { accept: 'text/event-stream' },
        query: {},
        body: requestBody,
        metadata: {
          stream: true,
          routeParams: { model: 'server-must-not-overwrite' },
          __raw_request_body: { model: 'raw-must-not-overwrite' },
        },
      },
    );

    expect(sentPayload).toBe(requestBody);
    expect(sentPayload?.model).toBe('deepseek-v4-flash');
    expect(sentPayload?.stream).toBeUndefined();
    expect(sentPayload?.stream_options).toEqual({ include_usage: true });
    expect((result.body as Record<string, unknown>).echoedModel).toBe('deepseek-v4-flash');
  });

  it('RED-GREEN: router-direct forwards current client model/tools unchanged and does not enter Hub execute', async () => {
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const providerKey = 'DF.key1.deepseek-v4-pro';
    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: { host: '127.0.0.1', port: 10000 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    let sentPayload: Record<string, unknown> | undefined;
    const executeSpy = jest.fn(async () => {
      throw new Error('router-direct must not enter hub execute');
    });
    const route = jest.fn(() => ({
      target: {
        providerKey,
        providerType: 'openai',
        outboundProfile: 'openai-chat',
        runtimeKey: providerKey,
        modelId: 'DeepSeek-V4-Pro',
      },
      decision: { routeName: 'thinking', pool: [providerKey], reason: 'thinking:user-input' },
      diagnostics: {},
    }));

    (server as any).userConfig = {
      httpserver: {
        ports: [{
          port: 10000,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_coding_10000',
          sameProtocolBehavior: 'direct',
        }],
      },
    };
    (server as any).hubPipeline = {
      execute: executeSpy,
      getVirtualRouter: jest.fn(() => ({ route })),
      updateVirtualRouterConfig: jest.fn(),
    };
    (server as any).hubPipelinesByRoutingPolicyGroup = new Map([
      ['gateway_coding_10000', (server as any).hubPipeline],
    ]);
    (server as any).providerHandles = new Map([
      [providerKey, {
        runtimeKey: providerKey,
        providerId: 'DF',
        providerType: 'openai',
        providerFamily: 'openai',
        providerProtocol: 'openai-chat',
        runtime: {},
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: jest.fn(async (payload: Record<string, unknown>) => {
            sentPayload = payload;
            return {
              status: 200,
              data: {
                id: 'chatcmpl_df_direct_passthrough',
                object: 'chat.completion',
                model: String(payload.model || ''),
                choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
              },
            };
          }),
        },
      }],
    ]);

    const tools = [{ type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } }];
    const outcome = await (server as any).executeRouterDirectPipelineForPort(
      {
        port: 10000,
        host: '127.0.0.1',
        mode: 'router',
        routingPolicyGroup: 'gateway_coding_10000',
        sameProtocolBehavior: 'direct',
      },
      {
        requestId: 'req_router_direct_passthrough',
        entryEndpoint: '/v1/chat/completions',
        method: 'POST',
        headers: {},
        query: {},
        body: {
          model: 'deepseek-v4-pro',
          stream: false,
          tools,
          messages: [{ role: 'user', content: 'hello' }],
        },
        metadata: {},
      },
    );

    expect(outcome.used).toBe(true);
    expect(sentPayload?.model).toBe('deepseek-v4-pro');
    expect(sentPayload?.tools).toBe(tools);
    expect((outcome.response as any)?.data?.model).toBe('deepseek-v4-pro');
    expect(executeSpy).not.toHaveBeenCalled();
  });
});
