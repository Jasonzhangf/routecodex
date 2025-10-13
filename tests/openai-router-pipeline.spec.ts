import { describe, it, expect, jest } from '@jest/globals';

import { ProtocolHandler } from '../src/server/protocol-handler.js';
import { RequestHandler } from '../src/core/request-handler.js';
import { ProviderManager } from '../src/core/provider-manager.js';
import type { ServerConfig } from '../src/server/types.js';
import { PipelineManager } from '../src/modules/pipeline/core/pipeline-manager.js';
import type { PipelineManagerConfig, PipelineConfig } from '../src/modules/pipeline/interfaces/pipeline-interfaces.js';

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
    url: '/v1/openai/chat/completions',
    headers: {},
    get: () => undefined,
    ip: '127.0.0.1',
  } as any;
}

function makeRes() {
  const out: any = { statusCode: 0, headers: {} as Record<string, string>, jsonBody: null };
  return {
    setHeader: (k: string, v: string) => { out.headers[k] = v; },
    status: (code: number) => { out.statusCode = code; return thisRes; },
    json: (body: any) => { out.jsonBody = body; return thisRes; },
  } as any as { setHeader: (k: string, v: string) => void; status: (code: number) => any; json: (body: any) => any } & { __out?: any };
  function thisRes() { return (arguments.callee as any); }
}

// NOTE: This suite exercises ProtocolHandler with ESM dependencies.
// Current Jest config treats ESM in node_modules inconsistently in this environment.
// Marked as skipped to avoid destabilizing CI until ESM transform is enabled for rcc-* deps.
describe('ProtocolHandler pipeline path', () => {
  it('routes to PipelineManager and returns mapped model', async () => {
    // Prepare PipelineManager with one pipeline id 'test.gpt-4'
    const pipelineCfg: PipelineConfig = {
      id: 'test.gpt-4',
      provider: { type: 'generic-http' } as any,
      modules: {
        llmSwitch: { type: 'llmswitch-openai-openai', config: {} },
        workflow: { type: 'streaming-control', config: {} },
        compatibility: { type: 'field-mapping', config: { rules: [
          { id: 'm', transform: 'mapping', sourcePath: 'model', targetPath: 'model', mapping: { 'gpt-4': 'gpt-4o-mini' } }
        ] } },
        provider: { type: 'generic-http', config: { type: 'openai', baseUrl: 'https://example.invalid', auth: { type: 'apikey', apiKey: 'test', headerName: 'x-api-key', prefix: '' } } },
      },
    } as any;
    const pmConfig: PipelineManagerConfig = { pipelines: [pipelineCfg], settings: { debugLevel: 'basic' } };
    const manager = new PipelineManager(pmConfig, errorCenterStub, debugCenterStub);
    await manager.initialize();

    // OpenAI Router with pipeline enabled
    const providerManager = new ProviderManager(serverConfig);
    const requestHandler = new RequestHandler(providerManager, serverConfig, { validateRequests: false } as any);
    const router = new ProtocolHandler(requestHandler, providerManager, {} as any, { enablePipeline: true, enableValidation: false });
    await router.initialize();
    (router as any).attachPipelineManager(manager);
    (router as any).attachRoutePools({ default: ['test.gpt-4'] });

    // Build request/response
    const req = makeReq({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] });
    const res: any = {
      headers: {} as Record<string, string>,
      statusCode: 0,
      body: null,
      setHeader(k: string, v: string) { this.headers[k] = v; },
      status(code: number) { this.statusCode = code; return this; },
      json(obj: any) { this.body = obj; return this; },
    };

    await (router as any).handleChatCompletions(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBeTruthy();
    expect(Array.isArray(res.body.choices)).toBe(true);
    // Model should be mapped by compatibility to gpt-4o-mini
    expect(res.body.model === 'gpt-4o-mini' || res.body?.data?.model === 'gpt-4o-mini').toBe(true);
  });
});
