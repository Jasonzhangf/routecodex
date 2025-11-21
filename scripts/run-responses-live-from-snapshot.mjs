#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

const SNAP_DIR = '/Users/fanzhang/.routecodex/codex-samples/openai-responses';
const CFG_PATH = '/Users/fanzhang/.routecodex/provider/c4m/config.v1.json';

function latestProviderRequestFile() {
  const files = fs.readdirSync(SNAP_DIR).filter(f => f.endsWith('_provider-request.json'));
  if (!files.length) return null;
  files.sort((a,b)=> fs.statSync(path.join(SNAP_DIR,b)).mtimeMs - fs.statSync(path.join(SNAP_DIR,a)).mtimeMs);
  return path.join(SNAP_DIR, files[0]);
}

function readConfig() {
  const j = JSON.parse(fs.readFileSync(CFG_PATH,'utf-8'));
  const prov = j?.virtualrouter?.providers?.c4m;
  return { baseURL: prov?.baseURL?.replace(/\/$/,''), apiKey: prov?.auth?.apiKey || (Array.isArray(prov?.apiKey)?prov.apiKey[0]:undefined) };
}

function dropMaxTokenVariants(body) {
  const keys = Object.keys(body);
  for (const k of keys) {
    const kl = k.toLowerCase();
    if (kl === 'maxtoken' || kl === 'maxtokens') delete body[k];
    if (k === 'maxToken' || k === 'maxTokens') delete body[k];
    if (k === 'max_tokens') delete body[k];
  }
  return body;
}

function toReadable(text){ const r = new Readable({read(){}}); setImmediate(()=>{ r.push(text); r.push(null);}); return r; }

// Prefer importing TS sources via tsx runner; fall back to dist if available
let aggregateOpenAIResponsesSSEToJSON;
let createResponsesSSEStreamFromResponsesJson;
try {
  ({ aggregateOpenAIResponsesSSEToJSON } = await import('../sharedmodule/llmswitch-core/src/v2/conversion/streaming/openai-responses-sse-to-json.ts'));
  ({ createResponsesSSEStreamFromResponsesJson } = await import('../sharedmodule/llmswitch-core/src/v2/conversion/streaming/responses-json-to-sse.ts'));
} catch {
  // Fallback to published core dist if TS sources unavailable
  ({ aggregateOpenAIResponsesSSEToJSON } = await import('rcc-llmswitch-core/dist/v2/conversion/streaming/openai-responses-sse-to-json.js'));
  ({ createResponsesSSEStreamFromResponsesJson } = await import('rcc-llmswitch-core/dist/v2/conversion/streaming/json-to-responses-sse.js'));
}

function canonFns(j){ const out=Array.isArray(j?.output)?j.output:[]; const fns=out.filter(o=>o?.type==='function_call').map(o=>({name:o?.name,args:o?.arguments})); const seen=new Set(); const uniq=[]; for(const f of fns){ const k=`${f.name}|${f.args}`; if(!seen.has(k)){ seen.add(k); uniq.push(f);} } return uniq.sort((a,b)=>(a.name+a.args).localeCompare(b.name+b.args)); }
function canonText(j){ try{ const out=Array.isArray(j?.output)?j.output:[]; const msg=out.find(o=>o?.type==='message'); const parts=Array.isArray(msg?.content)?msg.content:[]; const txt=parts.find(p=>p?.type==='output_text'); return String(txt?.text||''); }catch{return '';} }

async function main(){
  const snap = latestProviderRequestFile();
  if (!snap) { console.error('[responses-live] no snapshot provider-request.json found'); process.exit(1); }
  const cfg = readConfig();
  if (!cfg?.baseURL || !cfg?.apiKey) { console.error('[responses-live] missing config'); process.exit(1); }
  const req = JSON.parse(fs.readFileSync(snap,'utf-8'));
  const url = `${cfg.baseURL}/responses`;
  const body = dropMaxTokenVariants({ ...(req?.body || {}) });
  // ensure stream: true for SSE
  body.stream = true;
  const headers = { 'content-type':'application/json', 'authorization': `Bearer ${cfg.apiKey}`, 'OpenAI-Beta': 'responses-2024-12-17', 'accept': 'text/event-stream' };
  const resp = await fetch(url, { method:'POST', headers, body: JSON.stringify(body) });
  const text = await resp.text();
  console.log('[responses-live] status:', resp.status);
  if (!resp.ok) { console.log('[responses-live] body:', text.slice(0,512)); process.exit(2); }
  const originJSON = await aggregateOpenAIResponsesSSEToJSON(toReadable(text));
  const sse = createResponsesSSEStreamFromResponsesJson(originJSON, { requestId: 'resp_live_from_snap' });
  const text2 = await new Promise((resolve)=>{ const arr=[]; sse.on('data',c=>arr.push(String(c))); sse.on('end',()=>resolve(arr.join(''))); });
  const synthJSON = await aggregateOpenAIResponsesSSEToJSON(toReadable(text2));
  console.log('[responses-live] canonText equal:', canonText(originJSON)===canonText(synthJSON));
  console.log('[responses-live] canonFns equal:', JSON.stringify(canonFns(originJSON))===JSON.stringify(canonFns(synthJSON)));
}

main().catch(e=>{ console.error(e); process.exit(1); });
