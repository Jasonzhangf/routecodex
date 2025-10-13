import { describe, it, expect, jest } from '@jest/globals';

import { ProtocolHandler } from '../src/server/protocol-handler.js';
import { RequestHandler } from '../src/core/request-handler.js';
import { ProviderManager } from '../src/core/provider-manager.js';
import type { ServerConfig } from '../src/server/types.js';

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

// Build a minimal stub PipelineManager-like object
class StubPipelineManager {
  async initialize() {}
  async processRequest(_req: any) {
    // Return a typical non-stream OpenAI chat completion payload
    return {
      data: {
        id: `chatcmpl_${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'gpt-4o-mini',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'hello from non-stream' }, finish_reason: 'stop' },
        ],
      },
    };
  }
}

// Mock Express req/res
function makeReq(body: any) {
  return {
    body,
    method: 'POST',
    url: '/v1/openai/chat/completions',
    headers: {},
    get: () => undefined,
    ip: '127.0.0.1',
  } as any;
}

function makeStreamRes() {
  const out = {
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    ended: false,
  };
  const res: any = {
    setHeader(k: string, v: string) { out.headers[k] = v; },
    status(_code: number) { return this; },
    json(_obj: any) { return this; },
    write(chunk: string) { out.chunks.push(chunk); },
    end() { out.ended = true; },
    __out: out,
  };
  return res as any as { setHeader: (k: string, v: string) => void; status: (n: number) => any; json: (o: any) => any; write: (s: string) => any; end: () => any } & { __out: typeof out };
}

describe('ProtocolHandler SSE bridging (stream=true → non-stream provider → SSE to client)', () => {
  it('emits text/event-stream with [DONE] when provider returns non-stream', async () => {
    const providerManager = new ProviderManager(serverConfig);
    const requestHandler = new RequestHandler(providerManager, serverConfig, { validateRequests: false } as any);
    const router = new ProtocolHandler(requestHandler, providerManager, {} as any, { enablePipeline: true, enableValidation: false });
    await router.initialize();
    (router as any).attachPipelineManager(new StubPipelineManager());
    (router as any).attachRoutePools({ default: ['stub.gpt-4o-mini'] });

    const req = makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'ping' }], stream: true });
    const res = makeStreamRes();

    await (router as any).handleChatCompletions(req, res);

    // Assert headers
    expect(res.__out.headers['Content-Type']).toBe('text/event-stream');

    // Assert streamed data contains content and DONE
    const joined = res.__out.chunks.join('');
    expect(joined).toContain('data: ');
    expect(joined).toContain('hello from non-stream');
    expect(joined).toContain('[DONE]');
    expect(res.__out.ended).toBe(true);
  });
});

