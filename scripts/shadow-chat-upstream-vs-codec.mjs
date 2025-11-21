#!/usr/bin/env node
import fs from 'node:fs';
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

function toReadable(text) { const r = new Readable({ read() {} }); setImmediate(()=>{ r.push(text); r.push(null); }); return r; }
async function collect(stream) { return await new Promise((resolve)=>{ const arr=[]; stream.on('data', c=>arr.push(String(c))); stream.on('end', ()=> resolve(arr.join(''))); stream.on('error', ()=> resolve(arr.join(''))); }); }

async function doOne(payload) {
  const cfg = readGLMConfig();
  if (!cfg) { console.error('missing GLM config'); process.exit(1); }
  const url = `${cfg.baseURL.replace(/\/$/,'')}/chat/completions`;
  const headers = { 'content-type':'application/json', 'authorization': `Bearer ${cfg.apiKey}`, 'accept': 'text/event-stream' };
  const body = { model: cfg.model, ...payload, stream: true };

  // 直通：从上游拿到 SSE 文本
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) { console.error('upstream not ok:', res.status); process.exit(2); }
  const upstreamText = await res.text();

  // 合成：聚合为 chat JSON → 再合成 SSE
  const chatJson = await aggregateOpenAIChatSSEToJSON(toReadable(upstreamText));
  const sseSynth = await createChatSSEStreamFromChatJson(chatJson, { requestId: `shadow_${Date.now()}` });

  // 对比等价性（忽略内容差异，关注 roles/finish/tool_calls）
  const eq = await assertEquivalent(
    bridgeOpenAIChatUpstreamToEvents(toReadable(upstreamText)),
    bridgeOpenAIChatUpstreamToEvents(sseSynth)
  );
  return { eq, upstreamText, chatJson };
}

async function main() {
  // 文本用例
  {
    const text = '请用简体中文打个招呼（chat影子对比）';
    const { eq } = await doOne({ messages: [{ role: 'user', content: text }] });
    console.log('[chat-shadow][text] equivalent:', eq.equal, eq.equal ? '' : JSON.stringify(eq));
  }
  // 工具用例
  {
    const payload = {
      messages: [{ role: 'user', content: '请调用 search 工具查询 hello（chat影子对比）' }],
      tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } }]
    };
    const { eq } = await doOne(payload);
    console.log('[chat-shadow][tool] equivalent:', eq.equal, eq.equal ? '' : JSON.stringify(eq));
  }
}

main().catch((e)=>{ console.error(e); process.exit(1); });
