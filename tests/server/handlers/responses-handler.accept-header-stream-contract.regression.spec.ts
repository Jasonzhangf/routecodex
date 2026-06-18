import { describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { handleResponses } from '../../../src/server/handlers/responses-handler.js';
import { MetadataCenter } from '../../../src/server/runtime/http-server/metadata-center/metadata-center.js';

function readStreamIntent(metadata: Record<string, unknown> | undefined): string | undefined {
  return MetadataCenter.read(metadata)?.readRuntimeControl().streamIntent;
}

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

  function createApp(executePipeline: ReturnType<typeof jest.fn>): express.Express {
    const app = express();
    app.use(express.json());
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, { executePipeline, errorHandling: null });
    });
    return app;
  }

  it('defaults an SSE-capable responses request to client-visible SSE when stream is omitted', async () => {
    const executePipeline = jest.fn(async (input: any) => ({
      status: 200,
      headers: {
        'x-upstream-mode': 'sse',
        'x-provider-stream-requested': '1'
      },
      sseStream: Readable.from([
        'event: response.output_text.delta\n',
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'OK' })}\n\n`,
        'event: response.completed\n',
        `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_accept_only', object: 'response', status: 'completed', model: 'gpt-5.4-medium' } })}\n\n`
      ]),
      id: 'resp_accept_only',
      object: 'response',
      status: 'completed',
      output: [{ type: 'output_text', text: 'OK' }]
    }));

    await withServer(createApp(executePipeline), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'text/event-stream'
        },
        body: JSON.stringify({
          model: 'gpt-5.3-codex',
          input: 'Reply with OK only.'
        })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type') || '').toContain('text/event-stream');
      expect(text).toContain('event: response.completed');

      const pipelineInput = executePipeline.mock.calls[0]?.[0] as Record<string, any>;
      expect(pipelineInput.body?.stream).toBe(true);
      expect(readStreamIntent(pipelineInput.metadata)).toBe('stream');
      expect(pipelineInput.metadata?.stream).toBeUndefined();
      expect(pipelineInput.metadata?.outboundStream).toBeUndefined();
      expect(pipelineInput.metadata?.clientStream).toBe(true);
    });
  });

  it('does not upgrade explicit stream=false responses request only because Accept advertises SSE', async () => {
    const executePipeline = jest.fn(async (input: any) => ({
      status: 200,
      headers: {
        'x-upstream-mode': 'sse',
        'x-provider-stream-requested': '1'
      },
      sseStream: Readable.from([
        'event: response.output_text.delta\n',
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'OK' })}\n\n`,
        'event: response.completed\n',
        `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_accept_only', object: 'response', status: 'completed', model: 'gpt-5.4-medium' } })}\n\n`
      ]),
      id: 'resp_accept_only',
      object: 'response',
      status: 'completed',
      output: [{ type: 'output_text', text: 'OK' }]
    }));

    await withServer(createApp(executePipeline), async (baseUrl) => {
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
      expect(response.headers.get('content-type') || '').toContain('text/event-stream');
      expect(text).toContain('event: response.completed');

      const pipelineInput = executePipeline.mock.calls[0]?.[0] as Record<string, any>;
      expect(pipelineInput.body?.stream).toBe(false);
      expect(readStreamIntent(pipelineInput.metadata)).toBe('non_stream');
      expect(pipelineInput.metadata?.outboundStream).toBeUndefined();
      expect(pipelineInput.metadata?.clientStream).toBe(true);
    });
  });
});
