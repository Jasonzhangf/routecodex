#!/usr/bin/env node
// Probe/capture a fai-compatible Responses golden sample by trying minimal variants until success.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const PROVIDER_ID = process.env.RCC_RESP_PROV || 'fai';
const PROVIDER_DIR = path.join(os.homedir(), '.routecodex', 'provider');
const OUT_DIR = path.join(os.homedir(), '.routecodex', 'golden_samples', 'provider_golen_samples', 'responses', PROVIDER_ID);

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function findProviderConfig(providerId) {
  const dir = path.join(PROVIDER_DIR, providerId);
  const files = ['merged-config.5555.json', 'config.v1.json', 'config.json'];
  for (const f of files) { const p = path.join(dir, f); if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  throw new Error(`no provider config for ${providerId}`);
}

function extract(doc, providerId) {
  const pipelines = doc?.pipeline_assembler?.config?.pipelines || [];
  for (const p of pipelines) {
    const prov = p?.modules?.provider?.config;
    if (!prov) continue;
    if ((prov.providerId || providerId) === providerId) return prov;
  }
  const providers = doc?.virtualrouter?.providers || {};
  for (const [pid, prov] of Object.entries(providers)) {
    if (pid === providerId) return { baseUrl: prov.baseURL||prov.baseUrl, endpoint:'/responses', auth: prov.auth, modelId: (doc?.virtualrouter?.routing?.default||[''])[0]?.split('.')?.[1] };
  }
  throw new Error('provider entry missing');
}

function basePayload() {
  const tools = [{ type:'function', name:'add', description:'add two numbers', parameters:{ type:'object', properties:{ a:{type:'number'}, b:{type:'number'} }, required:['a','b'] } }];
  return {
    tools,
    tool_choice: 'auto',
    instructions: 'You are a helpful assistant.',
    input: [ { type:'message', role:'user', content:[ { type:'input_text', text: 'Using tools, call add with {"a":2,"b":3}. Return only a function call.' } ] } ]
  };
}

function variants(payload) {
  const v = [];
  // v1: as-is (short instructions + input[] + tool_choice='auto')
  v.push(JSON.parse(JSON.stringify(payload)));
  // v2: tool_choice object
  { const p = JSON.parse(JSON.stringify(payload)); p.tool_choice = { type:'function', function:{ name:'add' } }; v.push(p); }
  // v3: remove instructions, keep input[] (some providers complain instructions invalid)
  { const p = JSON.parse(JSON.stringify(payload)); delete p.instructions; v.push(p); }
  // v4: keep instructions only, no input[] (some require instructions only)
  { const p = JSON.parse(JSON.stringify(payload)); delete p.input; v.push(p); }
  // v5: compact tools (remove description)
  { const p = JSON.parse(JSON.stringify(payload)); p.tools = p.tools.map(t => ({ type:'function', name:t.name, parameters:t.parameters })); v.push(p); }
  // v6: chat-style tools nesting (some proxies expect {type:'function', function:{name,parameters}})
  { const p = JSON.parse(JSON.stringify(payload)); p.tools = p.tools.map(t => ({ type:'function', function:{ name: t.name, description: t.description, parameters: t.parameters } })); v.push(p); }
  return v;
}

async function main() {
  const cfgDoc = findProviderConfig(PROVIDER_ID);
  const prov = extract(cfgDoc, PROVIDER_ID);
  const baseUrl = String(prov.baseUrl||prov.baseURL||'').replace(/\/$/,'');
  let endpoint = String(prov.endpoint||'/responses');
  // Heuristic: fai baseUrl ends with '/openai/' → they likely expect '/v1/responses'
  if (/\/openai\/?$/.test(baseUrl) && !/\/v1\/?$/.test(baseUrl)) {
    endpoint = '/v1/responses';
  }
  const apiKey = prov?.auth?.apiKey || cfgDoc?.keyVault?.[PROVIDER_ID]?.key1?.value;
  const model = prov.model || prov.modelId || prov.defaultModel || 'gpt-5.1';
  if (!apiKey) throw new Error('no apikey');

  const httpPath = pathToFileURL(path.join(process.cwd(), 'dist/modules/pipeline/modules/provider/v2/utils/http-client.js')).href;
  const { HttpClient } = await import(httpPath);
  const convPath = pathToFileURL(path.join(process.cwd(), 'sharedmodule/llmswitch-core/dist/v2/conversion/conversion-v3/sse/sse-to-json/index.js')).href;
  const { ResponsesSseToJsonConverter } = await import(convPath);

  const headers = { 'Content-Type':'application/json', 'OpenAI-Beta':'responses-2024-12-17', 'Authorization':`Bearer ${apiKey}`, 'User-Agent': 'RouteCodex/2.0 (+https://github.com/routecodex)'};
  const client = new HttpClient({ baseUrl, timeout:300000 });
  // Optional: use an exact golden request body ("same request")
  const SAMPLE = process.env.RCC_FAICAP_SAMPLE;
  let tries;
  if (SAMPLE && fs.existsSync(SAMPLE)) {
    try {
      const obj = JSON.parse(fs.readFileSync(SAMPLE, 'utf-8'));
      const body = obj?.data?.body || obj?.body || obj?.data || obj;
      if (!body || typeof body !== 'object') throw new Error('invalid sample body');
      tries = [body];
    } catch (e) {
      console.error('[fai-capture] invalid sample, fallback to variants:', e?.message||String(e));
      const base = basePayload();
      tries = variants(base);
    }
  } else {
    const base = basePayload();
    tries = variants(base);
  }
  let lastErr;
  for (let i=0;i<tries.length;i++) {
    try {
      const body = { ...tries[i], model, stream:true };
      const stream = await client.postStream(endpoint, body, { ...headers, Accept:'text/event-stream' });
      const conv = new ResponsesSseToJsonConverter();
      const reqId = `fai_probe_${Date.now()}_${i}`;
      const json = await conv.convertSseToJson(stream, { requestId: reqId, model:String(model) });
      // success: write golden
      const outdir = path.join(OUT_DIR, reqId);
      ensureDir(outdir);
      fs.writeFileSync(path.join(outdir, 'provider-request.json'), JSON.stringify({ url: baseUrl+endpoint, headers, body }, null, 2));
      fs.writeFileSync(path.join(outdir, 'provider-response.json'), JSON.stringify(json, null, 2));
      console.log('[fai-capture] success variant=%d out=%s', i+1, outdir);
      return;
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  throw lastErr || new Error('all variants failed');
}

main().catch(e => { console.error('[fai-capture] failed:', e?.message||String(e)); process.exit(1); });
