import { jest } from '@jest/globals';
import { RouteCodexHttpServer } from '../../../src/server/runtime/http-server/index.js';
import type { ServerConfigV2 } from '../../../src/server/runtime/http-server/types.js';

function createTestConfig(): ServerConfigV2 {
  return {
    server: {
      host: '127.0.0.1',
      port: 0
    },
    pipeline: {},
    logging: { level: 'error', enableConsole: false },
    providers: {}
  };
}

describe('RouteCodexHttpServer response session headers', () => {
  jest.setTimeout(30000);

  it('echoes session_id and mirrors conversation_id when missing', async () => {
    const server = new RouteCodexHttpServer(createTestConfig());

    const providerKey = 'mock.default.toolloop';
    const runtimeKey = 'runtime:mock';

    (server as any).hubPipeline = {};
    (server as any).runHubPipeline = jest.fn().mockResolvedValueOnce({
      requestId: 'req_test',
      providerPayload: { model: 'toolloop' },
      target: {
        providerKey,
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        runtimeKey,
        processMode: 'chat'
      },
      routingDecision: { routeName: 'default' },
      processMode: 'chat',
      metadata: {}
    });

    const providerHandles = new Map<string, any>();
    providerHandles.set(runtimeKey, {
      providerType: 'responses',
      providerFamily: 'responses',
      providerId: 'mock',
      providerProtocol: 'openai-responses',
      instance: {
        processIncoming: jest.fn(async () => ({ status: 200, data: { ok: true } })),
        initialize: jest.fn(),
        cleanup: jest.fn()
      }
    });
    (server as any).providerHandles = providerHandles;

    const providerKeyToRuntimeKey = new Map<string, string>();
    providerKeyToRuntimeKey.set(providerKey, runtimeKey);
    (server as any).providerKeyToRuntimeKey = providerKeyToRuntimeKey;

    (server as any).convertProviderResponseIfNeeded = jest.fn(async ({ response }: any) => response);

    const result = await (server as any).executePipeline({
      requestId: 'req_test',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { input: [] },
      metadata: { stream: false, inboundStream: false, sessionId: 'sess-123' }
    });

    expect(result.status).toBe(200);
    expect(result.headers?.session_id).toBe('sess-123');
    expect(result.headers?.conversation_id).toBe('sess-123');
  });
});

