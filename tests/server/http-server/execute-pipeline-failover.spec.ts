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

describe('RouteCodexHttpServer.executePipeline failover', () => {
  jest.setTimeout(30000);

  it('injects startup-excluded provider keys into first hub iteration metadata', async () => {
    const server = new RouteCodexHttpServer(createTestConfig());
    const excludedAtStartup = 'deepseek-web.2.deepseek-chat';
    const providerB = 'deepseek-web.1.deepseek-chat';

    (server as any).hubPipeline = {};
    (server as any).startupExcludedProviderKeys = new Set([excludedAtStartup]);

    const runHubPipeline = jest.fn().mockResolvedValueOnce({
      requestId: 'req_startup_excluded',
      providerPayload: { model: 'deepseek-chat' },
      target: {
        providerKey: providerB,
        providerType: 'openai',
        outboundProfile: 'openai-chat',
        runtimeKey: 'runtime:B',
        processMode: 'chat'
      },
      routingDecision: { routeName: 'default' },
      processMode: 'chat',
      metadata: {}
    });
    (server as any).runHubPipeline = runHubPipeline;

    const providerHandles = new Map<string, any>();
    providerHandles.set('runtime:B', {
      providerType: 'openai',
      providerFamily: 'deepseek',
      providerId: 'deepseek-web',
      providerProtocol: 'openai-chat',
      instance: {
        processIncoming: jest.fn(async () => ({ status: 200, data: { ok: true } })),
        initialize: jest.fn(),
        cleanup: jest.fn()
      }
    });
    (server as any).providerHandles = providerHandles;

    const providerKeyToRuntimeKey = new Map<string, string>();
    providerKeyToRuntimeKey.set(providerB, 'runtime:B');
    (server as any).providerKeyToRuntimeKey = providerKeyToRuntimeKey;

    (server as any).convertProviderResponseIfNeeded = jest.fn(async ({ response }: any) => response);

    const result = await (server as any).executePipeline({
      requestId: 'req_startup_excluded',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { messages: [{ role: 'user', content: 'ping' }] },
      metadata: { stream: false, inboundStream: false }
    });

    expect(result.status).toBe(200);
    expect(runHubPipeline).toHaveBeenCalledTimes(1);
    const firstMetadata = runHubPipeline.mock.calls[0][1] as Record<string, unknown>;
    expect(firstMetadata.excludedProviderKeys).toEqual([excludedAtStartup]);
  });

  it('re-enters hub pipeline once with excludedProviderKeys on retryable provider error', async () => {
    const server = new RouteCodexHttpServer(createTestConfig());

    const providerA = 'antigravity.aliasA.modelA';
    const providerB = 'tab.key1.gpt-5.2';

    (server as any).hubPipeline = {};

    const runHubPipeline = jest.fn()
      .mockResolvedValueOnce({
        requestId: 'req_test',
        providerPayload: { model: 'modelA' },
        target: {
          providerKey: providerA,
          providerType: 'gemini',
          outboundProfile: 'gemini-chat',
          runtimeKey: 'runtime:A',
          processMode: 'chat'
        },
        routingDecision: { routeName: 'coding' },
        processMode: 'chat',
        metadata: {}
      })
      .mockResolvedValueOnce({
        requestId: 'req_test',
        providerPayload: { model: 'modelB' },
        target: {
          providerKey: providerB,
          providerType: 'gemini',
          outboundProfile: 'gemini-chat',
          runtimeKey: 'runtime:B',
          processMode: 'chat'
        },
        routingDecision: { routeName: 'coding' },
        processMode: 'chat',
        metadata: {}
      });
    (server as any).runHubPipeline = runHubPipeline;

    const providerHandles = new Map<string, any>();
    providerHandles.set('runtime:A', {
      providerType: 'gemini',
      providerFamily: 'gemini',
      providerId: 'antigravity',
      providerProtocol: 'gemini-chat',
      instance: {
        processIncoming: jest.fn(async () => {
          throw Object.assign(new Error('HTTP 429'), { statusCode: 429 });
        }),
        initialize: jest.fn(),
        cleanup: jest.fn()
      }
    });
    providerHandles.set('runtime:B', {
      providerType: 'gemini',
      providerFamily: 'gemini',
      providerId: 'tab',
      providerProtocol: 'gemini-chat',
      instance: {
        processIncoming: jest.fn(async () => ({ status: 200, data: { ok: true } })),
        initialize: jest.fn(),
        cleanup: jest.fn()
      }
    });
    (server as any).providerHandles = providerHandles;

    const providerKeyToRuntimeKey = new Map<string, string>();
    providerKeyToRuntimeKey.set(providerA, 'runtime:A');
    providerKeyToRuntimeKey.set(providerB, 'runtime:B');
    (server as any).providerKeyToRuntimeKey = providerKeyToRuntimeKey;

    (server as any).convertProviderResponseIfNeeded = jest.fn(async ({ response }: any) => response);

    const result = await (server as any).executePipeline({
      requestId: 'req_test',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { messages: [{ role: 'user', content: 'ping' }] },
      metadata: { stream: false, inboundStream: false }
    });

    expect(result.status).toBe(200);
    expect(runHubPipeline).toHaveBeenCalledTimes(2);
    const secondMetadata = runHubPipeline.mock.calls[1][1] as Record<string, unknown>;
    expect(secondMetadata.excludedProviderKeys).toEqual([providerA]);
    expect(providerHandles.get('runtime:A')!.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(providerHandles.get('runtime:B')!.instance.processIncoming).toHaveBeenCalledTimes(1);
  });

  it('re-enters hub pipeline when converted response status is 429 without error envelope', async () => {
    const server = new RouteCodexHttpServer(createTestConfig());

    const providerA = 'tab.key1.gpt-5.2';
    const providerB = 'tab.key2.gpt-5.2';

    (server as any).hubPipeline = {};

    const runHubPipeline = jest.fn()
      .mockResolvedValueOnce({
        requestId: 'req_conv_429',
        providerPayload: { model: 'gpt-5.2' },
        target: {
          providerKey: providerA,
          providerType: 'responses',
          outboundProfile: 'openai-responses',
          runtimeKey: 'runtime:A',
          processMode: 'standard'
        },
        routingDecision: { routeName: 'coding' },
        processMode: 'standard',
        metadata: {}
      })
      .mockResolvedValueOnce({
        requestId: 'req_conv_429',
        providerPayload: { model: 'gpt-5.2' },
        target: {
          providerKey: providerB,
          providerType: 'responses',
          outboundProfile: 'openai-responses',
          runtimeKey: 'runtime:B',
          processMode: 'standard'
        },
        routingDecision: { routeName: 'coding' },
        processMode: 'standard',
        metadata: {}
      });
    (server as any).runHubPipeline = runHubPipeline;

    const providerHandles = new Map<string, any>();
    providerHandles.set('runtime:A', {
      providerType: 'responses',
      providerFamily: 'openai',
      providerId: 'tab',
      providerProtocol: 'openai-responses',
      instance: {
        processIncoming: jest.fn(async () => ({ status: 200, data: { id: 'raw_a' } })),
        initialize: jest.fn(),
        cleanup: jest.fn()
      }
    });
    providerHandles.set('runtime:B', {
      providerType: 'responses',
      providerFamily: 'openai',
      providerId: 'tab',
      providerProtocol: 'openai-responses',
      instance: {
        processIncoming: jest.fn(async () => ({ status: 200, data: { id: 'raw_b' } })),
        initialize: jest.fn(),
        cleanup: jest.fn()
      }
    });
    (server as any).providerHandles = providerHandles;

    const providerKeyToRuntimeKey = new Map<string, string>();
    providerKeyToRuntimeKey.set(providerA, 'runtime:A');
    providerKeyToRuntimeKey.set(providerB, 'runtime:B');
    (server as any).providerKeyToRuntimeKey = providerKeyToRuntimeKey;

    (server as any).convertProviderResponseIfNeeded = jest
      .fn()
      .mockResolvedValueOnce({ status: 429, body: { id: 'converted_429_without_error' } })
      .mockResolvedValueOnce({ status: 200, body: { id: 'converted_ok' } });

    const result = await (server as any).executePipeline({
      requestId: 'req_conv_429',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { messages: [{ role: 'user', content: 'ping' }] },
      metadata: { stream: false, inboundStream: false }
    });

    expect(result.status).toBe(200);
    expect(runHubPipeline).toHaveBeenCalledTimes(2);
    const secondMetadata = runHubPipeline.mock.calls[1][1] as Record<string, unknown>;
    expect(secondMetadata.excludedProviderKeys).toEqual([providerA]);
    expect(providerHandles.get('runtime:A')!.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(providerHandles.get('runtime:B')!.instance.processIncoming).toHaveBeenCalledTimes(1);
  });
  it('returns first upstream error when retry-exhausted routing reports provider unavailable', async () => {
    const server = new RouteCodexHttpServer(createTestConfig());

    const providerA = 'iflow.1-186.kimi-k2.5';

    (server as any).hubPipeline = {};

    const runHubPipeline = jest.fn()
      .mockResolvedValueOnce({
        requestId: 'req_pool_exhausted',
        providerPayload: { model: 'kimi-k2.5' },
        target: {
          providerKey: providerA,
          providerType: 'openai',
          outboundProfile: 'openai-chat',
          runtimeKey: 'runtime:A',
          processMode: 'chat'
        },
        routingDecision: { routeName: 'direct' },
        processMode: 'chat',
        metadata: {}
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('All providers unavailable for model iflow.kimi-k2.5'), {
          code: 'PROVIDER_NOT_AVAILABLE'
        })
      );
    (server as any).runHubPipeline = runHubPipeline;

    const firstError = Object.assign(new Error('HTTP 429: quota exhausted'), {
      statusCode: 429,
      code: 'HTTP_429'
    });

    const providerHandles = new Map<string, any>();
    providerHandles.set('runtime:A', {
      providerType: 'openai',
      providerFamily: 'iflow',
      providerId: 'iflow',
      providerProtocol: 'openai-chat',
      instance: {
        processIncoming: jest.fn(async () => {
          throw firstError;
        }),
        initialize: jest.fn(),
        cleanup: jest.fn()
      }
    });
    (server as any).providerHandles = providerHandles;

    const providerKeyToRuntimeKey = new Map<string, string>();
    providerKeyToRuntimeKey.set(providerA, 'runtime:A');
    (server as any).providerKeyToRuntimeKey = providerKeyToRuntimeKey;

    (server as any).convertProviderResponseIfNeeded = jest.fn(async ({ response }: any) => response);

    await expect((server as any).executePipeline({
      requestId: 'req_pool_exhausted',
      entryEndpoint: '/v1/chat/completions',
      headers: {},
      body: { messages: [{ role: 'user', content: 'ping' }] },
      metadata: { stream: false, inboundStream: false }
    })).rejects.toMatchObject({
      message: 'HTTP 429: quota exhausted',
      statusCode: 429,
      code: 'HTTP_429'
    });

    expect(runHubPipeline).toHaveBeenCalledTimes(2);
    const secondMetadata = runHubPipeline.mock.calls[1][1] as Record<string, unknown>;
    expect(secondMetadata.excludedProviderKeys).toEqual([providerA]);
  });
  it('returns first upstream error when single-provider pool reroute reports provider unavailable', async () => {
    const server = new RouteCodexHttpServer(createTestConfig());

    const providerA = 'glm.key1.glm-4.7';

    (server as any).hubPipeline = {};

    const runHubPipeline = jest.fn()
      .mockResolvedValueOnce({
        requestId: 'req_single_pool_unavailable',
        providerPayload: { model: 'glm-4.7' },
        target: {
          providerKey: providerA,
          providerType: 'openai',
          outboundProfile: 'openai-chat',
          runtimeKey: 'runtime:A',
          processMode: 'chat'
        },
        routingDecision: { routeName: 'direct', pool: [providerA] },
        processMode: 'chat',
        metadata: {}
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('All providers unavailable for model glm.glm-4.7'), {
          code: 'PROVIDER_NOT_AVAILABLE'
        })
      );
    (server as any).runHubPipeline = runHubPipeline;

    const firstError = Object.assign(new Error('HTTP 429: quota exhausted'), {
      statusCode: 429,
      code: 'HTTP_429'
    });

    const providerHandles = new Map<string, any>();
    providerHandles.set('runtime:A', {
      providerType: 'openai',
      providerFamily: 'glm',
      providerId: 'glm',
      providerProtocol: 'openai-chat',
      instance: {
        processIncoming: jest.fn(async () => {
          throw firstError;
        }),
        initialize: jest.fn(),
        cleanup: jest.fn()
      }
    });
    (server as any).providerHandles = providerHandles;

    const providerKeyToRuntimeKey = new Map<string, string>();
    providerKeyToRuntimeKey.set(providerA, 'runtime:A');
    (server as any).providerKeyToRuntimeKey = providerKeyToRuntimeKey;

    (server as any).convertProviderResponseIfNeeded = jest.fn(async ({ response }: any) => response);

    await expect((server as any).executePipeline({
      requestId: 'req_single_pool_unavailable',
      entryEndpoint: '/v1/chat/completions',
      headers: {},
      body: { messages: [{ role: 'user', content: 'ping' }] },
      metadata: { stream: false, inboundStream: false }
    })).rejects.toMatchObject({
      message: 'HTTP 429: quota exhausted',
      statusCode: 429,
      code: 'HTTP_429'
    });

    expect(runHubPipeline).toHaveBeenCalledTimes(2);
    const secondMetadata = runHubPipeline.mock.calls[1][1] as Record<string, unknown>;
    expect(secondMetadata.excludedProviderKeys).toEqual([]);
  });

});
