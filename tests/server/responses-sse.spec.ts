import { describe, it, expect, jest, beforeEach } from '@jest/globals';

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

// Build a stub PipelineManager that returns a Responses-shaped payload with reasoning + two text parts
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
          { type: 'reasoning', summary: [] },
          { type: 'tool_call', id: 'call_test', name: 'shell', arguments: '{"command":["echo","hi"]}' },
          { type: 'message', message: { role: 'assistant', content: [ { type: 'output_text', text: '' }, { type: 'output_text', text: '晨' } ] } }
        ],
        output_text: '晨',
      },
    };
  }
}

// Mock Express req/res for SSE
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

function makeSSERecorder() {
  const out = {
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    ended: false,
  };
  const res: any = {
    headersSent: false,
    setHeader(k: string, v: string) { out.headers[k] = v; },
    status(_code: number) { return this; },
    json(_obj: any) { return this; },
    write(chunk: string) { out.chunks.push(chunk); },
    end() { out.ended = true; },
  };
  (res as any).__out = out;
  return res as any as { setHeader: (k: string, v: string) => void; status: (n: number) => any; json: (o: any) => any; write: (s: string) => any; end: () => any } & { __out: typeof out };
}

describe('ProtocolHandler /v1/responses SSE simulation', () => {
  beforeEach(() => {
    // Disable pre-heartbeat to simplify deterministic assertions
    process.env.RCC_PRE_SSE_HEARTBEAT_MS = '0';
  });

  it('emits Responses SSE events and finishes with [DONE]', async () => {
    const providerManager = new ProviderManager(serverConfig);
    const requestHandler = new RequestHandler(providerManager, serverConfig, { validateRequests: false } as any);
    const router = new ProtocolHandler(requestHandler, providerManager, {} as any, { enablePipeline: true, enableValidation: false });
    await router.initialize();
    (router as any).attachPipelineManager(new StubPipelineManager());
    (router as any).attachRoutePools({ default: ['stub.test-model'] });

    const req = makeReq({ model: 'test-model', instructions: 'You are helpful', input: [], stream: true });
    const res = makeSSERecorder();

    await (router as any).handleResponses(req, res);

    // Assert headers
    expect(res.__out.headers['Content-Type']).toBe('text/event-stream');

    // Gather stream text
    const joined = res.__out.chunks.join('');
    // Must contain Responses events in sequence
    expect(joined).toContain('event: response.output_item.added');
    // tool_call should be present
    expect(joined).toContain('"type":"tool_call"');
    expect(joined).toContain('"name":"shell"');
    // incremental deltas for tool_call arguments
    expect(joined).toContain('event: response.tool_call.delta');
    expect(joined).toContain('echo');
    expect(joined).toContain('event: response.content_part.added');
    expect(joined).toContain('event: response.output_text.delta');
    expect(joined).toContain('event: response.output_item.done');
    expect(joined).toContain('event: response.done');

    // Delta must include the text we placed ('晨')
    expect(joined).toContain('"delta":"晨"');
    // Ensure stream terminates
    expect(joined).toContain('[DONE]');
    expect(res.__out.ended).toBe(true);
  });
});
