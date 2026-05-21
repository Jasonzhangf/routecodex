import { describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { handleResponses } from '../../../src/server/handlers/responses-handler.js';

describe('responses-handler accept header vs client stream contract', () => {
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

  it('does not upgrade stream=false responses request into client-visible SSE only because Accept advertises SSE', async () => {
    const executePipeline = jest.fn(async (input: any) => ({
      status: 200,
      headers: {
        'x-upstream-mode': 'sse',
        'x-provider-stream-requested': '1'
      },
      body: {
        __sse_responses: Readable.from([
          'event: response.output_text.delta\n',
          `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'OK' })}\n\n`,
          'event: response.completed\n',
          `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_accept_only', object: 'response', status: 'completed', model: 'gpt-5.4-medium' } })}\n\n`,
          'data: [DONE]\n\n'
        ]),
        id: 'resp_accept_only',
        object: 'response',
        status: 'completed',
        output: [{ type: 'output_text', text: 'OK' }]
      }
    }));

    const app = express();
    app.use(express.json());
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, { executePipeline, errorHandling: null });
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'text/event-stream'
        },
        body: JSON.stringify({
          model: 'gpt-5.3-codex',
          stream: false,
          input: 'Reply with OK only.'
        })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type') || '').not.toContain('text/event-stream');
      expect(() => JSON.parse(text)).not.toThrow();

      const pipelineInput = executePipeline.mock.calls[0]?.[0] as Record<string, any>;
      expect(pipelineInput.body?.stream).toBe(false);
      expect(pipelineInput.metadata?.outboundStream).toBe(false);
      expect(pipelineInput.metadata?.clientStream).toBe(true);
    });
  });
});
