import { describe, it, expect, jest } from '@jest/globals';

import { ProtocolHandler } from '../../src/server/protocol-handler.js';
import { RequestHandler } from '../../src/core/request-handler.js';
import { ProviderManager } from '../../src/core/provider-manager.js';
import type { ServerConfig } from '../../src/server/types.js';

// Mock ESM dependencies from rcc-* packages to avoid ESM loader issues in Jest
jest.mock('rcc-basemodule', () => ({
  BaseModule: class { constructor(..._args: any[]) {} },
}), { virtual: true });

jest.mock('rcc-errorhandling', () => ({
  ErrorHandlingCenter: class {
    async initialize() {}
    async handleError(_e?: any) {}
    createContext() { return {}; }
    getStatistics() { return {}; }
  },
}), { virtual: true });

jest.mock('rcc-debugcenter', () => ({
  DebugEventBus: { getInstance: () => ({ publish: () => {}, subscribe: () => {} }) },
}), { virtual: true });

// Minimal server config
const serverConfig: ServerConfig = {
  server: { host: 'localhost', port: 0 },
  providers: {},
  pipelines: [],
} as any;

// Build a minimal stub PipelineManager-like object that returns a Responses-shaped payload
class StubPipelineManager {
  async initialize() {}
  async processRequest(_req: any) {
    return {
      data: {
        id: `resp_${Date.now()}`,
        object: 'response',
        created: Math.floor(Date.now() / 1000),
        model: 'test-model',
        status: 'completed',
        output: [
          { type: 'message', message: { role: 'assistant', content: [ { type: 'output_text', text: 'hello responses' } ] } }
        ],
        output_text: 'hello responses',
      },
    };
  }
}

// Mock Express req/res
function makeReq(body: any) {
  return {
    body,
    method: 'POST',
    url: '/v1/responses',
    headers: {},
    get: () => undefined,
    ip: '127.0.0.1',
  } as any;
}

function makeJsonRes() {
  const out = {
    headers: {} as Record<string, string>,
    statusCode: 0,
    jsonBody: undefined as any,
  };
  const res: any = {
    headersSent: false,
    setHeader(k: string, v: string) { out.headers[k] = v; },
    status(code: number) { out.statusCode = code; return this; },
    json(obj: any) { out.jsonBody = obj; return this; },
  };
  (res as any).__out = out;
  return res as any as { setHeader: (k: string, v: string) => void; status: (n: number) => any; json: (o: any) => any } & { __out: typeof out };
}

describe('ProtocolHandler /v1/responses (non-stream conversion)', () => {
  it('returns JSON Responses payload when stream=false', async () => {
    const providerManager = new ProviderManager(serverConfig);
    const requestHandler = new RequestHandler(providerManager, serverConfig, { validateRequests: false } as any);
    const router = new ProtocolHandler(requestHandler, providerManager, {} as any, { enablePipeline: true, enableValidation: false });
    await router.initialize();
    (router as any).attachPipelineManager(new StubPipelineManager());
    (router as any).attachRoutePools({ default: ['stub.test-model'] });

    const req = makeReq({ model: 'test-model', instructions: 'You are helpful', input: [], stream: false });
    const res = makeJsonRes();

    await (router as any).handleResponses(req, res);

    expect(res.__out.statusCode).toBe(200);
    expect(res.__out.headers['Content-Type']).toContain('application/json');
    expect(res.__out.jsonBody && res.__out.jsonBody.object).toBe('response');
    expect(res.__out.jsonBody && res.__out.jsonBody.status).toBe('completed');
  });
});
