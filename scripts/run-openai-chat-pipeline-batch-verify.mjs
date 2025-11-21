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

function listLatestChatProviderRequests(limit = 100) {
  const dir = '/Users/fanzhang/.routecodex/codex-samples/openai-chat';
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('_provider-request.json'))
    .map(f => ({ f, m: fs.statSync(path.join(dir,f)).mtimeMs }))
    .sort((a,b)=> b.m - a.m)
    .slice(0, limit)
    .map(x => path.join(dir, x.f));
  return files;
}

function toReadable(text) { const r = new Readable({ read() {} }); setImmediate(()=>{ r.push(text); r.push(null); }); return r; }
async function collect(stream) { return await new Promise((resolve)=>{ const arr=[]; stream.on('data', c=>arr.push(String(c))); stream.on('end', ()=> resolve(arr.join(''))); stream.on('error', ()=> resolve(arr.join(''))); }); }

async function verifyOne(manager, cfg, prPath) {
  const pr = JSON.parse(fs.readFileSync(prPath, 'utf-8'));
  const body = pr?.body && typeof pr.body === 'object' ? { ...pr.body } : null;
  if (!body) return { ok: false, reason: 'invalid-body' };
  body.stream = true;

  const pipelineId = 'glm.openai-chat.batch';
  const req = {
    data: { ...body, metadata: { entryEndpoint: '/v1/chat/completions', stream: true } },
    route: { providerId: 'glm', modelId: String(body.model || cfg.model), requestId: `req_${Date.now()}`, timestamp: Date.now(), pipelineId },
    metadata: { entryEndpoint: '/v1/chat/completions', stream: true },
    debug: { enabled: false, stages: {} }
  };
  const out = await manager.processRequest(req);
  const sse = out?.data?.__sse_responses;
  if (!sse) return { ok: false, reason: 'no-sse' };
  const text = await collect(sse);
  const hasDone = /\ndata:\s*\[DONE\]\s*\n/.test(text) || text.trim().endsWith('[DONE]');
  let jsonOk = false; let parsed = null;
  try { parsed = await aggregateOpenAIChatSSEToJSON(toReadable(text)); jsonOk = true; } catch { jsonOk = false; }
  return { ok: hasDone && jsonOk, reason: (hasDone ? '' : 'no-done') + (jsonOk ? '' : (hasDone ? 'json-agg-failed' : '+json-agg-failed')), parsed };
}

async function main() {
  const cfg = readGLMConfig();
  if (!cfg) { console.error('missing GLM config'); process.exit(1); }

  const files = listLatestChatProviderRequests(100);
  if (!files.length) { console.error('no chat provider-request snapshots found'); process.exit(2); }

  const pipelineId = 'glm.openai-chat.batch';
  const managerConfig = {
    pipelines: [
      {
        id: pipelineId,
        provider: { type: 'openai' },
        modules: {
          llmSwitch: { type: 'llmswitch-conversion-router', config: { process: 'chat' } },
          workflow: { type: 'streaming-control', config: {} },
          // 启用 GLM 兼容以避免上游拒绝
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

  let pass = 0; const fails = [];
  for (const p of files) {
    try {
      const r = await verifyOne(manager, cfg, p);
      if (r.ok) pass++; else fails.push({ file: path.basename(p), reason: r.reason });
    } catch (e) {
      fails.push({ file: path.basename(p), reason: (e?.message || String(e)) });
    }
  }
  console.log(`[batch-verify][chat/openai] total=${files.length} pass=${pass} fail=${fails.length}`);
  if (fails.length) {
    console.log('failures:', JSON.stringify(fails.slice(0, 20), null, 2), fails.length > 20 ? `...(+${fails.length-20} more)` : '');
  }
}

main().catch((e)=>{ console.error(e); process.exit(1); });

