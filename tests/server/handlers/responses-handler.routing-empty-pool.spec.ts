import express from 'express';
import type { AddressInfo } from 'node:net';

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

describe('responses handler virtual-router empty-pool guard', () => {
  it('keeps the route pool non-empty when retry exclusions cover every default target', async () => {
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

        expect(response.status).toBe(200);
        expect(body).toMatchObject({
          selected_provider_key: 'primary.key1.gpt-test',
          route_name: 'default'
        });
        expect(body.error).toBeUndefined();
      });
    } finally {
      pipeline.dispose();
    }
  });

  it('blocks and retries recoverable busy three times before returning 429', async () => {
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

        expect(response.status).toBe(429);
        expect(body.error?.code).toBe('HTTP_429');
        expect(body.error?.message).toContain('temporarily busy');
        expect(body.error?.code).not.toBe('PROVIDER_NOT_AVAILABLE');
        const waits = logStages.filter((entry) => entry.stage === 'provider.route_pool_cooldown_wait');
        expect(waits).toHaveLength(3);
        expect(waits.map((entry) => entry.details.retry)).toEqual([1, 2, 3]);
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
