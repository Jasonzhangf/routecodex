import { describe, expect, it } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';

import { sendPipelineResponse } from '../../../src/server/handlers/handler-response-utils.js';

function sseStreamFrame(data: Record<string, unknown>, event = 'message'): Readable {
  return Readable.from([`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`]);
}

async function requestSse(body: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const app = express();
  app.get('/sse', (_req, res) => {
    void sendPipelineResponse(
      res as any,
      {
        status: 200,
        headers: {},
        body: {
          mode: 'sse',
          __sse_responses: sseStreamFrame(body)
        },
        metadata: {
          outboundStream: true,
          clientModelId: 'client-visible-model'
        }
      } as any,
      'req_sse_metadata_guard',
      { entryEndpoint: '/v1/responses' }
    );
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${addr.port}/sse`, {
      headers: { accept: 'text/event-stream' }
    });
    return { status: response.status, text: await response.text() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('handler-response-utils SSE metadata guard (Phase Server-C)', () => {
  it('fails fast before emitting SSE data payload with top-level metadata', async () => {
    const response = await requestSse({ id: 'evt-1', metadata: { internal: true } });

    expect(response.status).toBe(200);
    expect(response.text).toContain('event: error');
    expect(response.text).toContain('sse_stream_error');
    expect(response.text).not.toContain('"metadata"');
  });

  it('fails fast before emitting SSE data payload with nested __rt', async () => {
    const response = await requestSse({ id: 'evt-2', choices: [{ message: { __rt: { internal: true } } }] });

    expect(response.status).toBe(200);
    expect(response.text).toContain('event: error');
    expect(response.text).toContain('sse_stream_error');
    expect(response.text).not.toContain('__rt');
  });

  it('passes clean SSE data payload', async () => {
    const response = await requestSse({ id: 'evt-3', choices: [{ message: { role: 'assistant', content: 'hi' } }] });

    expect(response.status).toBe(200);
    expect(response.text).toContain('"content":"hi"');
    expect(response.text).not.toContain('sse_stream_error');
  });
});
