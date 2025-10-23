import { describe, it, expect, jest } from '@jest/globals';

import { ProtocolHandler } from '../../src/server/protocol-handler.js';
import { RequestHandler } from '../../src/core/request-handler.js';
import { ProviderManager } from '../../src/core/provider-manager.js';
import type { ServerConfig } from '../../src/server/types.js';
import { PipelineManager } from '../../src/modules/pipeline/core/pipeline-manager.js';
import type { PipelineManagerConfig, PipelineConfig } from '../../src/modules/pipeline/interfaces/pipeline-interfaces.js';

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

// Stubs
const errorCenterStub: any = {
  handleError: async () => void 0,
  createContext: () => ({}),
  getStatistics: () => ({}),
};
const debugCenterStub: any = {
  processDebugEvent: () => void 0,
};

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

describe('ProtocolHandler /v1/responses with PipelineManager', () => {
  it('routes through pipeline (llmswitch-response-chat) and returns Responses JSON', async () => {
    const pipelineCfg: PipelineConfig = {
      id: 'test.responses',
      provider: { type: 'generic-http' } as any,
      modules: {
        llmSwitch: { type: 'llmswitch-response-chat', config: {} },
        workflow: { type: 'streaming-control', config: {} },
        compatibility: { type: 'field-mapping', config: { rules: [] } },
        provider: {
          type: 'generic-http',
          config: {
            type: 'openai',
            baseUrl: 'https://example.invalid',
            auth: { type: 'apikey', apiKey: 'test-key', headerName: 'x-api-key', prefix: '' },
          },
        },
      },
      settings: { debugEnabled: true },
    } as any;
    const pmConfig: PipelineManagerConfig = { pipelines: [pipelineCfg], settings: { debugLevel: 'basic' } };
    const manager = new PipelineManager(pmConfig, errorCenterStub, debugCenterStub);
    await manager.initialize();

    const providerManager = new ProviderManager(serverConfig);
    const requestHandler = new RequestHandler(providerManager, serverConfig, { validateRequests: false } as any);
    const router = new ProtocolHandler(requestHandler, providerManager, {} as any, { enablePipeline: true, enableValidation: false });
    await router.initialize();
    (router as any).attachPipelineManager(manager);
    (router as any).attachRoutePools({ default: ['test.responses'] });

    const req = makeReq({
      model: 'gpt-x',
      instructions: 'You are helpful',
      input: [ { type: 'message', role: 'user', content: [ { type: 'input_text', text: 'ping' } ] } ],
      stream: false,
    });
    const res: any = {
      headers: {} as Record<string, string>,
      statusCode: 0,
      body: null,
      setHeader(k: string, v: string) { this.headers[k] = v; },
      status(code: number) { this.statusCode = code; return this; },
      json(obj: any) { this.body = obj; return this; },
    };

    await (router as any).handleResponses(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body && res.body.object).toBe('response');
    expect(typeof res.body.output_text).toBe('string');
    // generic-http provider simulates a chat response message; llmswitch should convert to Responses output_text
    expect((res.body.output_text as string).length).toBeGreaterThan(0);

    // Cleanup timers to avoid open handle warnings in Jest
    await manager.cleanup?.();
  });
});
