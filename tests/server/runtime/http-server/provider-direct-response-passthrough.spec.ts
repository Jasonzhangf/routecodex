import { describe, expect, it, jest } from '@jest/globals';

describe('provider-direct response passthrough', () => {
  it('provider-mode direct streaming bypasses response converter entirely', async () => {
    jest.resetModules();

    const convertSpy = jest.fn(async () => {
      throw new Error('converter should not be called for provider-direct passthrough');
    });

    jest.unstable_mockModule(
      '../../../../src/server/runtime/http-server/executor/provider-response-converter.js',
      () => ({
        convertProviderResponseIfNeeded: convertSpy,
      }),
    );

    const { RouteCodexHttpServer } = await import('../../../../src/server/runtime/http-server/index.js');

    const server = new RouteCodexHttpServer({
      configPath: '/tmp/routecodex-test-config.json',
      server: {
        host: '127.0.0.1',
        port: 5555,
      },
      pipeline: {},
      logging: {
        level: 'error',
        enableConsole: false,
      },
      providers: {},
    } as any);

    const upstreamResponse = {
      status: 200,
      body: {
        id: 'resp_direct_stream',
        object: 'response',
        status: 'completed',
        output: [
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'hello direct' }],
          },
        ],
      },
    };

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
        processIncoming: async () => upstreamResponse,
        processIncomingDirect: async () => upstreamResponse,
      },
    }));

    const result = await (server as any).executeProviderDirectPipelineForPort(
      {
        port: 5555,
        host: '0.0.0.0',
        mode: 'provider',
        protocolBehavior: 'auto',
        providerBinding: 'dbittai-gpt.key1.gpt-5.3-codex',
      },
      {
        requestId: 'req_provider_direct_streaming',
        entryEndpoint: '/v1/responses',
        method: 'POST',
        headers: { accept: 'text/event-stream' },
        query: {},
        body: {
          model: 'gpt-5.4',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
        },
        metadata: {
          stream: true,
          inboundStream: true,
          __raw_request_body: {
            model: 'gpt-5.4',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
          },
        },
      },
    );

    expect(convertSpy).not.toHaveBeenCalled();
    expect(result.status).toBe(200);
    expect(result.body).toEqual(upstreamResponse.body);
    expect(result.usageLogInfo?.routeName).toBe('port.provider-direct');
  });
});
