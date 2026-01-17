import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpClient } from '../../src/providers/core/utils/http-client.js';

describe('HttpClient.postStream headers timeout', () => {
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
});
