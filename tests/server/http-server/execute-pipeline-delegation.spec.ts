import { jest } from '@jest/globals';
import { RouteCodexHttpServer } from '../../../src/server/runtime/http-server/index.js';
import type { ServerConfigV2 } from '../../../src/server/runtime/http-server/types.js';

function createTestConfig(): ServerConfigV2 {
  return {
    server: {
      host: '127.0.0.1',
      port: 0
    },
    pipeline: {},
    logging: { level: 'error', enableConsole: false },
    providers: {}
  };
}

describe('RouteCodexHttpServer executePipeline single-path delegation', () => {
  jest.setTimeout(30000);

  it('always delegates to requestExecutor instead of legacy runHubPipeline override', async () => {
    const server = new RouteCodexHttpServer(createTestConfig());
    const expected = {
      status: 200,
      headers: { 'x-test': 'ok' },
      body: { ok: true }
    };

    const execute = jest.fn(async () => expected);
    (server as any).requestExecutor = { execute };
    (server as any).runHubPipeline = jest.fn(async () => {
      throw new Error('legacy path must not be used');
    });

    const input = {
      requestId: 'req_test',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { input: [] },
      metadata: { stream: false, inboundStream: false }
    };

    const result = await (server as any).executePipeline(input);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(input);
    expect((server as any).runHubPipeline).not.toHaveBeenCalled();
    expect(result).toEqual(expected);
  });
});
