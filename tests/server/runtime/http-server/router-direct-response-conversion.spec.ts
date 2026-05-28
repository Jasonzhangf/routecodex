import { describe, expect, it, jest } from '@jest/globals';

const mockConvertProviderResponseIfNeeded = jest.fn(async (options: any) => ({
  ...options.response,
  body: {
    converted: true,
    original: options.response.body,
    entryEndpoint: options.entryEndpoint,
    serverToolsEnabled: options.serverToolsEnabled
  }
}));

jest.unstable_mockModule(
  '../../../../src/server/runtime/http-server/executor-response.js',
  () => ({
    convertProviderResponseIfNeeded: mockConvertProviderResponseIfNeeded
  })
);

describe('router-direct response conversion', () => {
  it.each([
    {
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      providerType: 'openai',
      response: {
        status: 200,
        body: {
          id: 'chatcmpl_stopless_direct',
          object: 'chat.completion',
          model: 'MiniMax-M2.7',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'Now let me add regression tests.' }
            }
          ]
        }
      },
      body: { model: 'MiniMax-M2.7', messages: [{ role: 'user', content: 'continue' }] }
    },
    {
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      providerType: 'anthropic',
      response: {
        status: 200,
        body: {
          id: 'msg_stopless_direct',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'done' }]
        }
      },
      body: { model: 'claude-test', messages: [{ role: 'user', content: 'continue' }] }
    },
    {
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      providerType: 'responses',
      response: {
        status: 200,
        body: {
          id: 'resp_stopless_direct',
          object: 'response',
          status: 'completed',
          output: [
            {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'done' }]
            }
          ]
        }
      },
      body: { model: 'gpt-test', input: [{ role: 'user', content: [{ type: 'input_text', text: 'continue' }] }] }
    }
  ])('routes same-protocol direct %s responses back through the unified response bridge for stopless', async (sample) => {
    jest.resetModules();
    mockConvertProviderResponseIfNeeded.mockClear();
    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-router-direct-response-conversion.json',
      server: { host: '127.0.0.1', port: 5555 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {}
    } as any);

    const directResult = {
      used: true,
      response: sample.response,
      providerHandle: {
        runtimeKey: 'mini27.key1.MiniMax-M2.7',
        providerId: 'mini27',
        providerType: sample.providerType,
        providerFamily: sample.providerType,
        providerProtocol: sample.providerProtocol,
        runtime: {},
        instance: {}
      },
      auditContext: {
        originalPayload: {},
        observedFields: [],
        providerKey: 'mini27.key1.MiniMax-M2.7',
        inboundProtocol: sample.providerProtocol,
        providerProtocol: sample.providerProtocol,
        routingDecision: { routeName: 'search' },
        processMode: 'chat'
      },
      requestSemantics: { tools: { clientToolsRaw: [] } },
      pipelineMetadata: { routeName: 'search' }
    };

    const result = await (server as any).buildRouterDirectResult(directResult, {
      requestId: 'req_router_direct_stopless_bridge',
      entryEndpoint: sample.entryEndpoint,
      method: 'POST',
      headers: {},
      query: {},
      body: sample.body,
      metadata: { stream: false, routecodexLocalPort: 5555, routecodexPortMode: 'router' }
    });

    expect(mockConvertProviderResponseIfNeeded).toHaveBeenCalledTimes(1);
    expect(mockConvertProviderResponseIfNeeded.mock.calls[0]?.[0]).toMatchObject({
      entryEndpoint: sample.entryEndpoint,
      requestId: 'req_router_direct_stopless_bridge',
      processMode: 'chat',
      serverToolsEnabled: true,
      pipelineMetadata: {
        routecodexLocalPort: 5555,
        routecodexPortMode: 'router',
        routeName: 'search'
      }
    });
    expect(result.body).toMatchObject({ converted: true, serverToolsEnabled: true });
    await server.stop();
  });
});
