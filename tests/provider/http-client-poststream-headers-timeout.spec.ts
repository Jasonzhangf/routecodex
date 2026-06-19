import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_TIMEOUTS, SSE_DEFAULT_CAPS } from '../../src/constants/index.js';
import { HttpClient } from '../../src/providers/core/utils/http-client.js';

describe('HttpClient.postStream headers timeout', () => {
  it('keeps the default stream headers cap aligned with long provider requests', () => {
    expect(DEFAULT_TIMEOUTS.PROVIDER_STREAM_HEADERS_CAP_MS).toBe(900_000);
    expect(SSE_DEFAULT_CAPS.STREAM_HEADERS_CAP_MS).toBe(900_000);
  });

  it('aborts when upstream does not send headers', async () => {
    const server = http.createServer((_req, _res) => {
      // Intentionally do not write headers or end the response.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/stream`;

    const client = new HttpClient({ baseUrl: '', timeout: 5_000, streamHeadersTimeoutMs: 50 });

    try {
      await expect(client.postStream(url, { hello: 'world' }, {} as any)).rejects.toMatchObject({
        code: 'UPSTREAM_HEADERS_TIMEOUT'
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('uses provider timeout as default headers timeout instead of the 120s stream cap', async () => {
    const server = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive'
        });
        res.write('event: response.created\n');
        res.write('data: {"type":"response.created"}\n\n');
        res.end();
      }, 180);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/stream`;

    const client = new HttpClient({ baseUrl: '', timeout: 5_000 });

    try {
      const stream = await client.postStream(url, { hello: 'world' }, {} as any);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).toString('utf8')).toContain('response.created');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('postStreamOrResponse accepts JSON when upstream ignores SSE Accept header', async () => {
    let requestCount = 0;
    let requestAccept = '';
    let requestBody = '';
    const server = http.createServer((req, res) => {
      requestCount += 1;
      requestAccept = String(req.headers.accept || '');
      req.on('data', (chunk) => {
        requestBody += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      });
      req.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'application/json'
        });
        res.end(JSON.stringify({ id: 'json-over-sse', ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/stream`;

    const client = new HttpClient({ baseUrl: '', timeout: 5_000 });

    try {
      const result = await client.postStreamOrResponse(url, { hello: 'world' }, {} as any);
      expect(result.kind).toBe('response');
      if (result.kind !== 'response') {
        throw new Error('expected JSON response');
      }
      expect(result.responseKind).toBe('json');
      expect(result.response.data).toEqual({ id: 'json-over-sse', ok: true });
      expect(requestCount).toBe(1);
      expect(requestAccept).toBe('text/event-stream');
      expect(JSON.parse(requestBody)).toEqual({ hello: 'world' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('postStreamOrResponse accepts JSON body even when upstream labels it as SSE', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8'
      });
      res.end(JSON.stringify({
        id: 'chatcmpl-json-labelled-sse',
        object: 'chat.completion',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'json-labelled-sse-ok' }, finish_reason: 'stop' }
        ]
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/stream`;

    const client = new HttpClient({ baseUrl: '', timeout: 5_000 });

    try {
      const result = await client.postStreamOrResponse(url, { hello: 'world' }, {} as any);
      expect(result.kind).toBe('response');
      if (result.kind !== 'response') {
        throw new Error('expected JSON response');
      }
      expect(result.responseKind).toBe('json');
      expect((result.response.data as any).choices[0].message.content).toBe('json-labelled-sse-ok');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('postStream fails fast instead of wrapping JSON as a fake SSE stream', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/json'
      });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/stream`;

    const client = new HttpClient({ baseUrl: '', timeout: 5_000 });

    try {
      await expect(client.postStream(url, { hello: 'world' }, {} as any)).rejects.toMatchObject({
        code: 'UPSTREAM_RESPONSE_NOT_SSE',
        status: 200
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
