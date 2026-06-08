import { describe, expect, it } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';

import { sendPipelineResponse } from '../../../src/server/handlers/handler-response-utils.js';

async function withServer<T>(app: express.Express, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function findSseDataByType(text: string, type: string): Record<string, unknown> | undefined {
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const raw = line.slice('data: '.length);
    if (raw === '[DONE]') continue;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.type === type) return parsed;
  }
  return undefined;
}

describe('responses-handler stream closed before completed regression', () => {
  it('repairs terminal Responses SSE frames with a response id when upstream emits output item then closes', async () => {
    const app = express();
    app.get('/v1/responses', async (_req, res) => {
      const upstream = new PassThrough();
      setTimeout(() => {
        upstream.write('event: response.output_item.done\n');
        upstream.write(
          `data: ${JSON.stringify({
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'msg_terminal_probe_1',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'OK' }]
            }
          })}\n\n`
        );
        upstream.end();
      }, 10);

      await sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          body: {
            __sse_responses: upstream
          },
          metadata: {
            outboundStream: true,
            stream: true
          }
        } as any,
        'req_repair_terminal_probe',
        { entryEndpoint: '/v1/responses' }
      );
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        headers: {
          accept: 'text/event-stream'
        }
      });
      const text = await response.text();
      const completedEvent = findSseDataByType(text, 'response.completed');
      const doneEvent = findSseDataByType(text, 'response.done');

      expect(response.status).toBe(200);
      expect(text).toContain('event: response.output_item.done');
      expect(text).toContain('event: response.completed');
      expect(text).toContain('event: response.done');
      expect(text).toContain('data: [DONE]');
      expect(completedEvent?.response).toEqual(expect.objectContaining({ id: expect.any(String) }));
      expect(doneEvent?.response).toEqual(expect.objectContaining({ id: expect.any(String) }));
    });
  });

  it('surfaces started-stream failure as explicit SSE error when upstream closes before response.completed', async () => {
    const app = express();
    app.get('/v1/responses', async (_req, res) => {
      const upstream = new PassThrough();
      setTimeout(() => {
        upstream.write('event: response.created\n');
        upstream.write(
          `data: ${JSON.stringify({
            type: 'response.created',
            response: {
              id: 'resp_stream_closed_1',
              object: 'response',
              status: 'in_progress',
              model: 'gpt-5.3-codex',
              output: []
            }
          })}\n\n`
        );
        upstream.write('event: response.output_text.delta\n');
        upstream.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' })}\n\n`);
        upstream.end();
      }, 10);

      await sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          body: {
            __sse_responses: upstream
          },
          metadata: {
            outboundStream: true,
            stream: true
          }
        } as any,
        'req_stream_closed_started',
        { entryEndpoint: '/v1/responses' }
      );
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        headers: {
          accept: 'text/event-stream'
        }
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('response.created');
      expect(text).toContain('partial');
      expect(text).not.toContain('event: response.completed');
      expect(text).toContain('event: error');
      expect(text).toContain('"code":"upstream_stream_incomplete"');
      expect(text).toContain('stream closed before response.completed');
    });
  });

  it('treats upstream response.failed as terminal and does not append stream-incomplete error', async () => {
    const app = express();
    app.get('/v1/responses', async (_req, res) => {
      const upstream = new PassThrough();
      setTimeout(() => {
        upstream.write('event: response.failed\n');
        upstream.write(
          `data: ${JSON.stringify({
            type: 'response.failed',
            response: {
              id: 'resp_failed_terminal_1',
              object: 'response',
              status: 'failed',
              error: {
                code: 'rate_limit_error',
                message: 'Concurrency limit exceeded for user, please retry later'
              }
            }
          })}\n\n`
        );
        upstream.end();
      }, 10);

      await sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          body: {
            __sse_responses: upstream
          },
          metadata: {
            outboundStream: true,
            stream: true
          }
        } as any,
        'req_response_failed_terminal',
        { entryEndpoint: '/v1/responses' }
      );
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        headers: {
          accept: 'text/event-stream'
        }
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('event: response.failed');
      expect(text).toContain('rate_limit_error');
      expect(text).not.toContain('upstream_stream_incomplete');
      expect(text).not.toContain('stream closed before response.completed');
    });
  });
});
