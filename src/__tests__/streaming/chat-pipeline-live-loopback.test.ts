import OpenAI from 'openai';
import fs from 'fs';
import { Readable } from 'stream';
import { PipelineManager } from '../../modules/pipeline/index.js';
import type { PipelineManagerConfig, PipelineRequest } from '../../modules/pipeline/index.js';
import { bridgeOpenAIChatUpstreamToEvents } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/openai-chat-upstream-bridge.js';
import { assertEquivalent } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/stream-equivalence.js';

process.env.ROUTECODEX_SNAPSHOT_ENABLE = '0';

function readGLMConfig() {
  const p = '/Users/fanzhang/.routecodex/provider/glm/config.v1.json';
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const j = JSON.parse(raw);
    const baseURL = j?.virtualrouter?.providers?.glm?.baseURL || j?.virtualrouter?.providers?.glm?.baseUrl;
    const apiKey = j?.virtualrouter?.providers?.glm?.auth?.apiKey || (Array.isArray(j?.virtualrouter?.providers?.glm?.apiKey) ? j.virtualrouter.providers.glm.apiKey[0] : undefined);
    const model = 'glm-4.6';
    if (!baseURL || !apiKey) return null;
    return { baseURL, apiKey, model };
  } catch {
    return null;
  }
}

async function linesFromSDKStream(stream: any): Promise<string[]> {
  const lines: string[] = [];
  for await (const chunk of stream) {
    lines.push('data: ' + JSON.stringify(chunk) + '\n\n');
  }
  lines.push('data: [DONE]\n\n');
  return lines;
}

function readableFromLines(lines: string[]): Readable {
  const r = new Readable({ read() {} });
  setImmediate(() => { for (const l of lines) r.push(l); r.push(null); });
  return r;
}

describe('Chat pipeline live loopback via real PipelineManager (GLM provider)', () => {
  const cfg = readGLMConfig();
  if (!cfg) {
    test('skip: missing GLM config', () => expect(true).toBe(true));
    return;
  }
  jest.setTimeout(90000);

  async function createManager(): Promise<{ manager: PipelineManager; pipelineId: string }> {
    const pipelineId = 'glm.glm-4.6';
    const managerConfig: PipelineManagerConfig = {
      pipelines: [
        {
          id: pipelineId,
          // Provider meta: used for stream-router hints
          provider: { type: 'openai' },
          modules: {
            llmSwitch: { type: 'llmswitch-conversion-router', config: { process: 'chat' } },
            workflow: { type: 'streaming-control', config: {} },
            compatibility: { type: 'compatibility', config: {} },
            provider: {
              type: 'openai',
              config: {
                providerType: 'glm',
                baseUrl: cfg.baseURL,
                auth: { type: 'apikey', apiKey: cfg.apiKey },
                overrides: { headers: { Accept: 'application/json' } }
              }
            }
          }
        }
      ]
    };
    const dummyErrorCenter: any = { handleError: async () => {}, createContext: () => ({}), getStatistics: () => ({}) };
    const dummyDebugCenter: any = { logDebug: () => {}, logError: () => {}, logModule: () => {}, processDebugEvent: () => {}, getLogs: () => [] };
    const manager = new PipelineManager(managerConfig, dummyErrorCenter, dummyDebugCenter);
    await manager.initialize();
    return { manager, pipelineId };
  }

  test('text streaming roundtrip (SDK stream vs pipeline synthesized SSE)', async () => {
    const { manager, pipelineId } = await createManager();
    const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
    const messages = [{ role: 'user' as const, content: '请用简体中文打个招呼 (pipeline-live)' }];
    const stream = await client.chat.completions.create({ model: cfg.model, messages, stream: true });
    const originLines = await linesFromSDKStream(stream);

    const req: PipelineRequest = {
      data: { model: cfg.model, messages },
      route: { providerId: 'glm', modelId: cfg.model, requestId: `req_${Date.now()}`, timestamp: Date.now(), pipelineId },
      metadata: { entryEndpoint: '/v1/chat/completions', stream: true },
      debug: { enabled: false, stages: {} }
    } as any;
    const out = await manager.processRequest(req);
    const sse = (out?.data as any)?.__sse_responses as Readable;
    expect(typeof (sse as any)?.on).toBe('function');

    const eq = await assertEquivalent(
      bridgeOpenAIChatUpstreamToEvents(readableFromLines(originLines)),
      bridgeOpenAIChatUpstreamToEvents(sse)
    );
    expect(eq.equal).toBe(true);
  });

  test('tool streaming roundtrip (SDK stream vs pipeline synthesized SSE)', async () => {
    const { manager, pipelineId } = await createManager();
    const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
    const messages = [{ role: 'user' as const, content: '请调用 search 工具查询 hello (pipeline-live)' }];
    const tools = [{ type: 'function' as const, function: { name: 'search', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } }];
    const stream = await client.chat.completions.create({ model: cfg.model, messages, tools, stream: true });
    const originLines = await linesFromSDKStream(stream);

    const req: PipelineRequest = {
      data: { model: cfg.model, messages, tools },
      route: { providerId: 'glm', modelId: cfg.model, requestId: `req_${Date.now()}`, timestamp: Date.now(), pipelineId },
      metadata: { entryEndpoint: '/v1/chat/completions', stream: true },
      debug: { enabled: false, stages: {} }
    } as any;
    const out = await manager.processRequest(req);
    const sse = (out?.data as any)?.__sse_responses as Readable;
    expect(typeof (sse as any)?.on).toBe('function');

    const eq = await assertEquivalent(
      bridgeOpenAIChatUpstreamToEvents(readableFromLines(originLines)),
      bridgeOpenAIChatUpstreamToEvents(sse)
    );
    expect(eq.equal).toBe(true);
  });
});

