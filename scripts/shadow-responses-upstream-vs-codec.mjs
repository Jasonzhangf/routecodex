#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createResponsesSSEFromResponsesJson, aggregateOpenAIResponsesSSEToJSON } from '../dist/modules/llmswitch/bridge.js';
import { Stream } from 'openai/core';

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

function toReadable(text) { const r = new Readable({ read() {} }); setImmediate(()=>{ r.push(text); r.push(null); }); return r; }

function canonFns(j) {
  const out = Array.isArray(j?.output) ? j.output : [];
  const fns = out.filter((o) => o?.type === 'function_call').map((o) => ({ name: o?.name, args: o?.arguments }));
  const seen = new Set(); const uniq = [];
  for (const f of fns) { const k = `${f.name}|${f.args}`; if (!seen.has(k)) { seen.add(k); uniq.push(f); } }
  return uniq.sort((a,b) => (a.name+a.args).localeCompare(b.name+b.args));
}

function canonText(j) { try { const out = Array.isArray(j?.output) ? j.output : []; const msg = out.find((o) => o?.type === 'message'); const parts = Array.isArray(msg?.content) ? msg.content : []; const txt = parts.find((p) => p?.type === 'output_text'); return String(txt?.text || ''); } catch { return ''; } }

async function collect(stream) { return await new Promise((resolve)=>{ const arr=[]; stream.on('data', c=>arr.push(String(c))); stream.on('end', ()=> resolve(arr.join(''))); stream.on('error', ()=> resolve(arr.join(''))); }); }

async function main() {
  const cfg = readC4MConfig();
  if (!cfg) { console.error('missing c4m config'); process.exit(1); }

  const url = `${cfg.baseURL.replace(/\/$/,'')}/responses`;
  const snap = latestProviderRequest();
  const baseBody = (snap?.body && typeof snap.body === 'object') ? { ...snap.body } : { model: cfg.model, input: [ { role: 'user', content: [ { type: 'input_text', text: '用一句话介绍RouteCodex（影子对比）' } ] } ] };
  const body = dropMaxTokenVariants({ ...baseBody, stream: true });

  // 直通：上游 SSE 原始文本
  const headers = { 'content-type':'application/json', 'authorization': `Bearer ${cfg.apiKey}`, 'OpenAI-Beta': 'responses-2024-12-17', 'accept': 'text/event-stream' };
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) { console.error('upstream not ok:', res.status); process.exit(2); }
  const upstreamText = await res.text();

  // codec 合成：聚合 → JSON → 合成为规范化 SSE
  const upstreamJSON = await aggregateOpenAIResponsesSSEToJSON(toReadable(upstreamText));
  const synthSSE = await createResponsesSSEFromResponsesJson(upstreamJSON, { requestId: `shadow_${Date.now()}` });
  const synthText = await collect(synthSSE);

  // 再次聚合，做 JSON 层面对齐校验
  const synthJSON = await aggregateOpenAIResponsesSSEToJSON(toReadable(synthText));

  // 让 OpenAI SDK 解析我们合成的 SSE，验证 SDK 接入兼容性
  try {
    const resp = new Response(synthText, { headers: { 'Content-Type': 'text/event-stream' } });
    const sdkStream = Stream.fromSSEResponse(resp, new AbortController());
    for await (const _ of sdkStream) { /* drain */ }
    console.log('[shadow] SDK parse (synth SSE): ok');
  } catch (e) {
    console.log('[shadow] SDK parse (synth SSE): FAILED', e?.message || String(e));
  }

  const textEq = upstreamText.trim() === synthText.trim();
  const fnEq = JSON.stringify(canonFns(upstreamJSON)) === JSON.stringify(canonFns(synthJSON));
  const outEq = canonText(upstreamJSON) === canonText(synthJSON);

  console.log('--- Shadow Compare (Responses) ---');
  console.log('SSE text equal:', textEq);
  console.log('Function calls equal:', fnEq);
  console.log('Output text equal:', outEq);
  if (!fnEq || !outEq) {
    console.log('diff.fn.upstream =', JSON.stringify(canonFns(upstreamJSON)));
    console.log('diff.fn.synth    =', JSON.stringify(canonFns(synthJSON)));
    console.log('diff.text.upstream.len =', canonText(upstreamJSON).length);
    console.log('diff.text.synth.len    =', canonText(synthJSON).length);
  }
}

main().catch((e)=>{ console.error(e); process.exit(1); });
