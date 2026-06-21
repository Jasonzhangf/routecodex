import { describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { handleResponses } from '../../../src/server/handlers/responses-handler.js';
import { runServerToolOrchestration } from '../../../sharedmodule/llmswitch-core/src/servertool/engine.js';

async function listenApp(app: express.Express): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server?: http.Server): Promise<void> {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function fetchJson(
  baseUrl: string,
  routePath: string,
  body: unknown
): Promise<{ status: number; payload: unknown; text: string }> {
  const response = await fetch(`${baseUrl}${routePath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return {
    status: response.status,
    payload: text ? JSON.parse(text) : null,
    text
  };
}

describe('responses HTTP servertool backend-route dual-port blackbox', () => {
  it('closes client in -> provider out -> provider in -> client out through web_search backend route', async () => {
    const providerOutPayloads: unknown[] = [];
    const providerInPayloads: unknown[] = [];
    const reenterPayloads: unknown[] = [];
    const previousServerSideTools = process.env.ROUTECODEX_SERVER_SIDE_TOOLS;
    process.env.ROUTECODEX_SERVER_SIDE_TOOLS = 'web_search';
    const executePipeline = jest.fn(async (input: any) => {
      const orchestration = await runServerToolOrchestration({
        chat: {
          id: 'chatcmpl_backend_route_blackbox',
          object: 'chat.completion',
          model: 'gpt-test',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call_backend_route_web_search_1',
                    type: 'function',
                    function: {
                      name: 'web_search',
                      arguments: JSON.stringify({ query: 'routecodex backend route blackbox' })
                    }
                  }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ]
        },
        adapterContext: {
          ...(input?.metadata ?? {}),
          requestId: 'req_backend_route_blackbox',
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-chat',
          sessionId: 'sess-backend-route-blackbox',
          conversationId: 'conv-backend-route-blackbox',
          webSearch: {
            engines: [
              {
                id: 'backend-route-web-search',
                providerKey: 'gemini-cli.gemini-2.5-flash-lite',
                default: true
              }
            ],
            injectPolicy: 'always',
            force: true
          },
          __rt: {
            ...(input?.metadata?.__rt ?? {}),
            webSearch: {
              engines: [
                {
                  id: 'backend-route-web-search',
                  providerKey: 'gemini-cli.gemini-2.5-flash-lite',
                  default: true
                }
              ],
              injectPolicy: 'always',
              force: true
            }
          },
          capturedChatRequest: input?.body
        } as any,
        requestId: 'req_backend_route_blackbox',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-chat',
        providerInvoker: async (options) => {
          providerOutPayloads.push(options.payload);
          const backendResponse = {
            id: 'resp_backend_route_provider_1',
            model: 'backend.search',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'backend search result'
                },
                finish_reason: 'stop'
              }
            ]
          };
          providerInPayloads.push(backendResponse);
          return { providerResponse: backendResponse as any };
        },
        reenterPipeline: async (options) => {
          reenterPayloads.push(options);
          return {
            body: {
              id: 'resp_backend_route_final_1',
              object: 'response',
              status: 'completed',
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'final answer after backend route web_search' }]
                }
              ]
            }
          };
        }
      });

      return {
        status: 200,
        body: orchestration.chat
      };
    });

    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.post('/v1/responses', (req, res) => {
      void handleResponses(req as any, res as any, {
        executePipeline,
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);
    try {
      const result = await fetchJson(baseUrl, '/v1/responses', {
        model: 'gpt-test',
        stream: false,
        metadata: {
          session_id: 'sess-backend-route-blackbox',
          conversation_id: 'conv-backend-route-blackbox'
        },
        messages: [
          {
            role: 'user',
            content: 'use backend route web search'
          }
        ],
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'use backend route web search' }]
          }
        ]
      });

      expect(result.status).toBe(200);
      expect(String(result.text)).toContain('final answer after backend route web_search');
      expect(result.payload).toMatchObject({
        object: 'response',
        status: 'completed'
      });
      expect(JSON.stringify(result.payload ?? {})).toContain('final answer after backend route web_search');
      expect(executePipeline).toHaveBeenCalledTimes(1);
      expect(providerOutPayloads).toHaveLength(1);
      expect(providerInPayloads).toHaveLength(1);
      expect(reenterPayloads).toHaveLength(1);

      const providerOutText = JSON.stringify(providerOutPayloads[0]);
      expect(providerOutText).toContain('routecodex backend route blackbox');
      expect(providerOutText).not.toContain('__rt');
      expect(providerOutText).not.toContain('runtime_control');
      expect(JSON.stringify(providerInPayloads[0] ?? {})).toContain('backend search result');

      const reenterPayload = reenterPayloads[0] as any;
      expect(reenterPayload?.metadata?.serverToolFollowup ?? reenterPayload?.metadata?.__rt?.serverToolFollowup).toBe(true);
      expect(reenterPayload?.metadata?.stream).toBe(false);
      expect(JSON.stringify(reenterPayload?.body ?? {})).toContain('tool');
      expect(JSON.stringify(reenterPayload?.body ?? {})).toContain('call_backend_route_web_search_1');
      expect(JSON.stringify(reenterPayload?.body ?? {})).toContain('web_search completed but returned no textual summary');
    } finally {
      if (previousServerSideTools === undefined) {
        delete process.env.ROUTECODEX_SERVER_SIDE_TOOLS;
      } else {
        process.env.ROUTECODEX_SERVER_SIDE_TOOLS = previousServerSideTools;
      }
      await closeServer(server);
    }
  });
});
