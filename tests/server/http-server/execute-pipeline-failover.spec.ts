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

function attachHubPipeline(server: any, execute: (input: any) => Promise<any>): jest.Mock {
  const executeMock = jest.fn(execute);
  server.hubPipeline = {
    execute: executeMock,
    updateVirtualRouterConfig: jest.fn()
  };
  return executeMock;
}

function attachProviderHandle(server: any, input: {
  providerKey: string;
  runtimeKey: string;
  providerType: string;
  providerFamily: string;
  providerId: string;
  providerProtocol: string;
  processIncoming: (payload: unknown) => Promise<any>;
}): void {
  const providerHandles = new Map<string, any>((server.providerHandles as Map<string, any>) ?? []);
  providerHandles.set(input.runtimeKey, {
    providerType: input.providerType,
    providerFamily: input.providerFamily,
    providerId: input.providerId,
    providerProtocol: input.providerProtocol,
    instance: {
      processIncoming: jest.fn(input.processIncoming),
      initialize: jest.fn(),
      cleanup: jest.fn()
    }
  });
  server.providerHandles = providerHandles;

  const providerKeyToRuntimeKey = new Map<string, string>((server.providerKeyToRuntimeKey as Map<string, string>) ?? []);
  providerKeyToRuntimeKey.set(input.providerKey, input.runtimeKey);
  server.providerKeyToRuntimeKey = providerKeyToRuntimeKey;
}

describe('RouteCodexHttpServer.executePipeline failover', () => {
  jest.setTimeout(30000);

  it('does not inject startupExcludedProviderKeys into hub metadata in request-executor path', async () => {
    const server = new RouteCodexHttpServer(createTestConfig());
    const providerKey = 'deepseek-web.1.deepseek-chat';
    const runtimeKey = 'runtime:B';

    server.startupExcludedProviderKeys = new Set(['deepseek-web.2.deepseek-chat']);

    const hubExecute = attachHubPipeline(server, async () => ({
      providerPayload: { model: 'deepseek-chat' },
      target: {
        providerKey,
        providerType: 'openai',
        outboundProfile: 'openai-chat',
        runtimeKey,
        processMode: 'chat'
      },
      routingDecision: { routeName: 'default' },
      processMode: 'chat',
      metadata: {}
    }));

    attachProviderHandle(server, {
      providerKey,
      runtimeKey,
      providerType: 'openai',
      providerFamily: 'deepseek',
      providerId: 'deepseek-web',
      providerProtocol: 'openai-chat',
      processIncoming: async () => ({ status: 200, data: { ok: true } })
    });

    const result = await server['executePipeline']({
      requestId: 'req_startup_excluded',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { messages: [{ role: 'user', content: 'ping' }] },
      metadata: { stream: false, inboundStream: false }
    });

    expect(result.status).toBe(200);
    expect(hubExecute).toHaveBeenCalledTimes(1);
    const firstPipelineInput = hubExecute.mock.calls[0]?.[0] as Record<string, any>;
    expect(firstPipelineInput?.metadata?.excludedProviderKeys).toBeUndefined();
  });

  it('re-enters hub pipeline once with excludedProviderKeys on retryable provider error', async () => {
    const server = new RouteCodexHttpServer(createTestConfig());

    const providerA = 'antigravity.aliasA.modelA';
    const providerB = 'tab.key1.gpt-5.2';

    const hubExecute = attachHubPipeline(server, async (input: any) => {
      const excluded = Array.isArray(input?.metadata?.excludedProviderKeys)
        ? input.metadata.excludedProviderKeys
        : [];
      if (excluded.includes(providerA)) {
        return {
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
        };
      }
      return {
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
      };
    });

    attachProviderHandle(server, {
      providerKey: providerA,
      runtimeKey: 'runtime:A',
      providerType: 'gemini',
      providerFamily: 'gemini',
      providerId: 'antigravity',
      providerProtocol: 'gemini-chat',
      processIncoming: async () => {
        throw Object.assign(new Error('HTTP 429'), { statusCode: 429 });
      }
    });
    attachProviderHandle(server, {
      providerKey: providerB,
      runtimeKey: 'runtime:B',
      providerType: 'gemini',
      providerFamily: 'gemini',
      providerId: 'tab',
      providerProtocol: 'gemini-chat',
      processIncoming: async () => ({ status: 200, data: { ok: true } })
    });

    const result = await server['executePipeline']({
      requestId: 'req_test',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { messages: [{ role: 'user', content: 'ping' }] },
      metadata: { stream: false, inboundStream: false }
    });

    expect(result.status).toBe(200);
    expect(hubExecute).toHaveBeenCalledTimes(2);
    const secondPipelineInput = hubExecute.mock.calls[1]?.[0] as Record<string, any>;
    expect(secondPipelineInput?.metadata?.excludedProviderKeys).toEqual([providerA]);
  });

  it('re-enters hub pipeline when upstream response status is 429', async () => {
    const server = new RouteCodexHttpServer(createTestConfig());

    const providerA = 'tab.key1.gpt-5.2';
    const providerB = 'tab.key2.gpt-5.2';

    const hubExecute = attachHubPipeline(server, async (input: any) => {
      const excluded = Array.isArray(input?.metadata?.excludedProviderKeys)
        ? input.metadata.excludedProviderKeys
        : [];
      if (excluded.includes(providerA)) {
        return {
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
        };
      }
      return {
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
      };
    });

    attachProviderHandle(server, {
      providerKey: providerA,
      runtimeKey: 'runtime:A',
      providerType: 'responses',
      providerFamily: 'openai',
      providerId: 'tab',
      providerProtocol: 'openai-responses',
      processIncoming: async () => ({ status: 429, data: { error: { message: 'rate limited' } } })
    });
    attachProviderHandle(server, {
      providerKey: providerB,
      runtimeKey: 'runtime:B',
      providerType: 'responses',
      providerFamily: 'openai',
      providerId: 'tab',
      providerProtocol: 'openai-responses',
      processIncoming: async () => ({ status: 200, data: { id: 'ok' } })
    });

    const result = await server['executePipeline']({
      requestId: 'req_conv_429',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { messages: [{ role: 'user', content: 'ping' }] },
      metadata: { stream: false, inboundStream: false }
    });

    expect(result.status).toBe(200);
    expect(hubExecute).toHaveBeenCalledTimes(2);
    const secondPipelineInput = hubExecute.mock.calls[1]?.[0] as Record<string, any>;
    expect(secondPipelineInput?.metadata?.excludedProviderKeys).toEqual([providerA]);
  });

  it('returns first upstream error when retry-exhausted routing reports provider unavailable', async () => {
    const server = new RouteCodexHttpServer(createTestConfig());

    const providerA = 'iflow.1-186.kimi-k2.5';
    const firstError = Object.assign(new Error('HTTP 429: quota exhausted'), {
      statusCode: 429,
      code: 'HTTP_429'
    });

    const hubExecute = attachHubPipeline(server, async (input: any) => {
      const excluded = Array.isArray(input?.metadata?.excludedProviderKeys)
        ? input.metadata.excludedProviderKeys
        : [];
      if (excluded.includes(providerA)) {
        throw Object.assign(new Error('All providers unavailable for model iflow.kimi-k2.5'), {
          code: 'PROVIDER_NOT_AVAILABLE'
        });
      }
      return {
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
      };
    });

    attachProviderHandle(server, {
      providerKey: providerA,
      runtimeKey: 'runtime:A',
      providerType: 'openai',
      providerFamily: 'iflow',
      providerId: 'iflow',
      providerProtocol: 'openai-chat',
      processIncoming: async () => {
        throw firstError;
      }
    });

    await expect(server['executePipeline']({
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

    expect(hubExecute).toHaveBeenCalledTimes(2);
    const secondPipelineInput = hubExecute.mock.calls[1]?.[0] as Record<string, any>;
    expect(secondPipelineInput?.metadata?.excludedProviderKeys).toEqual([providerA]);
  });

  it('keeps excludedProviderKeys empty for single-provider pool retries', async () => {
    const server = new RouteCodexHttpServer(createTestConfig());

    const providerA = 'glm.key1.glm-4.7';
    const firstError = Object.assign(new Error('HTTP 429: quota exhausted'), {
      statusCode: 429,
      code: 'HTTP_429'
    });
    let pipelineCallCount = 0;

    const hubExecute = attachHubPipeline(server, async () => {
      pipelineCallCount += 1;
      if (pipelineCallCount >= 2) {
        throw Object.assign(new Error('All providers unavailable for model glm.glm-4.7'), {
          code: 'PROVIDER_NOT_AVAILABLE'
        });
      }
      return {
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
      };
    });

    attachProviderHandle(server, {
      providerKey: providerA,
      runtimeKey: 'runtime:A',
      providerType: 'openai',
      providerFamily: 'glm',
      providerId: 'glm',
      providerProtocol: 'openai-chat',
      processIncoming: async () => {
        throw firstError;
      }
    });

    await expect(server['executePipeline']({
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

    expect(hubExecute).toHaveBeenCalledTimes(2);
    const secondPipelineInput = hubExecute.mock.calls[1]?.[0] as Record<string, any>;
    expect(secondPipelineInput?.metadata?.excludedProviderKeys).toBeUndefined();
  });
});
