import express from 'express';
import { jest } from '@jest/globals';
import type { AddressInfo } from 'node:net';

import { handleChatCompletions } from '../../../src/server/handlers/chat-handler.js';
import { HubRequestExecutor } from '../../../src/server/runtime/http-server/request-executor.js';
import { StatsManager } from '../../../src/server/runtime/http-server/stats-manager.js';

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

describe('chat handler singleton empty pool blocking retry', () => {
  it('does not surface PROVIDER_NOT_AVAILABLE for default-only singleton pool', async () => {
    const providerKey = 'deepseek.key1.deepseek-v4-pro';
    let pipelineCalls = 0;
    const logStages: Array<{ stage: string; details: Record<string, unknown> | undefined }> = [];

    const executor = new HubRequestExecutor({
      runtimeManager: {
        resolveRuntimeKey: () => 'deepseek.key1',
        getHandleByRuntimeKey: (runtimeKey?: string) => runtimeKey === 'deepseek.key1'
          ? {
              runtimeKey: 'deepseek.key1',
              providerId: 'deepseek',
              providerType: 'openai',
              providerFamily: 'openai',
              providerProtocol: 'openai-chat',
              runtime: { runtimeKey: 'deepseek.key1' },
              instance: {
                initialize: async () => undefined,
                cleanup: async () => undefined,
                processIncoming: async () => ({
                  status: 200,
                  data: {
                    id: 'chatcmpl_ok_singleton',
                    object: 'chat.completion',
                    model: 'deepseek-v4-pro',
                    choices: [{ index: 0, message: { role: 'assistant', content: 'ok_after_block' }, finish_reason: 'stop' }]
                  }
                })
              }
            }
          : undefined,
        getHandleByProviderKey: () => undefined,
        disposeAll: async () => undefined,
        initialize: async () => undefined
      },
      getHubPipeline: () => ({
        execute: jest.fn(async (input: any) => {
          pipelineCalls += 1;
          if (pipelineCalls <= 2) {
            throw Object.assign(new Error('No available providers after applying routing instructions'), {
              code: 'PROVIDER_NOT_AVAILABLE',
              details: {
                routeName: 'default',
                candidateProviderCount: 1,
                minRecoverableCooldownMs: 1,
                recoverableCooldownHints: [
                  { providerKey, waitMs: 1, source: 'provider.error' }
                ]
              }
            });
          }
          return {
            requestId: input.requestId,
            providerPayload: {},
            target: {
              providerKey,
              providerType: 'openai',
              outboundProfile: 'openai-chat',
              runtimeKey: 'deepseek.key1'
            },
            routingDecision: { routeName: 'default', pool: [providerKey], providerProtocol: 'openai-chat' },
            metadata: {}
          };
        }),
        updateVirtualRouterConfig: jest.fn()
      }) as any,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: async () => undefined
        }
      }),
      logStage: (stage: string, _requestId: string, details?: Record<string, unknown>) => {
        logStages.push({ stage, details });
      },
      stats: new StatsManager()
    } as any);

    const app = express();
    app.use(express.json());
    app.post('/v1/chat/completions', (req, res) =>
      void handleChatCompletions(req as any, res as any, {
        executePipeline: async (input) => executor.execute(input),
        errorHandling: null
      })
    );

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-v4-pro',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false
        })
      });
      const body = await response.json();

      if (response.status !== 200) {
        throw new Error(`chat-singleton-empty-pool unexpected status=${response.status} pipelineCalls=${pipelineCalls} body=${JSON.stringify(body)} logs=${JSON.stringify(logStages)}`);
      }
      expect(body.choices?.[0]?.message?.content).toBe('ok_after_block');
      expect(pipelineCalls).toBe(3);
      expect(logStages.filter((entry) => entry.stage === 'provider.route_pool_cooldown_wait')).toHaveLength(2);
      expect(logStages.filter((entry) => entry.stage === 'provider.route_pool_cooldown_wait.completed')).toHaveLength(2);
      expect(body.error?.code).not.toBe('PROVIDER_NOT_AVAILABLE');
    });
  });
});
