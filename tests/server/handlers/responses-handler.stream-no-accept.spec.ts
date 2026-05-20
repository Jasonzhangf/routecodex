import { describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { handleResponses } from '../../../src/server/handlers/responses-handler.js';

describe('responses-handler stream compatibility without SSE accept header', () => {
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

  it('keeps stream=true request on SSE path even when client does not advertise Accept: text/event-stream', async () => {
    const executePipeline = jest.fn(async (input: any) => ({
      status: 200,
      headers: {},
      body: {
        __sse_responses: Readable.from([
          'event: response.output_text.delta\n',
          `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'stream-no-accept-ok' })}\n\n`,
          'event: response.completed\n',
          `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_stream_no_accept', object: 'response', status: 'completed' } })}\n\n`,
          'data: [DONE]\n\n'
        ])
      }
    }));

    const app = express();
    app.use(express.json());
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline,
        errorHandling: null
      });
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-5.4-medium',
          stream: true,
          input: '继续执行'
        })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(text).toContain('event: response.output_text.delta');
      expect(text).toContain('stream-no-accept-ok');
      expect(text).toContain('event: response.completed');
      expect(text).toContain('[DONE]');

      expect(executePipeline).toHaveBeenCalledTimes(1);
      const pipelineInput = executePipeline.mock.calls[0]?.[0] as Record<string, any>;
      expect(pipelineInput.entryEndpoint).toBe('/v1/responses');
      expect(pipelineInput.metadata?.stream).toBe(true);
      expect(pipelineInput.metadata?.inboundStream).toBe(true);
      expect(pipelineInput.metadata?.outboundStream).toBe(true);
      expect(pipelineInput.metadata?.clientStream).toBeUndefined();
      expect(pipelineInput.body?.stream).toBe(true);
    });
  });
});
