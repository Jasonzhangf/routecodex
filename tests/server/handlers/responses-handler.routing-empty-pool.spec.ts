import express from 'express';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

import { handleResponses } from '../../../src/server/handlers/responses-handler.js';
import { HubRequestExecutor } from '../../../src/server/runtime/http-server/request-executor.js';
import { StatsManager } from '../../../src/server/runtime/http-server/stats-manager.js';
import { bootstrapVirtualRouterConfig, getHubPipelineCtor } from '../../../src/modules/llmswitch/bridge.js';

type HubPipelineCtor = new (config: any) => {
  execute: (request: any) => Promise<any>;
  getVirtualRouter: () => {
    markConcurrencyScopeBusy: (scopeKey: string) => void;
  };
  dispose: () => void;
};

async function withServer<T>(app: express.Express, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function buildVirtualRouterConfig() {
  return {
    providers: {
      primary: {
        id: 'primary',
        enabled: true,
        type: 'responses',
        baseURL: 'mock://primary',
        auth: { type: 'apikey', apiKey: 'primary-key' },
        models: { 'gpt-test': {} }
      },
      secondary: {
        id: 'secondary',
        enabled: true,
        type: 'responses',
        baseURL: 'mock://secondary',
        auth: { type: 'apikey', apiKey: 'secondary-key' },
        models: { 'gpt-test': {} }
      }
    },
    routing: {
      default: [
        {
          id: 'default-priority',
          mode: 'priority',
          targets: ['primary.gpt-test', 'secondary.gpt-test']
        }
      ]
    }
  };
}

function buildAnthropicVirtualRouterConfig() {
  return {
    providers: {
      mimo: {
        id: 'mimo',
        enabled: true,
        type: 'anthropic',
        baseURL: 'mock://mimo',
        auth: { type: 'apikey', apiKey: 'mimo-key' },
        models: { 'mimo-v2.5': {} }
      }
    },
    routing: {
      tools: [
        {
          id: 'tools-priority',
          mode: 'priority',
          targets: ['mimo.mimo-v2.5']
        }
      ],
      default: [
        {
          id: 'default-priority',
          mode: 'priority',
          targets: ['mimo.mimo-v2.5']
        }
      ]
    }
  };
}

describe('responses handler virtual-router empty-pool guard', () => {
  it('retries HTTP /v1/responses when provider SSE stream terminates during bridge materialization', async () => {
    const HubPipeline = (await getHubPipelineCtor()) as unknown as HubPipelineCtor;
    const artifacts = (await bootstrapVirtualRouterConfig(buildVirtualRouterConfig() as any)) as any;
    const pipeline = new HubPipeline({ virtualRouter: artifacts.config });
    const providerCalls: string[] = [];
    const createTerminatingStream = () => new Readable({
      read() {
        this.push('data: {"id":"chatcmpl_red","object":"chat.completion.chunk","model":"gpt-test","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n');
        this.destroy(new Error('terminated'));
      }
    });

    const runtimeManager = {
      resolveRuntimeKey: (providerKey?: string) => artifacts.targetRuntime?.[providerKey ?? '']?.runtimeKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => {
        if (runtimeKey === 'primary.key1') {
          return {
            runtimeKey: 'primary.key1',
            providerId: 'primary',
            providerType: 'openai',
            providerFamily: 'openai',
            providerProtocol: 'openai-chat',
            runtime: { runtimeKey: 'primary.key1' },
            instance: {
              initialize: async () => undefined,
              cleanup: async () => undefined,
              processIncoming: async () => {
                providerCalls.push('primary');
                return { status: 200, data: { mode: 'sse', __sse_responses: createTerminatingStream() } };
              }
            }
          };
        }
        if (runtimeKey === 'secondary.key1') {
          return {
            runtimeKey: 'secondary.key1',
            providerId: 'secondary',
            providerType: 'openai',
            providerFamily: 'openai',
            providerProtocol: 'openai-chat',
            runtime: { runtimeKey: 'secondary.key1' },
            instance: {
              initialize: async () => undefined,
              cleanup: async () => undefined,
              processIncoming: async () => {
                providerCalls.push('secondary');
                return {
                  status: 200,
                  data: {
                    id: 'chatcmpl_ok',
                    object: 'chat.completion',
                    model: 'gpt-test',
                    choices: [{ index: 0, message: { role: 'assistant', content: 'ok_from_secondary' }, finish_reason: 'stop' }]
                  }
                };
              }
            }
          };
        }
        return undefined;
      },
      getHandleByProviderKey: () => undefined,
      disposeAll: async () => undefined,
      initialize: async () => undefined
    };
    const executor = new HubRequestExecutor({
      runtimeManager,
      getHubPipeline: () => pipeline as any,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: async () => undefined
        }
      }),
      logStage: () => undefined,
      stats: new StatsManager()
    } as any);
    const app = express();
    app.use(express.json());
    app.post('/v1/responses', (req, res) =>
      handleResponses(req, res, {
        executePipeline: async (input) => executor.execute(input),
        errorHandling: null
      })
    );

    const previousAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    const previousBase = process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS;
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '4';
    process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS = '1';
    try {
      await withServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/responses`, {
          method: 'POST',
          headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-test', stream: true, input: 'hi' })
        });
        const text = await response.text();
        expect(response.status).toBe(200);
        expect(text).toContain('ok_from_secondary');
        expect(providerCalls).toEqual(['primary', 'secondary']);
      });
    } finally {
      pipeline.dispose();
      if (previousAttempts === undefined) delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      else process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = previousAttempts;
      if (previousBase === undefined) delete process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS;
      else process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS = previousBase;
    }
  });

  it('rejects unsupported client stopMessage metadata at /v1/responses boundary', async () => {
    const HubPipeline = (await getHubPipelineCtor()) as unknown as HubPipelineCtor;
    const artifacts = (await bootstrapVirtualRouterConfig(buildAnthropicVirtualRouterConfig() as any)) as any;
    const pipeline = new HubPipeline({ virtualRouter: artifacts.config });
    const providerPayloads: Array<Record<string, unknown>> = [];
    const executor = new HubRequestExecutor({
      runtimeManager: {
        resolveRuntimeKey: (providerKey?: string) => artifacts.targetRuntime?.[providerKey ?? '']?.runtimeKey,
        getHandleByRuntimeKey: (runtimeKey?: string) => runtimeKey === 'mimo.key1'
          ? {
              runtimeKey: 'mimo.key1',
              providerId: 'mimo',
              providerType: 'anthropic',
              providerFamily: 'anthropic',
              providerProtocol: 'anthropic-messages',
              runtime: { runtimeKey: 'mimo.key1' },
              instance: {
                initialize: async () => undefined,
                cleanup: async () => undefined,
                processIncoming: async (payload: Record<string, unknown>) => {
                  providerPayloads.push(payload);
                  return {
                    status: 200,
                    data: {
                      id: 'msg_test_1',
                      type: 'message',
                      role: 'assistant',
                      model: 'mimo-v2.5',
                      content: [{ type: 'text', text: 'ok' }],
                      stop_reason: 'end_turn'
                    }
                  };
                }
              }
            }
          : undefined,
        getHandleByProviderKey: () => undefined,
        disposeAll: async () => undefined,
        initialize: async () => undefined
      },
      getHubPipeline: () => pipeline as any,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: async () => undefined
        }
      }),
      logStage: () => undefined,
      stats: new StatsManager()
    } as any);
    const app = express();
    app.use(express.json());
    app.post('/v1/responses', (req, res) =>
      handleResponses(req, res, {
        executePipeline: async (input) => executor.execute(input),
        errorHandling: null
      })
    );

    try {
      await withServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/responses`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'mimo-v2.5',
            input: [
              {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'read files' }]
              }
            ],
            tools: [
              {
                type: 'function',
                name: 'exec_command',
                parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }
              }
            ],
            tool_choice: 'auto',
            metadata: { stopMessageEnabled: false }
          })
        });
        const body = await response.json();

        expect(response.status).toBe(502);
        expect(body.error?.message).toBe('Upstream provider error');
        expect(body.error?.code).toBeDefined();
        expect(providerPayloads).toHaveLength(0);
      });
    } finally {
      pipeline.dispose();
    }
  });

  it('rejects unsupported client excludedProviderKeys metadata at /v1/responses boundary', async () => {
    const HubPipeline = (await getHubPipelineCtor()) as unknown as HubPipelineCtor;
    const artifacts = (await bootstrapVirtualRouterConfig(buildVirtualRouterConfig() as any)) as any;
    const pipeline = new HubPipeline({ virtualRouter: artifacts.config });
    const app = express();
    app.use(express.json());
    app.post('/v1/responses', (req, res) =>
      handleResponses(req, res, {
        executePipeline: async (input) => {
          const result = await pipeline.execute({
            id: input.requestId,
            endpoint: input.entryEndpoint,
            payload: input.body as Record<string, unknown>,
            metadata: input.metadata
          });
          return {
            status: 200,
            body: {
              selected_provider_key: result.target?.providerKey,
              route_name: result.routingDecision?.routeName
            },
            metadata: result.metadata
          };
        },
        errorHandling: null
      })
    );

    try {
      await withServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/responses`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-test',
            input: 'hi',
            metadata: {
              excludedProviderKeys: ['primary.key1.gpt-test', 'secondary.key1.gpt-test']
            }
          })
        });
        const body = await response.json();

        expect(response.status).toBe(502);
        expect(body.error?.message).toBe('Upstream provider error');
        expect(body.error?.code).toBeDefined();
      });
    } finally {
      pipeline.dispose();
    }
  });

  it('keeps default route non-empty under busy marks and surfaces downstream runtime resolution failure instead of empty-pool', async () => {
    const HubPipeline = (await getHubPipelineCtor()) as unknown as HubPipelineCtor;
    const artifacts = (await bootstrapVirtualRouterConfig(buildVirtualRouterConfig() as any)) as any;
    const pipeline = new HubPipeline({ virtualRouter: artifacts.config });
    pipeline.getVirtualRouter().markConcurrencyScopeBusy('primary.key1.gpt-test');
    pipeline.getVirtualRouter().markConcurrencyScopeBusy('secondary.key1.gpt-test');
    const logStages: Array<{ stage: string; details: Record<string, unknown> }> = [];
    const executor = new HubRequestExecutor({
      runtimeManager: {
        resolveRuntimeKey: () => undefined,
        getHandleByRuntimeKey: () => undefined,
        getHandleByProviderKey: () => undefined,
        disposeAll: async () => undefined,
        initialize: async () => undefined
      },
      getHubPipeline: () => pipeline as any,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: async () => undefined
        }
      }),
      logStage: (stage: string, _requestId: string, details: Record<string, unknown>) => {
        logStages.push({ stage, details });
      },
      stats: new StatsManager()
    } as any);
    const app = express();
    app.use(express.json());
    app.post('/v1/responses', (req, res) =>
      handleResponses(req, res, {
        executePipeline: async (input) => executor.execute(input),
        errorHandling: null
      })
    );

    const previousBackoffBase = process.env.RCC_429_BACKOFF_BASE_MS;
    const previousBackoffMax = process.env.RCC_429_BACKOFF_MAX_MS;
    process.env.RCC_429_BACKOFF_BASE_MS = '1';
    process.env.RCC_429_BACKOFF_MAX_MS = '8';
    try {
      await withServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/responses`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-test',
            input: 'hi'
          })
        });
        const body = await response.json();

        expect(response.status).toBe(502);
        expect(body.error?.message).toBe('Upstream provider error');
        expect(body.error?.code).not.toBe('PROVIDER_NOT_AVAILABLE');
        expect(logStages.some((entry) => entry.stage === 'provider.route_pool_cooldown_wait')).toBe(false);
      });
    } finally {
      if (previousBackoffBase === undefined) delete process.env.RCC_429_BACKOFF_BASE_MS;
      else process.env.RCC_429_BACKOFF_BASE_MS = previousBackoffBase;
      if (previousBackoffMax === undefined) delete process.env.RCC_429_BACKOFF_MAX_MS;
      else process.env.RCC_429_BACKOFF_MAX_MS = previousBackoffMax;
      pipeline.dispose();
    }
  });
});
