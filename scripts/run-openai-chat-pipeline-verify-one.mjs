#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { PipelineManager } from '../dist/modules/pipeline/index.js';
import { aggregateOpenAIChatSSEToJSON } from '../sharedmodule/llmswitch-core/dist/v2/conversion/streaming/openai-chat-sse-to-json.js';

function readGLMConfig() {
  const p = '/Users/fanzhang/.routecodex/provider/glm/config.v1.json';
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const prov = j?.virtualrouter?.providers?.glm;
    const baseURL = prov?.baseURL || prov?.baseUrl;
    const apiKey = prov?.auth?.apiKey || (Array.isArray(prov?.apiKey) ? prov.apiKey[0] : undefined);
    const model = 'glm-4.6';
    if (!baseURL || !apiKey) return null;
    return { baseURL, apiKey, model };
  } catch { return null; }
}

function latestChatProviderRequest() {
  const dir = '/Users/fanzhang/.routecodex/codex-samples/openai-chat';
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('_provider-request.json'))
    .map(f => ({ f, m: fs.statSync(path.join(dir,f)).mtimeMs }))
    .sort((a,b)=> b.m - a.m)
    .map(x => path.join(dir, x.f));
  return files[0] || null;
}

function toReadable(text) { const r = new Readable({ read() {} }); setImmediate(()=>{ r.push(text); r.push(null); }); return r; }
async function collect(stream) { return await new Promise((resolve)=>{ const arr=[]; stream.on('data', c=>arr.push(String(c))); stream.on('end', ()=> resolve(arr.join(''))); stream.on('error', ()=> resolve(arr.join(''))); }); }

async function main() {
  const cfg = readGLMConfig();
  if (!cfg) { console.error('missing GLM config'); process.exit(1); }

  const prPath = latestChatProviderRequest();
  if (!prPath) { console.error('no chat provider-request snapshot found'); process.exit(2); }
  const pr = JSON.parse(fs.readFileSync(prPath, 'utf-8'));
  const body = pr?.body && typeof pr.body === 'object' ? { ...pr.body } : null;
  if (!body) { console.error('invalid provider-request body'); process.exit(3); }
  body.stream = true;

  const pipelineId = 'glm.openai-chat.single';
  const managerConfig = {
    pipelines: [
      {
        id: pipelineId,
        provider: { type: 'openai' },
        modules: {
          llmSwitch: { type: 'llmswitch-conversion-router', config: { process: 'chat' } },
          workflow: { type: 'streaming-control', config: {} },
          compatibility: { type: 'compatibility', config: { moduleType: 'glm-compatibility', providerType: 'glm' } },
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

  const req = {
    data: { ...body, metadata: { entryEndpoint: '/v1/chat/completions', stream: true } },
    route: { providerId: 'glm', modelId: String(body.model || cfg.model), requestId: `req_${Date.now()}`, timestamp: Date.now(), pipelineId },
    metadata: { entryEndpoint: '/v1/chat/completions', stream: true },
    debug: { enabled: false, stages: {} }
  };
  const out = await manager.processRequest(req);
  const sse = out?.data?.__sse_responses;
  if (!sse) { console.log('[verify-one] FAIL reason=no-sse'); process.exit(4); }

  // 增量读取：检测到 finish_reason 或 [DONE] 即提前结束，避免等待上游 keep-alive
  let buf = '';
  let finished = false;
  let resolveDone;
  const donePromise = new Promise((resolve) => { resolveDone = resolve; });
  const timer = setTimeout(() => { if (!finished) { finished = true; try { sse.destroy(); } catch {} resolveDone(); } }, 60000);
  sse.on('data', (c) => {
    if (finished) return;
    const chunk = String(c);
    buf += chunk;
    if (/\ndata:\s*\[DONE\]\s*\n/.test(buf) || /"finish_reason"\s*:\s*"(stop|length|tool_calls)"/i.test(buf)) {
      finished = true;
      try { sse.destroy(); } catch {}
      resolveDone();
    }
  });
  sse.on('error', () => { if (!finished) { finished = true; resolveDone(); } });
  sse.on('close', () => { if (!finished) { finished = true; resolveDone(); } });
  await donePromise;
  clearTimeout(timer);

  const text = buf;
  const hasDoneToken = /\ndata:\s*\[DONE\]\s*\n/.test(text) || text.trim().endsWith('[DONE]');
  let jsonOk = false; let parsed = null;
  try { parsed = await aggregateOpenAIChatSSEToJSON(toReadable(text)); jsonOk = true; } catch { jsonOk = false; }
  const finishPresent = (() => {
    try {
      const ch0 = Array.isArray(parsed?.choices) ? parsed.choices[0] : null;
      const fr = ch0?.finish_reason ?? null;
      return fr !== undefined;
    } catch { return false; }
  })();
  const ok = (hasDoneToken || finishPresent) && jsonOk;
  console.log('[verify-one] file=', path.basename(prPath), 'doneToken=', hasDoneToken, 'finishField=', finishPresent, 'json=', jsonOk, 'ok=', ok);
  if (!ok) process.exit(5);
}

main().catch((e)=>{ console.error(e); process.exit(1); });
