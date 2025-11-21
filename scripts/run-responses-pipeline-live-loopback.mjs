#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { PipelineManager } from '../dist/modules/pipeline/index.js';
import { aggregateOpenAIResponsesSSEToJSON } from '../sharedmodule/llmswitch-core/src/v2/conversion/streaming/openai-responses-sse-to-json.ts';

function readC4MConfig() {
  const p = '/Users/fanzhang/.routecodex/provider/c4m/config.v1.json';
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const prov = j?.virtualrouter?.providers?.c4m;
    const baseURL = prov?.baseURL;
    const apiKey = prov?.auth?.apiKey || (Array.isArray(prov?.apiKey) ? prov.apiKey[0] : undefined);
    const model = Object.keys(prov?.models || {})[0] || 'gpt-4.1-mini';
    if (!baseURL || !apiKey) return null;
    return { baseURL, apiKey, model };
  } catch { return null; }
}

function latestProviderRequest() {
  const dir = '/Users/fanzhang/.routecodex/codex-samples/openai-responses';
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('_provider-request.json'));
  if (!files.length) return null;
  files.sort((a,b)=> fs.statSync(path.join(dir,b)).mtimeMs - fs.statSync(path.join(dir,a)).mtimeMs);
  try { return JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf-8')); } catch { return null; }
}

function dropMaxTokenVariants(body) {
  const keys = Object.keys(body || {});
  for (const k of keys) {
    const kl = k.toLowerCase();
    if (kl === 'maxtoken' || kl === 'maxtokens') delete body[k];
    if (k === 'maxToken' || k === 'maxTokens' || k === 'max_tokens') delete body[k];
  }
  return body;
}

function toReadable(text) { const r = new Readable({ read() {} }); setImmediate(() => { r.push(text); r.push(null); }); return r; }
function canonFns(j) {
  const out = Array.isArray(j?.output) ? j.output : [];
  const fns = out.filter((o) => o?.type === 'function_call').map((o) => ({ name: o?.name, args: o?.arguments }));
  const seen = new Set(); const uniq = [];
  for (const f of fns) { const k = `${f.name}|${f.args}`; if (!seen.has(k)) { seen.add(k); uniq.push(f); } }
  return uniq.sort((a,b) => (a.name+a.args).localeCompare(b.name+b.args));
}
function canonText(j) { try { const out = Array.isArray(j?.output) ? j.output : []; const msg = out.find((o) => o?.type === 'message'); const parts = Array.isArray(msg?.content) ? msg.content : []; const txt = parts.find((p) => p?.type === 'output_text'); return String(txt?.text || ''); } catch { return ''; } }

async function main() {
  const cfg = readC4MConfig();
  if (!cfg) { console.error('missing c4m config'); process.exit(1); }

  const pipelineId = 'c4m.responses';
  const managerConfig = {
    pipelines: [
      {
        id: pipelineId,
        provider: { type: 'responses' },
        modules: {
          llmSwitch: { type: 'llmswitch-conversion-router', config: { process: 'chat' } },
          workflow: { type: 'streaming-control', config: {} },
          compatibility: { type: 'compatibility', config: {} },
          provider: {
            type: 'responses',
            config: {
              providerType: 'responses',
              baseUrl: cfg.baseURL,
              auth: { type: 'apikey', apiKey: cfg.apiKey },
              overrides: { headers: { Accept: 'application/json' }, endpoint: '/responses' }
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

  const url = `${cfg.baseURL.replace(/\/$/,'')}/responses`;
  const snap = latestProviderRequest();
  const baseBody = (snap?.body && typeof snap.body === 'object') ? { ...snap.body } : { model: cfg.model, input: [ { role: 'user', content: [ { type: 'input_text', text: '你好 (pipeline-live)' } ] } ] };
  const body = dropMaxTokenVariants({ ...baseBody, stream: true });

  // Upstream SSE
  const headers = { 'content-type':'application/json', 'authorization': `Bearer ${cfg.apiKey}`, 'OpenAI-Beta': 'responses-2024-12-17', 'accept': 'text/event-stream' };
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) { console.error('upstream not ok:', res.status); process.exit(2); }
  const upstreamText = await res.text();
  const upstreamJSON = await aggregateOpenAIResponsesSSEToJSON(toReadable(upstreamText));

  // Pipeline SSE
  const req = { data: body, route: { providerId: 'c4m', modelId: String(body.model || cfg.model), requestId: `req_${Date.now()}`, timestamp: Date.now(), pipelineId }, metadata: { entryEndpoint: '/v1/responses', stream: true }, debug: { enabled: false, stages: {} } };
  const out = await manager.processRequest(req);
  const sse = out?.data?.__sse_responses;
  if (!sse) { console.error('pipeline returned no __sse_responses'); process.exit(2); }
  const text2 = await new Promise((resolve) => { const arr = []; sse.on('data', c => arr.push(String(c))); sse.on('end', () => resolve(arr.join(''))); });
  const synthJSON = await aggregateOpenAIResponsesSSEToJSON(toReadable(text2));

  console.log('[responses-pipeline-live] canonText equal:', canonText(upstreamJSON) === canonText(synthJSON));
  console.log('[responses-pipeline-live] canonFns equal:', JSON.stringify(canonFns(upstreamJSON)) === JSON.stringify(canonFns(synthJSON)));
}

main().catch((e)=>{ console.error(e); process.exit(1); });

