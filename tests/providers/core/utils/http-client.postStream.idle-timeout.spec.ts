import http from 'node:http';
import { once } from 'node:events';
import { HttpClient } from '../../../../src/providers/core/utils/http-client.js';

describe('HttpClient.postStream idle timeout', () => {
  it('aborts stalled upstream streams and emits an error', async () => {
    const prevIdle = process.env.ROUTECODEX_PROVIDER_STREAM_IDLE_TIMEOUT_MS;
    process.env.ROUTECODEX_PROVIDER_STREAM_IDLE_TIMEOUT_MS = '50';

    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive'
      });
      res.flushHeaders();
      // Keep connection open without sending any data.
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        throw new Error('Failed to bind test HTTP server');
      }
      const client = new HttpClient({ baseUrl: `http://127.0.0.1:${addr.port}`, timeout: 10_000 });

      const stream = await client.postStream('/stream', { ok: true });
      // Ensure the stream starts flowing so errors surface to consumer.
      stream.resume();

      const [error] = (await once(stream, 'error')) as [Error];
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('UPSTREAM_STREAM_IDLE_TIMEOUT');
    } finally {
      if (prevIdle === undefined) {
        delete process.env.ROUTECODEX_PROVIDER_STREAM_IDLE_TIMEOUT_MS;
      } else {
        process.env.ROUTECODEX_PROVIDER_STREAM_IDLE_TIMEOUT_MS = prevIdle;
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
