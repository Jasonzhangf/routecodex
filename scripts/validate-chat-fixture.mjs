#!/usr/bin/env node
import fs from 'node:fs';
import { Readable } from 'node:stream';

function toLines(file) {
  const raw = fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n');
  return raw.split('\n').filter(Boolean);
}

function toReadable(lines) {
  const r = new Readable({ read() {} });
  setImmediate(() => { for (const l of lines) r.push(l + '\n'); r.push(null); });
  return r;
}

// Minimal aggregator inline (SSE -> Chat JSON)
async function aggregateChatSSEToJson(readable) {
  let id = '', model = 'unknown', created = undefined;
  let role = 'assistant', content = '', finish = null;
  const tools = new Map();
  const buf = await streamToString(readable);
  for (const line of buf.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') break;
    let obj; try { obj = JSON.parse(payload); } catch { continue; }
    if (typeof obj?.id === 'string') id = obj.id;
    if (typeof obj?.model === 'string') model = obj.model;
    if (typeof obj?.created === 'number') created = obj.created;
    const choices = Array.isArray(obj?.choices) ? obj.choices : [];
    for (const ch of choices) {
      if (ch?.finish_reason !== undefined) finish = ch.finish_reason;
      const delta = ch?.delta || {};
      if (typeof delta?.role === 'string') role = delta.role;
      if (typeof delta?.content === 'string') content += delta.content;
      const tcs = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
      for (const tc of tcs) {
        const cid = typeof tc?.id === 'string' ? tc.id : 'call_' + ((tc?.index ?? 0) + '');
        const prev = tools.get(cid) || { id: cid, name: '', args: [], index: Number(tc?.index ?? 0) };
        const fn = tc?.function || {};
        if (typeof fn?.name === 'string') prev.name += fn.name;
        if (typeof fn?.arguments === 'string') prev.args.push(fn.arguments);
        tools.set(cid, prev);
      }
    }
  }
  const arr = Array.from(tools.values());
  const tool_calls = arr.length ? arr.map(t => ({ id: t.id, type: 'function', function: { name: t.name || 'tool', arguments: t.args.join('') } })) : undefined;
  return {
    id: id || `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created, model,
    choices: [{ index: 0, message: { role, content: tool_calls ? null : content, ...(tool_calls ? { tool_calls } : {}) }, finish_reason: finish ?? (tool_calls ? 'tool_calls' : 'stop') }]
  };
}

// Read stream to string
function streamToString(readable) {
  return new Promise((resolve) => {
    let s = '';
    readable.setEncoding('utf-8');
    readable.on('data', (c) => s += c);
    readable.on('end', () => resolve(s));
    readable.on('error', () => resolve(s));
  });
}

// Event bridge (reuse dist parser)
const { OpenAISSEParser } = await import('../sharedmodule/llmswitch-core/dist/v2/conversion/streaming/openai-sse-parser.js');
function bridgeToEvents(readable) {
  const queue = [];
  let done = false, resolve;
  const onChunk = (obj) => {
    // Normalize to internal events
    const events = [];
    try {
      if (typeof obj?.id === 'string' || typeof obj?.created === 'number' || typeof obj?.model === 'string') {
        events.push({ type: 'meta', id: obj.id, created: obj.created, model: obj.model });
      }
      const chs = Array.isArray(obj?.choices) ? obj.choices : [];
      for (const ch of chs) {
        const idx = Number(ch?.index ?? 0);
        if (ch?.finish_reason !== undefined) events.push({ type: 'finish', index: idx, finishReason: ch.finish_reason });
        const d = ch?.delta || {};
        if (typeof d?.role === 'string') events.push({ type: 'choice-delta', index: idx, role: d.role });
        if (typeof d?.content === 'string') events.push({ type: 'choice-delta', index: idx, content: d.content });
        const tcs = Array.isArray(d?.tool_calls) ? d.tool_calls : [];
        for (const tc of tcs) {
          const fn = tc?.function || {};
          events.push({ type: 'tool-call-delta', index: Number(tc?.index ?? 0), callId: tc?.id, nameDelta: fn?.name, argumentsDelta: fn?.arguments });
        }
      }
    } catch {}
    for (const ev of events) {
      if (resolve) { const r = resolve; resolve = null; r({ value: ev, done: false }); }
      else queue.push(ev);
    }
  };
  const onDone = () => { done = true; if (resolve) { const r = resolve; resolve = null; r({ value: undefined, done: true }); } };
  const parser = new OpenAISSEParser(readable, onChunk, onDone);
  parser.start();
  return {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      if (queue.length) return { value: queue.shift(), done: false };
      if (done) return { value: undefined, done: true };
      return await new Promise((res) => { resolve = res; });
    }
  };
}

// Event equivalence
async function assertEquivalent(A, B) {
  const sa = await fold(A); const sb = await fold(B);
  const keys = new Set([...Object.keys(sa.contentByChoice), ...Object.keys(sb.contentByChoice)].map(Number));
  for (const i of keys) {
    if ((sa.contentByChoice[i]||'') !== (sb.contentByChoice[i]||'')) return { equal:false, reason:`content mismatch ${i}` };
    if ((sa.roleByChoice[i]||'assistant') !== (sb.roleByChoice[i]||'assistant')) return { equal:false, reason:`role mismatch ${i}` };
    if ((sa.finishByChoice[i]??null) !== (sb.finishByChoice[i]??null)) return { equal:false, reason:`finish mismatch ${i}` };
  }
  if (Object.keys(sa.tools).length !== Object.keys(sb.tools).length) return { equal:false, reason:'tool count mismatch' };
  return { equal:true };
}

async function fold(stream) {
  const s = { contentByChoice:{}, roleByChoice:{}, finishByChoice:{}, tools:{} };
  for await (const ev of stream) {
    if (ev.type === 'choice-delta' && ev.content) {
      s.contentByChoice[ev.index] = (s.contentByChoice[ev.index]||'') + ev.content;
    }
    if (ev.type === 'choice-delta' && ev.role) s.roleByChoice[ev.index] = ev.role;
    if (ev.type === 'finish') s.finishByChoice[ev.index] = ev.finishReason;
    if (ev.type === 'tool-call-delta') {
      const id = ev.callId || String(ev.index);
      const t = s.tools[id] || { name:'', args:'' };
      if (ev.nameDelta) t.name += ev.nameDelta;
      if (ev.argumentsDelta) t.args += ev.argumentsDelta;
      s.tools[id] = t;
    }
  }
  return s;
}

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node scripts/validate-chat-fixture.mjs <file.sse>'); process.exit(1); }
  const lines = toLines(file);
  const upstream = toReadable(lines);
  const aggregated = await aggregateChatSSEToJson(toReadable(lines));
  const { createChatSSEStreamFromChatJson } = await import('../sharedmodule/llmswitch-core/dist/v2/conversion/streaming/json-to-chat-sse.js');
  const synth = createChatSSEStreamFromChatJson(aggregated, { requestId: 'validate' });
  const eq = await assertEquivalent(bridgeToEvents(upstream), bridgeToEvents(synth));
  console.log(eq.equal ? 'OK' : ('DIFF: ' + (eq.reason||'')));
  process.exitCode = eq.equal ? 0 : 2;
}

main().catch((e) => { console.error('ERR', e); process.exit(1); });

