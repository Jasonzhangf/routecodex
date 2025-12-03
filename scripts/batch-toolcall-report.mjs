#!/usr/bin/env node
// Batch tool-call regression across providers (responses + anthropic)
// Outputs a JSON report to stdout and prints a summary

import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const PROVIDER_DIR = path.join(os.homedir(), '.routecodex', 'provider');
const RESP_SAMPLES_DIR = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-responses');
const RESP_OUT_DIR = path.join(os.homedir(), '.routecodex', 'logs', 'responses-sse');
const ANTH_OUT_DIR = path.join(os.homedir(), '.routecodex', 'logs', 'anthropic-sse');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function nowStamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

function findProviderConfig(providerId) {
  const dir = path.join(PROVIDER_DIR, providerId);
  const files = ['config.v1.json', 'config.json'];
  for (const f of files) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  }
  throw new Error(`no provider config for ${providerId}`);
}

function extractResponsesConfig(doc, providerId) {
  const pipelines = doc?.pipeline_assembler?.config?.pipelines || [];
  for (const p of pipelines) {
    const prov = p?.modules?.provider?.config;
    if (!prov) continue;
    if ((prov.providerId || providerId) === providerId && (prov.providerType||'').includes('responses')) return prov;
  }
  const providers = doc?.virtualrouter?.providers || {};
  for (const [pid, prov] of Object.entries(providers)) {
    if (pid === providerId) return { baseUrl: prov.baseURL||prov.baseUrl, endpoint: '/responses', auth: prov.auth, modelId: (doc?.virtualrouter?.routing?.default||[''])[0]?.split('.')?.[1] };
  }
  throw new Error('responses provider entry missing');
}

function listRespSamples() {
  if (!fs.existsSync(RESP_SAMPLES_DIR)) return [];
  return fs.readdirSync(RESP_SAMPLES_DIR).filter(n => n.endsWith('_provider-request.json'));
}

function pickRespSampleFor(provCfg) {
  const files = listRespSamples();
  const base = String(provCfg.baseUrl||'').replace(/\/$/,'');
  const host = base.split('://')[1] || base;
  let matches = files.filter(f => {
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(RESP_SAMPLES_DIR, f), 'utf-8'));
      const url = obj?.data?.url || obj?.url || '';
      return typeof url === 'string' && url.includes(host);
    } catch { return false; }
  });
  if (!matches.length) matches = files;
  matches.sort((a, b) => {
    const aa = fs.readFileSync(path.join(RESP_SAMPLES_DIR, a), 'utf-8');
    const bb = fs.readFileSync(path.join(RESP_SAMPLES_DIR, b), 'utf-8');
    const score = txt => (txt.includes('"input"')?10:0)+(txt.includes('"tools"')?2:0)+(txt.includes('function_call_arguments')?1:0);
    return score(bb)-score(aa);
  });
  return matches[0] || null;
}

async function runResponses(providerId) {
  const cfgDoc = findProviderConfig(providerId);
  const provCfg = extractResponsesConfig(cfgDoc, providerId);
  const baseUrl = String(provCfg.baseUrl||provCfg.baseURL||'').replace(/\/$/,'');
  const endpoint = String(provCfg.endpoint||'/responses');
  const apiKey = provCfg?.auth?.apiKey || cfgDoc?.keyVault?.[providerId]?.key1?.value;
  if (!apiKey) throw new Error('no apikey');
  const chosen = pickRespSampleFor(provCfg);
  if (!chosen) throw new Error('no golden sample');
  const sample = JSON.parse(fs.readFileSync(path.join(RESP_SAMPLES_DIR, chosen), 'utf-8'));
  const body = sample?.data?.body || sample?.body || sample?.data || sample;
  if (!body || typeof body !== 'object') throw new Error('invalid golden body');
  const model = provCfg.model || provCfg.modelId || provCfg.defaultModel || body.model;
  body.model = model; body.stream = true;

  const httpPath = pathToFileURL(path.join(process.cwd(), 'dist/providers/core/utils/http-client.js')).href;
  const { HttpClient } = await import(httpPath);
  const convPath = pathToFileURL(path.join(process.cwd(), 'sharedmodule/llmswitch-core/dist/sse/sse-to-json/index.js')).href;
  const bridgePath = pathToFileURL(path.join(process.cwd(), 'sharedmodule/llmswitch-core/dist/conversion/responses/responses-openai-bridge.js')).href;
  const { ResponsesSseToJsonConverter } = await import(convPath);
  const { buildChatResponseFromResponses } = await import(bridgePath);

  ensureDir(RESP_OUT_DIR);
  const base = path.join(RESP_OUT_DIR, `${providerId}_batch_${nowStamp()}`);
  const sseLog = `${base}.sse.log`, jsonOut = `${base}.json`, chatOut = `${base}.chat.json`;

  const headers = { 'Content-Type':'application/json', 'OpenAI-Beta':'responses-2024-12-17', 'Authorization':`Bearer ${apiKey}` };
  fs.writeFileSync(`${base}.request.json`, JSON.stringify({ url: baseUrl+endpoint, headers, body }, null, 2));

  const client = new HttpClient({ baseUrl, timeout: 300000 });
  const stream = await client.postStream(endpoint, body, { ...headers, Accept: 'text/event-stream' });
  const conv = new ResponsesSseToJsonConverter();
  const json = await conv.convertSseToJson(stream, {
    requestId: path.basename(base),
    model: String(body.model||'unknown'),
    onEvent: (evt) => { try { fs.appendFileSync(sseLog, `event: ${evt.type}\n`); fs.appendFileSync(sseLog, `data: ${JSON.stringify(evt.data)}\n\n`); } catch {} }
  });
  fs.writeFileSync(jsonOut, JSON.stringify(json, null, 2));
  const chat = buildChatResponseFromResponses(json);
  fs.writeFileSync(chatOut, JSON.stringify(chat, null, 2));
  const tc = chat?.choices?.[0]?.message?.tool_calls || [];
  const ok = Array.isArray(tc) && tc.length>0;
  return { providerId, family:'responses', status: ok?'ok':'no_toolcall', toolCalls: ok? tc.length: 0, artifacts: { sseLog, jsonOut, chatOut }, sample: chosen };
}

async function runAnthropic(providerId='glm-anthropic') {
  const cfgDoc = findProviderConfig(providerId);
  // pipeline_assembler preferred
  let baseURL, apiKey, model;
  try {
    const p = cfgDoc?.pipeline_assembler?.config?.pipelines?.[0]?.modules?.provider?.config;
    baseURL = (p?.baseUrl||p?.baseURL||'').replace(/\/$/,''); apiKey = p?.auth?.apiKey; model = p?.model||p?.modelId||p?.defaultModel||'glm-4.6';
  } catch {}
  if (!baseURL) {
    const entry = cfgDoc?.virtualrouter?.providers?.[providerId] || Object.values(cfgDoc?.virtualrouter?.providers||{})[0];
    baseURL = (entry?.baseURL||'https://api.anthropic.com/v1').replace(/\/$/,'');
    apiKey = entry?.auth?.apiKey || (Array.isArray(entry?.apiKey)?entry.apiKey[0]:entry?.apiKey);
    const route = (cfgDoc?.virtualrouter?.routing?.default||[''])[0];
    model = route?.split('.')?.[1] || 'glm-4.6';
  }
  if (!apiKey) throw new Error('no apikey');
  const codecPath = pathToFileURL(path.join(process.cwd(), 'sharedmodule/llmswitch-core/dist/conversion/codecs/anthropic-openai-codec.js')).href;
  const { buildAnthropicRequestFromOpenAIChat, buildOpenAIChatFromAnthropic } = await import(codecPath);
  const chat = { model:'dummy', messages:[{ role:'user', content:'Using tools, call add with {"a":2,"b":3}. Return only a function call.' }], tools:[{ type:'function', function:{ name:'add', description:'add two numbers', parameters:{ type:'object', properties:{ a:{type:'number'}, b:{type:'number'}}, required:['a','b'] } } }], tool_choice:'auto' };
  const req = buildAnthropicRequestFromOpenAIChat(chat);
  req.model = model; req.max_tokens = 256; req.stream = true;

  ensureDir(ANTH_OUT_DIR);
  const base = path.join(ANTH_OUT_DIR, `${providerId}_batch_${nowStamp()}`);
  const sseLog = `${base}.sse.log`, jsonOut = `${base}.json`, chatOut = `${base}.chat.json`;
  fs.writeFileSync(`${base}.request.json`, JSON.stringify(req, null, 2));
  const headers = { 'content-type':'application/json', 'accept':'text/event-stream', 'x-api-key': apiKey, 'anthropic-version':'2023-06-01' };
  const resp = await fetch(baseURL + '/messages', { method:'POST', headers, body: JSON.stringify(req) });
  if (!resp.ok || !resp.body) { const t = await resp.text().catch(()=> ''); throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${t}`); }
  const reader = resp.body.getReader(); const decoder = new TextDecoder(); let buffer=''; const events=[];
  while (true) { const {value,done} = await reader.read(); if (done) break; const chunk = decoder.decode(value); const lines=(buffer+chunk).split('\n'); buffer=lines.pop()||''; let cur={}; for (const l of lines){const s=l.trim(); if(!s){ if(Object.keys(cur).length){ events.push(cur); cur={}; } continue;} if(s.startsWith('event:')) cur.event=s.slice(6).trim(); else if(s.startsWith('data:')){ const d=s.slice(5).trim(); try{ cur.data=JSON.parse(d);}catch{cur.data={raw:d}} } }
    if (Object.keys(cur).length) { events.push(cur); cur={}; }
  }
  const sseText = events.map(ev => `event: ${ev.event}\n`+`data: ${JSON.stringify(ev.data)}\n\n`).join('');
  fs.writeFileSync(sseLog, sseText, 'utf-8');
  const convPath = pathToFileURL(path.join(process.cwd(), 'sharedmodule/llmswitch-core/dist/sse/sse-to-json/anthropic-sse-to-json-converter.js')).href;
  const { AnthropicSseToJsonConverter } = await import(convPath);
  async function* gen(){ yield sseText; }
  const conv = new AnthropicSseToJsonConverter();
  const message = await conv.convertSseToJson(gen(), { requestId: path.basename(base) });
  fs.writeFileSync(jsonOut, JSON.stringify(message, null, 2));
  const chatResp = buildOpenAIChatFromAnthropic({ messages: [message] });
  fs.writeFileSync(chatOut, JSON.stringify(chatResp, null, 2));
  const tc = chatResp?.messages?.[0]?.tool_calls || [];
  const ok = Array.isArray(tc) && tc.length>0;
  return { providerId, family:'anthropic', status: ok?'ok':'no_toolcall', toolCalls: ok? tc.length: 0, artifacts: { sseLog, jsonOut, chatOut } };
}

async function main(){
  const tasks = [
    { family:'responses', providerId:'fc' },
    { family:'responses', providerId:'c4m' },
    { family:'responses', providerId:'fai' },
    { family:'anthropic', providerId:'glm-anthropic' },
  ];
  const report = [];
  for (const t of tasks) {
    try {
      const r = t.family==='responses' ? await runResponses(t.providerId) : await runAnthropic(t.providerId);
      report.push(r);
    } catch (e) {
      report.push({ providerId: t.providerId, family: t.family, status:'error', error: (e?.message||String(e)).slice(0,500) });
    }
  }
  const summary = report.reduce((acc, r)=>{ acc[r.status]=(acc[r.status]||0)+1; return acc; }, {});
  console.log('[batch-toolcall-report] summary:', summary);
  console.log(JSON.stringify(report, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
