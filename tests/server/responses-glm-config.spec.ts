import { describe, it, expect, jest } from '@jest/globals';

import { ProtocolHandler } from '../../src/server/protocol-handler.js';
import { RequestHandler } from '../../src/core/request-handler.js';
import { ProviderManager } from '../../src/core/provider-manager.js';
import type { ServerConfig } from '../../src/server/types.js';
import { PipelineManager } from '../../src/modules/pipeline/core/pipeline-manager.js';
import type { PipelineManagerConfig, PipelineConfig } from '../../src/modules/pipeline/interfaces/pipeline-interfaces.js';

// Mocks for ESM deps
jest.mock('rcc-basemodule', () => ({ BaseModule: class { constructor(..._args: any[]) {} } }), { virtual: true });
jest.mock('rcc-errorhandling', () => ({
  ErrorHandlingCenter: class { async initialize() {}; async handleError() {}; createContext() { return {}; } getStatistics() { return {}; } },
}), { virtual: true });
jest.mock('rcc-debugcenter', () => ({ DebugEventBus: { getInstance: () => ({ publish: () => {}, subscribe: () => {} }) } }), { virtual: true });

const serverConfig: ServerConfig = { server: { host: 'localhost', port: 0 }, providers: {}, pipelines: [] } as any;
const errorCenterStub: any = { handleError: async () => void 0, createContext: () => ({}), getStatistics: () => ({}) };
const debugCenterStub: any = { processDebugEvent: () => void 0 };

function makeReq(body: any) {
  return { body, method: 'POST', url: '/v1/responses', headers: {}, get: () => undefined, ip: '127.0.0.1' } as any;
}

describe('GLM-verified style config (llmswitch only change, no config churn)', () => {
  it('keeps config stable and injects reasoning_content via compatibility -> appears as reasoning item in Responses', async () => {
    // Pipeline mimics a GLM-style configuration but uses generic-http provider in tests (no network)
    // We only rely on llmswitch-response-chat to convert to Responses; no config churn needed.
    const pipelineCfg: PipelineConfig = {
      id: 'glm.test',
      provider: { type: 'generic-http' } as any,
      modules: {
        // Only llmswitch changed to support responses; config stays the same otherwise
        llmSwitch: { type: 'llmswitch-response-chat', config: {} },
        workflow: { type: 'streaming-control', config: {} },
        // Response mapping: copy content -> reasoning_content when content exists (simulate GLM returning reasoning)
        compatibility: {
          type: 'field-mapping',
          config: {
            rules: [],
            responseMappings: [
              {
                id: 'inject-reasoning-content',
                transform: 'extract',
                sourcePath: 'choices.0.message.content',
                targetPath: 'choices.0.message.reasoning_content',
                extractor: 'regex',
                pattern: '([\\s\\S]+)',
                removeSource: false
              }
            ]
          }
        },
        provider: {
          type: 'generic-http',
          config: { type: 'openai', baseUrl: 'https://example.invalid', auth: { type: 'apikey', apiKey: 'test-key', headerName: 'x-api-key', prefix: '' } }
        }
      },
      settings: { debugEnabled: false }
    } as any;
    const pmConfig: PipelineManagerConfig = { pipelines: [pipelineCfg], settings: { debugLevel: 'basic' } };
    const manager = new PipelineManager(pmConfig, errorCenterStub, debugCenterStub);
    await manager.initialize();

    const providerManager = new ProviderManager(serverConfig);
    const requestHandler = new RequestHandler(providerManager, serverConfig, { validateRequests: false } as any);
    const router = new ProtocolHandler(requestHandler, providerManager, {} as any, { enablePipeline: true, enableValidation: false });
    await router.initialize();
    (router as any).attachPipelineManager(manager);
    (router as any).attachRoutePools({ default: ['glm.test'] });

    const req = makeReq({ model: 'glm-4.6', instructions: 'You are helpful', input: [ { type: 'message', role: 'user', content: [ { type: 'input_text', text: 'hi' } ] } ], stream: false });
    const res: any = { headers: {} as Record<string, string>, statusCode: 0, body: null, setHeader(k: string, v: string) { this.headers[k] = v; }, status(code: number) { this.statusCode = code; return this; }, json(obj: any) { this.body = obj; return this; } };

    await (router as any).handleResponses(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body && res.body.object).toBe('response');
    // Verify a reasoning item is present (injected from reasoning_content created by field mapping)
    const output = Array.isArray(res.body?.output) ? res.body.output : [];
    const hasReasoning = output.some((it: any) => it && it.type === 'reasoning');
    expect(hasReasoning).toBe(true);

    await manager.cleanup?.();
  });
});
