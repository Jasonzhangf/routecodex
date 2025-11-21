#!/usr/bin/env node
import fs from 'node:fs';
import { Readable } from 'node:stream';
import OpenAI from 'openai';
import { PipelineManager } from '../dist/modules/pipeline/index.js';
import { bridgeOpenAIChatUpstreamToEvents } from '../sharedmodule/llmswitch-core/src/v2/conversion/streaming/openai-chat-upstream-bridge.ts';
import { assertEquivalent } from '../sharedmodule/llmswitch-core/src/v2/conversion/streaming/stream-equivalence.ts';

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
  } catch { return null; }
}

async function linesFromSDKStream(stream) {
  const lines = [];
  for await (const chunk of stream) {
    lines.push('data: ' + JSON.stringify(chunk) + '\n\n');
  }
  lines.push('data: [DONE]\n\n');
  return lines;
}

function readableFromLines(lines) {
  const r = new Readable({ read() {} });
  setImmediate(() => { for (const l of lines) r.push(l); r.push(null); });
  return r;
}

async function main() {
  const cfg = readGLMConfig();
  if (!cfg) { console.error('missing GLM config'); process.exit(1); }

  const pipelineId = 'glm.glm-4.6';
  const managerConfig = {
    pipelines: [
      {
        id: pipelineId,
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
  const dummyErrorCenter = { handleError: async () => {}, createContext: () => ({}), getStatistics: () => ({}) };
  const dummyDebugCenter = { logDebug: () => {}, logError: () => {}, logModule: () => {}, processDebugEvent: () => {}, getLogs: () => [] };
  const manager = new PipelineManager(managerConfig, dummyErrorCenter, dummyDebugCenter);
  await manager.initialize();

  // SDK reference client
  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });

  // Case 1: text
  {
    const messages = [{ role: 'user', content: '请用简体中文打个招呼 (pipeline-live)' }];
    const stream = await client.chat.completions.create({ model: cfg.model, messages, stream: true });
    const originLines = await linesFromSDKStream(stream);
    const req = {
      data: { model: cfg.model, messages },
      route: { providerId: 'glm', modelId: cfg.model, requestId: `req_${Date.now()}`, timestamp: Date.now(), pipelineId },
      metadata: { entryEndpoint: '/v1/chat/completions', stream: true },
      debug: { enabled: false, stages: {} }
    };
    const out = await manager.processRequest(req);
    const sse = out?.data?.__sse_responses;
    if (!sse) throw new Error('pipeline did not return __sse_responses');
    const eq = await assertEquivalent(
      bridgeOpenAIChatUpstreamToEvents(readableFromLines(originLines)),
      bridgeOpenAIChatUpstreamToEvents(sse)
    );
    console.log('[chat-pipeline-live][text] equivalent:', eq.equal);
    if (!eq.equal) console.log('[chat-pipeline-live][text] diff:', JSON.stringify(eq));
  }

  // Case 2: tool
  {
    const messages = [{ role: 'user', content: '请调用 search 工具查询 hello (pipeline-live)' }];
    const tools = [{ type: 'function', function: { name: 'search', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } }];
    const stream = await client.chat.completions.create({ model: cfg.model, messages, tools, stream: true });
    const originLines = await linesFromSDKStream(stream);
    const req = {
      data: { model: cfg.model, messages, tools },
      route: { providerId: 'glm', modelId: cfg.model, requestId: `req_${Date.now()}`, timestamp: Date.now(), pipelineId },
      metadata: { entryEndpoint: '/v1/chat/completions', stream: true },
      debug: { enabled: false, stages: {} }
    };
    const out = await manager.processRequest(req);
    const sse = out?.data?.__sse_responses;
    if (!sse) throw new Error('pipeline did not return __sse_responses');
    const eq = await assertEquivalent(
      bridgeOpenAIChatUpstreamToEvents(readableFromLines(originLines)),
      bridgeOpenAIChatUpstreamToEvents(sse)
    );
    console.log('[chat-pipeline-live][tool] equivalent:', eq.equal);
    if (!eq.equal) console.log('[chat-pipeline-live][tool] diff:', JSON.stringify(eq));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
