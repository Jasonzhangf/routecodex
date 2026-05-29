import { describe, expect, it, jest } from '@jest/globals';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { executeRouterDirectPipeline } from '../../../../src/server/runtime/http-server/router-direct-pipeline.js';
import type { ProviderHandle } from '../../../../src/server/runtime/http-server/types.js';

async function closeServer(server?: http.Server): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

describe('router-direct chat model HTTP blackbox', () => {
  it('sends selected provider model instead of inbound chat model', async () => {
    let server: http.Server | undefined;
    let sentPayload: Record<string, unknown> | undefined;
    const runtimeKey = 'runtime:opencode-deepseek-free';
    const providerHandle: ProviderHandle = {
      runtimeKey,
      providerId: 'opencode-zen-free',
      providerType: 'openai',
      providerFamily: 'openai',
      providerProtocol: 'openai-chat',
      runtime: { runtimeKey, providerId: 'opencode-zen-free', providerType: 'openai' as any, endpoint: '', auth: { type: 'none' } as any, defaultModel: 'deepseek-v4-flash-free' },
      instance: {
        initialize: async () => {},
        cleanup: async () => {},
        processIncoming: jest.fn(),
        processIncomingDirect: jest.fn(async (payload: Record<string, unknown>) => {
          sentPayload = payload;
          return {
            status: 200,
            data: {
              id: 'chatcmpl_direct_model_blackbox',
              object: 'chat.completion',
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            },
          };
        }),
      },
    };

    server = http.createServer(async (req, res) => {
      try {
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
          res.writeHead(404).end();
          return;
        }
        const requestPayload = await readJson(req);
        const result = await executeRouterDirectPipeline({
          portConfig: {
            port: 0,
            host: '127.0.0.1',
            mode: 'router',
            routingPolicyGroup: 'gateway_priority_5555',
            sameProtocolBehavior: 'direct',
          },
          providerPayload: {
            model: 'deepseek-v4-flash-free',
            messages: requestPayload.messages,
          },
          requestPayload,
          target: {
            providerKey: 'opencode-zen-free.key1.deepseek-v4-flash-free',
            providerType: 'openai',
            runtimeKey,
            processMode: 'chat',
          },
          routingDecision: { routeName: 'thinking', pool: ['opencode-zen-free.key1.deepseek-v4-flash-free'] },
          processMode: 'chat',
          requestInfo: { path: '/v1/chat/completions', headers: req.headers as Record<string, string | string[] | undefined> },
          resolveProviderByRuntimeKey: (key?: string) => key === runtimeKey ? providerHandle : undefined,
        });
        if (!result.used) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: result.reason }));
          return;
        }
        const upstream = result.response as { status?: number; data?: unknown; body?: unknown };
        res.writeHead(upstream.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(upstream.data ?? upstream.body ?? {}));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.id).toBe('chatcmpl_direct_model_blackbox');
      expect(sentPayload?.model).toBe('deepseek-v4-flash-free');
    } finally {
      await closeServer(server);
    }
  });
});
