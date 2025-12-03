#!/usr/bin/env node
// Replay a Responses golden provider-request sample to a live provider and aggregate SSE → JSON → Chat.
// Usage:
//   RCC_RESP_PROV=<providerId> node scripts/responses-sse-replay-golden.mjs
// Env:
//   RCC_RESP_PROV: fc|c4m|fai (default fc)
//   RCC_RESP_PICK: substring to pick a specific sample file

import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const PROVIDER_DIR = path.join(os.homedir(), '.routecodex', 'provider');
const SAMPLES_DIR = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-responses');
const OUT_DIR = path.join(os.homedir(), '.routecodex', 'logs', 'responses-sse');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function nowStamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

function findProviderConfig(providerId) {
  const dir = path.join(PROVIDER_DIR, providerId);
  const candidates = ['config.v1.json', 'config.json'];
  for (const name of candidates) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  }
  throw new Error(`No provider config for ${providerId}`);
}

function extractProviderEntry(doc, providerId) {
  const pipelines = doc?.pipeline_assembler?.config?.pipelines || [];
  for (const p of pipelines) {
    const prov = p?.modules?.provider;
    if (!prov?.config) continue;
    const pid = prov.config.providerId || path.basename(path.dirname(p?.__file || ''));
    if (pid === providerId) return prov.config;
  }
  // fallback v1
  const providers = doc?.virtualrouter?.providers || {};
  return Object.values(providers)[0] || null;
}

function listGoldenRequests() {
  if (!fs.existsSync(SAMPLES_DIR)) return [];
  return fs.readdirSync(SAMPLES_DIR).filter(n => n.endsWith('_provider-request.json'));
}

function pickGoldenForBaseUrl(files, baseUrl, pickHint) {
  const want = String(baseUrl || '').replace(/\/$/, '');
  const host = want.split('://')[1] || want; // naive
  let matches = files.filter(f => {
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(SAMPLES_DIR, f), 'utf-8'));
      const url = obj?.data?.url || obj?.url || '';
      return typeof url === 'string' && url.includes(host);
    } catch { return false; }
  });
  if (pickHint) matches = matches.filter(f => f.includes(pickHint));
  if (!matches.length) matches = files; // fallback to any
  // prefer ones containing input[] and tools
matches.sort((a, b) => {
  const aa = fs.readFileSync(path.join(SAMPLES_DIR, a), "utf-8");
  const bb = fs.readFileSync(path.join(SAMPLES_DIR, b), "utf-8");
  const sa = (aa.includes("\"input\"") ? 10 : 0) + (aa.includes("\"tools\"") ? 2 : 0) + (aa.includes("function_call_arguments") ? 1 : 0);
  const sb = (bb.includes("\"input\"") ? 10 : 0) + (bb.includes("\"tools\"") ? 2 : 0) + (bb.includes("function_call_arguments") ? 1 : 0);
  return sb - sa;
});
  return matches[0] || null;
}

async function main() {
  const providerId = process.env.RCC_RESP_PROV || 'fc';
  const pickHint = process.env.RCC_RESP_PICK || '';
  const cfgDoc = findProviderConfig(providerId);
  const prov = extractProviderEntry(cfgDoc, providerId);
  if (!prov) throw new Error('provider entry missing');
  const baseUrl = String(prov.baseUrl || prov.baseURL || '').replace(/\/$/, '');
  const endpoint = String(prov.endpoint || '/responses');
  const apiKey = prov.auth?.apiKey || cfgDoc?.keyVault?.[providerId]?.key1?.value;
  if (!apiKey) throw new Error('no apikey');

  const files = listGoldenRequests();
  if (!files.length) throw new Error('no responses golden requests');
  const chosen = pickGoldenForBaseUrl(files, baseUrl, pickHint);
  if (!chosen) throw new Error('no suitable golden request');
  const sample = JSON.parse(fs.readFileSync(path.join(SAMPLES_DIR, chosen), 'utf-8'));
  const body = sample?.data?.body || sample?.body || sample?.data || sample;
  if (!body || typeof body !== 'object') throw new Error('invalid golden body');
  // Override model if provider specifies one
  const model = prov.model || prov.modelId || prov.defaultModel || body.model;
  body.model = model;
  body.stream = true;

  const httpPath = pathToFileURL(path.join(process.cwd(), 'dist/providers/core/utils/http-client.js')).href;
  const { HttpClient } = await import(httpPath);
  const convPath = pathToFileURL(path.join(process.cwd(), 'sharedmodule/llmswitch-core/dist/sse/sse-to-json/index.js')).href;
  const bridgePath = pathToFileURL(path.join(process.cwd(), 'sharedmodule/llmswitch-core/dist/conversion/responses/responses-openai-bridge.js')).href;
  const { ResponsesSseToJsonConverter } = await import(convPath);
  const { buildChatResponseFromResponses } = await import(bridgePath);

  const headers = {
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'responses-2024-12-17',
    'Authorization': `Bearer ${apiKey}`
  };

  ensureDir(OUT_DIR);
  const base = path.join(OUT_DIR, `${providerId}_replay_${nowStamp()}`);
  const sseLog = `${base}.sse.log`;
  const jsonOut = `${base}.json`;
  const chatOut = `${base}.chat.json`;
  fs.writeFileSync(`${base}.request.json`, JSON.stringify({ url: baseUrl+endpoint, headers, body }, null, 2));

  const client = new HttpClient({ baseUrl, timeout: 300000 });
  const stream = await client.postStream(endpoint, body, { ...headers, Accept: 'text/event-stream' });
  const conv = new ResponsesSseToJsonConverter();
  const json = await conv.convertSseToJson(stream, {
    requestId: path.basename(base),
    model: String(body.model||'unknown'),
    onEvent: (evt) => {
      try {
        fs.appendFileSync(sseLog, `event: ${evt.type}\n`);
        fs.appendFileSync(sseLog, `data: ${JSON.stringify(evt.data)}\n\n`);
      } catch {}
    }
  });
  fs.writeFileSync(jsonOut, JSON.stringify(json, null, 2));
  const chat = buildChatResponseFromResponses(json);
  fs.writeFileSync(chatOut, JSON.stringify(chat, null, 2));
  const tc = chat?.choices?.[0]?.message?.tool_calls || [];
  const ok = Array.isArray(tc) && tc.length > 0;
  console.log('[responses-sse-replay-golden] provider=%s sample=%s tool_calls=%s out=%s', providerId, chosen, ok ? tc.length : 0, chatOut);
}

main().catch(e => { console.error(e); process.exit(1); });
