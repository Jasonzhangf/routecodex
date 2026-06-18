import { describe, expect, it } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';

import { sendPipelineResponse } from '../../../src/server/handlers/handler-response-utils.js';

function sseStreamFrame(data: Record<string, unknown>, event = 'message'): Readable {
  return Readable.from([`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`]);
}

function sseStreamChunks(chunks: string[]): Readable {
  return Readable.from(chunks);
}

async function requestSse(
  body: Record<string, unknown>,
  options?: {
    metadata?: Record<string, unknown>;
    continuationOwner?: 'direct' | 'relay';
    chunks?: string[];
  }
): Promise<{ status: number; text: string }> {
  const app = express();
  app.get('/sse', (_req, res) => {
    const stream = options?.chunks ? sseStreamChunks(options.chunks) : sseStreamFrame(body);
    void sendPipelineResponse(
      res as any,
      {
        status: 200,
        headers: {},
        body: {
          mode: 'sse'
        },
        sseStream: stream,
        metadata: {
          outboundStream: true,
          clientModelId: 'client-visible-model',
          ...(options?.metadata ?? {})
        },
        continuationOwner: options?.continuationOwner,
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
  it('fails fast before emitting SSE data payload with top-level internal metadata controls', async () => {
    const response = await requestSse({ id: 'evt-1', metadata: { routeHint: 'tools' } });

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

  it('keeps ordinary provider metadata on direct passthrough SSE', async () => {
    const response = await requestSse(
      {},
      {
        continuationOwner: 'direct',
        chunks: [
          `event: response.metadata\ndata: ${JSON.stringify({
            type: 'response.metadata',
            metadata: { provider_event_id: 'evt-provider-1' }
          })}\n\n`
        ]
      }
    );

    expect(response.status).toBe(200);
    expect(response.text).toContain('"metadata":{"provider_event_id":"evt-provider-1"}');
    expect(response.text).not.toContain('sse_stream_error');
  });

  it('streams CRLF direct passthrough frames with ordinary provider metadata', async () => {
    const response = await requestSse(
      {},
      {
        continuationOwner: 'direct',
        chunks: [
          `event: response.metadata\r\ndata: ${JSON.stringify({
            type: 'response.metadata',
            metadata: { provider_event_id: 'evt-provider-crlf' }
          })}\r\n\r\n`
        ]
      }
    );

    expect(response.status).toBe(200);
    expect(response.text).toContain('\r\n\r\n');
    expect(response.text).toContain('"metadata":{"provider_event_id":"evt-provider-crlf"}');
    expect(response.text).not.toContain('sse_stream_error');
  });

  it('fails direct passthrough split SSE frame before leaking internal metadata controls', async () => {
    const frame = `event: response.metadata\ndata: ${JSON.stringify({
      type: 'response.metadata',
      metadata: { routeHint: 'tools' }
    })}\n\n`;
    const response = await requestSse(
      {},
      {
        continuationOwner: 'direct',
        chunks: [frame.slice(0, 18), frame.slice(18)]
      }
    );

    expect(response.status).toBe(200);
    expect(response.text).toContain('event: error');
    expect(response.text).toContain('sse_stream_error');
    expect(response.text).not.toContain('routeHint');
  });

  it('rejects wrapper response.metadata without standard response event semantics', async () => {
    const response = await requestSse({
      response: {
        id: 'resp_wrapper_meta_1',
        metadata: { provider_event_id: 'wrapper-metadata-must-not-pass' }
      }
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain('event: error');
    expect(response.text).toContain('sse_stream_error');
    expect(response.text).not.toContain('wrapper-metadata-must-not-pass');
  });
});
