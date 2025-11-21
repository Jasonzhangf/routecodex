#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { bridgeOpenAIChatUpstreamToEvents } from '../sharedmodule/llmswitch-core/dist/v2/conversion/streaming/openai-chat-upstream-bridge.js';
import { assertEquivalent } from '../sharedmodule/llmswitch-core/dist/v2/conversion/streaming/stream-equivalence.js';
import { createChatSSEStreamFromChatJson } from '../sharedmodule/llmswitch-core/dist/v2/conversion/streaming/json-to-chat-sse.js';
import { aggregateOpenAIChatSSEToJSON } from '../sharedmodule/llmswitch-core/dist/v2/conversion/streaming/openai-chat-sse-to-json.js';

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

function findProviderRequestById(reqId) {
  const dir = '/Users/fanzhang/.routecodex/codex-samples/openai-chat';
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('_provider-request.json'));
  const cand = files.find(f => f.includes(reqId));
  if (cand) return path.join(dir, cand);
  // fallback: try matching timestamp only (req_XXXXXXXXXXXXX_)
  const stamp = (reqId.match(/\d{13}/) || [])[0];
  if (stamp) {
    const cand2 = files.find(f => f.includes(`req_${stamp}_`));
    if (cand2) return path.join(dir, cand2);
  }
  return null;
}

function toReadable(text) { const r = new Readable({ read() {} }); setImmediate(()=>{ r.push(text); r.push(null); }); return r; }
async function collect(stream) { return await new Promise((resolve)=>{ const arr=[]; stream.on('data', c=>arr.push(String(c))); stream.on('end', ()=> resolve(arr.join(''))); stream.on('error', ()=> resolve(arr.join(''))); }); }

async function main() {
  const reqIdArg = process.argv[2];
  if (!reqIdArg) { console.error('usage: node scripts/shadow-chat-upstream-vs-codec-from-snapshot.mjs <reqId>'); process.exit(1); }
  const cfg = readGLMConfig();
  if (!cfg) { console.error('missing GLM config'); process.exit(1); }

  const prPath = findProviderRequestById(reqIdArg);
  if (!prPath) { console.error('provider-request not found for', reqIdArg); process.exit(2); }
  const pr = JSON.parse(fs.readFileSync(prPath, 'utf-8'));
  const body = pr?.body && typeof pr.body === 'object' ? pr.body : null;
  if (!body) { console.error('invalid provider-request body'); process.exit(3); }
  // Ensure stream
  body.stream = true;

  const url = `${cfg.baseURL.replace(/\/$/,'')}/chat/completions`;
  const headers = { 'content-type':'application/json', 'authorization': `Bearer ${cfg.apiKey}`, 'accept': 'text/event-stream' };

  // Upstream SSE (reference)
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) { console.error('upstream not ok:', res.status); process.exit(4); }
  const upstreamText = await res.text();

  // Core synthetic SSE: aggregate -> synth
  const chatJson = await aggregateOpenAIChatSSEToJSON(toReadable(upstreamText));
  const sseSynth = await createChatSSEStreamFromChatJson(chatJson, { requestId: `shadow_${Date.now()}` });

  const eq = await assertEquivalent(
    bridgeOpenAIChatUpstreamToEvents(toReadable(upstreamText)),
    bridgeOpenAIChatUpstreamToEvents(sseSynth)
  );
  console.log('[chat-shadow-from-snapshot]', path.basename(prPath), 'equivalent:', eq.equal);
  if (!eq.equal) console.log('[chat-shadow-from-snapshot] diff:', JSON.stringify(eq));
}

main().catch((e)=>{ console.error(e); process.exit(1); });

