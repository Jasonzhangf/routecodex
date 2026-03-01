import { jest } from '@jest/globals';
import { createRequestExecutor } from '../../../../src/server/runtime/http-server/request-executor';
import type { ProviderHandle } from '../../../../src/server/runtime/http-server/types';
import { StatsManager } from '../../../../src/server/runtime/http-server/stats-manager';

function buildHandle(providerKey: string, processFn: () => Promise<unknown>): ProviderHandle {
  return {
    runtimeKey: providerKey,
    providerId: providerKey,
    providerType: 'gemini',
    providerFamily: 'gemini',
    providerProtocol: 'gemini-chat',
    runtime: {
      runtimeKey: providerKey,
      providerId: providerKey,
      keyAlias: providerKey,
      providerType: 'gemini',
      endpoint: 'https://example.invalid',
      auth: { type: 'oauth' },
      outboundProfile: 'gemini-chat'
    },
    instance: {
      async initialize() { },
      async cleanup() { },
      processIncoming: processFn
    }
  };
}

describe('HubRequestExecutor failover', () => {
  test('waits for short recoverable cooldown on pool exhaustion before retrying route selection', async () => {
    const providerKey = 'deepseek-web.1.deepseek-chat';
    const handle = buildHandle(providerKey, async () => ({ status: 200, data: { id: 'ok-after-wait' } }));

    const runtimeManager = {
      resolveRuntimeKey: (key: string) => key,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? (runtimeKey === providerKey ? handle : undefined) : undefined)
    };

    const pipeline = {
      execute: jest.fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('All providers unavailable for route default'), {
            code: 'PROVIDER_NOT_AVAILABLE',
            details: {
              routeName: 'default',
              attempted: ['default:default-primary:health'],
              minRecoverableCooldownMs: 120
            }
          })
        )
        .mockResolvedValueOnce({
          requestId: 'req-cooldown-wait',
          providerPayload: {},
          target: {
            providerKey,
            providerType: 'openai',
            outboundProfile: 'openai-chat',
            runtimeKey: providerKey
          },
          routingDecision: { routeName: 'default' },
          metadata: {}
        }),
      updateVirtualRouterConfig: jest.fn()
    };

    const logStage = jest.fn();
    const deps = {
      runtimeManager,
      getHubPipeline: () => pipeline,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => undefined)
        }
      }),
      logStage,
      stats: new StatsManager()
    };

    const executor = createRequestExecutor(deps);
    const startedAt = Date.now();
    const result = await executor.execute({
      requestId: 'req-cooldown-wait',
      entryEndpoint: '/v1/responses',
      body: {},
      headers: {},
      metadata: {}
    });
    const elapsed = Date.now() - startedAt;

    expect(result).toEqual(expect.objectContaining({ status: 200 }));
    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(
      logStage.mock.calls.some(
        (call) => call[0] === 'provider.route_pool_cooldown_wait' && typeof call[2]?.waitMs === 'number'
      )
    ).toBe(true);
  });

  test('retries with alternate provider after recoverable error', async () => {
    const firstProviderKey = 'antigravity.1-geetasamodgeetasamoda.claude-sonnet-4-5-thinking';
    const secondProviderKey = 'antigravity.2-geetasamodgeetasamoda.claude-sonnet-4-5-thinking';
    const failingError = new Error('HTTP 429: quota exhausted');
    (failingError as any).statusCode = 429;

    const failingProcess = jest.fn(async () => {
      throw failingError;
    });
    const failureHandle = buildHandle(firstProviderKey, failingProcess);
    const successPayload = { status: 200, data: { id: 'ok' } };
    const successProcess = jest.fn(async () => successPayload);
    const successHandle = buildHandle(secondProviderKey, successProcess);

    const handles = new Map<string, ProviderHandle>([
      [firstProviderKey, failureHandle],
      [secondProviderKey, successHandle]
    ]);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => {
        const disabled = new Set<string>(
          Array.isArray(input.metadata?.excludedProviderKeys)
            ? input.metadata.excludedProviderKeys
            : []
        );
        const providerKey = disabled.has(firstProviderKey)
          ? secondProviderKey
          : firstProviderKey;
        return {
          requestId: input.id,
          providerPayload: {},
          target: {
            providerKey,
            providerType: 'gemini',
            outboundProfile: 'gemini-chat',
            runtimeKey: providerKey
          },
          routingDecision: { routeName: 'thinking' },
          metadata: {}
        };
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    const deps = {
      runtimeManager,
      getHubPipeline: () => pipeline,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => undefined)
        }
      }),
      logStage: jest.fn(),
      stats: new StatsManager()
    };

    const executor = createRequestExecutor(deps);
    const result = await executor.execute({
      requestId: 'req-retry',
      entryEndpoint: '/v1/responses',
      body: {},
      headers: {},
      metadata: {}
    });

    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    expect(failingProcess).toHaveBeenCalledTimes(1);
    expect(successProcess).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ status: 200 }));
  });

  test('forces longcontext routeHint on prompt-too-long retry', async () => {
    const firstProviderKey = 'tabglm.key1.glm-5';
    const secondProviderKey = 'tabglm.longcontext.glm-5';
    const failingError = new Error(
      "Request input tokens exceeds the model's maximum context length 202752"
    );
    (failingError as any).code = 'SSE_DECODE_ERROR';
    (failingError as any).statusCode = 400;

    const failingProcess = jest.fn(async () => {
      throw failingError;
    });
    const failureHandle = buildHandle(firstProviderKey, failingProcess);
    const successPayload = { status: 200, data: { id: 'ok' } };
    const successProcess = jest.fn(async () => successPayload);
    const successHandle = buildHandle(secondProviderKey, successProcess);

    const handles = new Map<string, ProviderHandle>([
      [firstProviderKey, failureHandle],
      [secondProviderKey, successHandle]
    ]);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const routeHints: Array<string | undefined> = [];
    const pipeline = {
      execute: jest.fn(async (input: any) => {
        routeHints.push(typeof input.metadata?.routeHint === 'string' ? input.metadata.routeHint : undefined);
        const useLongcontext = input.metadata?.routeHint === 'longcontext';
        const providerKey = useLongcontext ? secondProviderKey : firstProviderKey;
        return {
          requestId: input.id,
          providerPayload: {},
          target: {
            providerKey,
            providerType: 'gemini',
            outboundProfile: 'gemini-chat',
            runtimeKey: providerKey
          },
          routingDecision: { routeName: useLongcontext ? 'longcontext' : 'tools' },
          metadata: {}
        };
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    const deps = {
      runtimeManager,
      getHubPipeline: () => pipeline,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => undefined)
        }
      }),
      logStage: jest.fn(),
      stats: new StatsManager()
    };

    const executor = createRequestExecutor(deps);
    const result = await executor.execute({
      requestId: 'req-context-overflow',
      entryEndpoint: '/v1/responses',
      body: {},
      headers: {},
      metadata: {}
    });

    expect(result).toEqual(expect.objectContaining({ status: 200 }));
    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    expect(routeHints[0]).not.toBe('longcontext');
    expect(routeHints[1]).toBe('longcontext');
  });

  test('rotates antigravity alias on 403 OAuth reauth-required error', async () => {
    const firstProviderKey = 'antigravity.alias1.gemini-3-pro-high';
    const secondProviderKey = 'antigravity.alias2.gemini-3-pro-high';
    const failingError = new Error('HTTP 403: Please authenticate with Google OAuth first');
    (failingError as any).statusCode = 403;
    (failingError as any).retryable = false;

    const failingProcess = jest.fn(async () => {
      throw failingError;
    });
    const failureHandle = buildHandle(firstProviderKey, failingProcess);
    const successPayload = { status: 200, data: { id: 'ok' } };
    const successProcess = jest.fn(async () => successPayload);
    const successHandle = buildHandle(secondProviderKey, successProcess);

    const handles = new Map<string, ProviderHandle>([
      [firstProviderKey, failureHandle],
      [secondProviderKey, successHandle]
    ]);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => {
        const disabled = new Set<string>(
          Array.isArray(input.metadata?.excludedProviderKeys)
            ? input.metadata.excludedProviderKeys
            : []
        );
        const providerKey = disabled.has(firstProviderKey)
          ? secondProviderKey
          : firstProviderKey;
        return {
          requestId: input.id,
          providerPayload: {},
          target: {
            providerKey,
            providerType: 'gemini',
            outboundProfile: 'gemini-chat',
            runtimeKey: providerKey
          },
          routingDecision: { routeName: 'default' },
          metadata: {}
        };
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    const deps = {
      runtimeManager,
      getHubPipeline: () => pipeline,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => undefined)
        }
      }),
      logStage: jest.fn(),
      stats: new StatsManager()
    };

    const executor = createRequestExecutor(deps);
    const result = await executor.execute({
      requestId: 'req-403-reauth',
      entryEndpoint: '/v1/responses',
      body: {},
      headers: {},
      metadata: {}
    });

    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    expect(failingProcess).toHaveBeenCalledTimes(1);
    expect(successProcess).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ status: 200 }));
  });
  test('preserves first upstream error when retry-exhausted routing reports provider unavailable', async () => {
    const firstProviderKey = 'iflow.1-186.kimi-k2.5';
    const firstError = Object.assign(new Error('HTTP 429: quota exhausted'), {
      statusCode: 429,
      code: 'HTTP_429'
    });

    const failingProcess = jest.fn(async () => {
      throw firstError;
    });
    const failureHandle = buildHandle(firstProviderKey, failingProcess);

    const handles = new Map<string, ProviderHandle>([[firstProviderKey, failureHandle]]);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const pipeline = {
      execute: jest.fn()
        .mockResolvedValueOnce({
          requestId: 'req-pool-exhausted',
          providerPayload: {},
          target: {
            providerKey: firstProviderKey,
            providerType: 'openai',
            outboundProfile: 'openai-chat',
            runtimeKey: firstProviderKey
          },
          routingDecision: { routeName: 'direct' },
          metadata: {}
        })
        .mockRejectedValueOnce(
          Object.assign(new Error('All providers unavailable for model iflow.kimi-k2.5'), {
            code: 'PROVIDER_NOT_AVAILABLE'
          })
        ),
      updateVirtualRouterConfig: jest.fn()
    };

    const deps = {
      runtimeManager,
      getHubPipeline: () => pipeline,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => undefined)
        }
      }),
      logStage: jest.fn(),
      stats: new StatsManager()
    };

    const executor = createRequestExecutor(deps);

    await expect(executor.execute({
      requestId: 'req-pool-exhausted',
      entryEndpoint: '/v1/chat/completions',
      body: {},
      headers: {},
      metadata: {}
    })).rejects.toMatchObject({
      message: 'HTTP 429: quota exhausted',
      statusCode: 429,
      code: 'HTTP_429'
    });

    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    const secondCallMetadata = pipeline.execute.mock.calls[1][0].metadata as Record<string, unknown>;
    expect(secondCallMetadata.excludedProviderKeys).toEqual([firstProviderKey]);
  });
  test('preserves first upstream error when single-provider pool reroute reports provider unavailable', async () => {
    const firstProviderKey = 'glm.key1.glm-4.7';
    const firstError = Object.assign(new Error('HTTP 429: quota exhausted'), {
      statusCode: 429,
      code: 'HTTP_429'
    });

    const failingProcess = jest.fn(async () => {
      throw firstError;
    });
    const failureHandle = buildHandle(firstProviderKey, failingProcess);

    const handles = new Map<string, ProviderHandle>([[firstProviderKey, failureHandle]]);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const pipeline = {
      execute: jest.fn()
        .mockResolvedValueOnce({
          requestId: 'req-single-pool-unavailable',
          providerPayload: {},
          target: {
            providerKey: firstProviderKey,
            providerType: 'openai',
            outboundProfile: 'openai-chat',
            runtimeKey: firstProviderKey
          },
          routingDecision: { routeName: 'direct', pool: [firstProviderKey] },
          metadata: {}
        })
        .mockRejectedValueOnce(
          Object.assign(new Error('All providers unavailable for model glm.glm-4.7'), {
            code: 'PROVIDER_NOT_AVAILABLE'
          })
        ),
      updateVirtualRouterConfig: jest.fn()
    };

    const deps = {
      runtimeManager,
      getHubPipeline: () => pipeline,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => undefined)
        }
      }),
      logStage: jest.fn(),
      stats: new StatsManager()
    };

    const executor = createRequestExecutor(deps);

    await expect(executor.execute({
      requestId: 'req-single-pool-unavailable',
      entryEndpoint: '/v1/chat/completions',
      body: {},
      headers: {},
      metadata: {}
    })).rejects.toMatchObject({
      message: 'HTTP 429: quota exhausted',
      statusCode: 429,
      code: 'HTTP_429'
    });

    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    const secondCallMetadata = pipeline.execute.mock.calls[1][0].metadata as Record<string, unknown>;
    expect(secondCallMetadata.excludedProviderKeys).toBeUndefined();
  });

  test('retries failover when upstream SSE error event is retryable network failure', async () => {
    const firstProviderKey = 'deepseek-web.primary.deepseek-chat';
    const secondProviderKey = 'deepseek-web.backup.deepseek-chat';

    const failingProcess = jest.fn(async () => ({
      status: 200,
      data: {
        mode: 'sse',
        error: {
          type: 'error',
          error: {
            type: 'api_error',
            message: 'Internal Network Failure'
          }
        }
      }
    }));
    const successProcess = jest.fn(async () => ({ status: 200, data: { id: 'resp_ok' } }));

    const handles = new Map<string, ProviderHandle>([
      [firstProviderKey, buildHandle(firstProviderKey, failingProcess)],
      [secondProviderKey, buildHandle(secondProviderKey, successProcess)]
    ]);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => {
        const disabled = new Set<string>(
          Array.isArray(input.metadata?.excludedProviderKeys)
            ? input.metadata.excludedProviderKeys
            : []
        );
        const providerKey = disabled.has(firstProviderKey)
          ? secondProviderKey
          : firstProviderKey;
        return {
          requestId: input.id,
          providerPayload: {},
          target: {
            providerKey,
            providerType: 'openai',
            outboundProfile: 'openai-chat',
            runtimeKey: providerKey
          },
          routingDecision: { routeName: 'deepseek' },
          metadata: {}
        };
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    const deps = {
      runtimeManager,
      getHubPipeline: () => pipeline,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => undefined)
        }
      }),
      logStage: jest.fn(),
      stats: new StatsManager()
    };

    const executor = createRequestExecutor(deps);
    const result = await executor.execute({
      requestId: 'req-sse-network-retry',
      entryEndpoint: '/v1/messages',
      body: {},
      headers: {},
      metadata: {}
    });

    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    expect(failingProcess).toHaveBeenCalledTimes(1);
    expect(successProcess).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ status: 200 }));
  });

  test('surfaces readable SSE error message when upstream error event is non-retryable', async () => {
    const providerKey = 'deepseek-web.primary.deepseek-chat';

    const failingProcess = jest.fn(async () => ({
      status: 200,
      data: {
        mode: 'sse',
        error: {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'Invalid request payload'
          }
        }
      }
    }));

    const handles = new Map<string, ProviderHandle>([
      [providerKey, buildHandle(providerKey, failingProcess)]
    ]);

    const runtimeManager = {
      resolveRuntimeKey: (key: string) => key,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => ({
        requestId: input.id,
        providerPayload: {},
        target: {
          providerKey,
          providerType: 'openai',
          outboundProfile: 'openai-chat',
          runtimeKey: providerKey
        },
        routingDecision: { routeName: 'deepseek' },
        metadata: {}
      })),
      updateVirtualRouterConfig: jest.fn()
    };

    const deps = {
      runtimeManager,
      getHubPipeline: () => pipeline,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => undefined)
        }
      }),
      logStage: jest.fn(),
      stats: new StatsManager()
    };

    const executor = createRequestExecutor(deps);

    await expect(executor.execute({
      requestId: 'req-sse-readable',
      entryEndpoint: '/v1/messages',
      body: {},
      headers: {},
      metadata: {}
    })).rejects.toMatchObject({
      code: 'SSE_DECODE_ERROR',
      message: expect.stringContaining('Upstream SSE error event [invalid_request_error]: Invalid request payload')
    });

    expect(pipeline.execute).toHaveBeenCalledTimes(1);
    expect(failingProcess).toHaveBeenCalledTimes(1);
  });

});
