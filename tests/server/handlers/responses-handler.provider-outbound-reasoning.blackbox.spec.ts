import { describe, expect, it } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

import { handleResponses } from '../../../src/server/handlers/responses-handler.js';
import { bootstrapVirtualRouterConfig } from '../../sharedmodule/helpers/virtual-router-bootstrap-direct-native.js';
import { NativeHubPipelineTestWrapper as HubPipeline } from '../../helpers/native-hub-pipeline-test-wrapper.js';

async function listenApp(app: express.Express): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server?: http.Server): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function hasReasoningContent(payload: unknown): boolean {
  const input = (payload as any)?.input;
  if (!Array.isArray(input)) return false;
  return input.some((item) => item?.type === 'reasoning' && Array.isArray(item?.content) && item.content.length > 0);
}

describe('responses HTTP provider outbound reasoning filter blackbox', () => {
  it('does not leak reasoning.content to non-DeepSeek Responses provider on streamed request', async () => {
    const artifacts = await bootstrapVirtualRouterConfig({
      providers: {
        cc: {
          id: 'cc',
          enabled: true,
          type: 'responses',
          baseURL: 'mock://cc',
          auth: { type: 'apikey', apiKey: 'mock' },
          models: { 'gpt-5.5': {} }
        }
      },
      routing: {
        responses: [{ id: 'responses-cc', targets: ['cc.gpt-5.5'] }]
      }
    } as any) as any;
    const pipeline = new HubPipeline({
      virtualRouter: artifacts.config,
      policy: { mode: 'off' }
    });

    let capturedProviderPayload: unknown;
    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline: async (input: any) => {
          const result = await pipeline.execute({
            id: 'req_http_reasoning_filter',
            endpoint: '/v1/responses',
            payload: input.body,
            metadataCenterSnapshot: {
              runtimeControl: {
                entryEndpoint: '/v1/responses',
                providerProtocol: 'openai-responses',
                routeHint: 'responses'
              }
            },
            metadata: {
              ...input.metadata,
              entryEndpoint: '/v1/responses',
              providerProtocol: 'openai-responses',
              routeHint: 'responses',
              stream: true,
              inboundStream: true,
              outboundStream: true,
            }
          });
          capturedProviderPayload = result.providerPayload;
          if (hasReasoningContent(result.providerPayload)) {
            return {
              status: 400,
              headers: {},
              body: {
                error: {
                  message: "Invalid 'input[0].content': array too long. Expected an array with maximum length 0, but got an array with length 1 instead.",
                  type: 'invalid_request_error',
                  param: 'input[0].content',
                  code: 'array_above_max_length'
                }
              }
            };
          }
          return {
            status: 200,
            headers: {},
            metadata: { outboundStream: true, stream: true },
            sseStream: Readable.from([
              'event: response.completed\n',
              'data: {"type":"response.completed","response":{"id":"resp_http_reasoning_filter","object":"response","status":"completed","model":"gpt-5.5","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}}\n\n',
              'event: response.done\n',
              'data: {"type":"response.done","response":{"id":"resp_http_reasoning_filter","object":"response","status":"completed"}}\n\n'
            ])
          };
        },
        errorHandling: null,
      });
    });

    const { server, baseUrl } = await listenApp(app);
    try {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          stream: true,
          input: [
            {
              type: 'reasoning',
              content: [{ type: 'reasoning_text', text: 'must not reach provider' }]
            },
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }
          ]
        })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('resp_http_reasoning_filter');
      expect(JSON.stringify(capturedProviderPayload)).not.toContain('must not reach provider');
      expect(hasReasoningContent(capturedProviderPayload)).toBe(false);
    } finally {
      await closeServer(server);
      pipeline.dispose?.();
    }
  });
});
