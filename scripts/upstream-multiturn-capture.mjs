#!/usr/bin/env node
// Orchestrate a multi-turn tool_call flow against upstream Responses via our server's transparent mode.
// 1) Send initial request with tools, stream SSE, capture tool_call ids + arguments
// 2) Send follow-up request with tool_result inputs, stream SSE, and capture final text

import fs from 'node:fs/promises';
import path from 'node:path';

function home() { return process.env.HOME || process.env.USERPROFILE || ''; }

async function readJson(p) { return JSON.parse(await fs.readFile(p, 'utf-8')); }

async function loadMonitor() {
  const p = path.join(home(), '.routecodex', 'monitor.json');
  try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return {}; }
}

function bearerFrom(mon) {
  const t = mon?.transparent || {};
  const token = t.authorization || t.auth?.openai || '';
  if (!token) return null;
  return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

async function postSSE(url, body, headers, captureFile, onEvent) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(headers||{}) }, body: JSON.stringify(body) });
  const ok = res.ok; const status = res.status; const hdrs = Object.fromEntries(res.headers.entries());
  const w = await fs.open(captureFile, 'w');
  try {
    if (!res.body) {
      await w.write(`(no body) status=${status}\n`);
      return { ok, status, headers: hdrs };
    }
    const reader = res.body.getReader();
    const td = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      const s = td.decode(value);
      buf += s;
      await w.write(s);
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      for (const ln of lines) {
        if (ln.startsWith('event:')) {
          const ev = ln.slice(6).trim();
          if (onEvent && typeof onEvent === 'function') { await onEvent({ type: ev }); }
        }
        if (ln.startsWith('data:')) {
          const data = ln.slice(5).trim();
          try {
            const obj = JSON.parse(data);
            if (onEvent) { await onEvent({ data: obj }); }
          } catch { /* ignore */ }
        }
      }
    }
    return { ok, status, headers: hdrs };
  } finally { await w.close(); }
}

async function main() {
  const mon = await loadMonitor();
  const upstream = mon?.transparent?.endpoints?.openai || 'https://www.fakercode.top/v1';
  const auth = bearerFrom(mon);
  const serverBase = 'http://127.0.0.1:5520/v1';
  const headers = { 'X-RC-Upstream-Url': upstream, ...(auth ? { 'X-RC-Upstream-Authorization': auth } : {}) };
  const baseDir = path.join(home(), '.routecodex', 'codex-samples', 'upstream-multiturn', String(Date.now()));
  await fs.mkdir(baseDir, { recursive: true });

  // 1) Initial request: prompt + tools
  const toolSpec = {
    type: 'function',
    function: {
      name: 'shell',
      description: 'execute a shell command',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command']
      }
    }
  };

  const req1 = {
    model: 'gpt-5-codex',
    stream: true,
    input: [
      { role: 'user', content: [ { type: 'input_text', text: '请严格使用工具shell，先执行 echo "ok"，再执行 whoami，并返回结果。' } ] }
    ],
    tools: [ toolSpec ],
    tool_choice: 'required',
    parallel_tool_calls: false
  };
  await fs.writeFile(path.join(baseDir, 'req1.json'), JSON.stringify(req1, null, 2), 'utf-8');
  const sse1 = path.join(baseDir, 'sse1.log');

  const calls = new Map(); // id -> { name, args }
  await postSSE(`${serverBase}/responses`, req1, headers, sse1, async (evt) => {
    const d = evt?.data || {};
    if (d?.type === 'response.tool_call.created') {
      const id = d?.tool_call?.id; const name = d?.tool_call?.name;
      if (id) calls.set(id, { name, args: '' });
    } else if (d?.type === 'response.tool_call.delta') {
      const id = d?.tool_call?.id; const delta = d?.delta?.arguments || '';
      if (id && calls.has(id)) { calls.get(id).args += String(delta); }
    }
  });

  // Build tool_result input for second turn
  const input2 = [];
  for (const [id, spec] of calls.entries()) {
    input2.push({ type: 'tool_result', tool_use_id: id, content: `simulated result for ${spec.name}(${spec.args})` });
  }
  if (input2.length === 0) {
    console.log('[multi-turn] upstream did not produce tool_call.* events; nothing to follow-up.');
    return;
  }

  const req2 = {
    model: 'gpt-5-codex',
    stream: true,
    input: input2,
    tools: [ toolSpec ],
    tool_choice: 'auto',
    parallel_tool_calls: false
  };
  await fs.writeFile(path.join(baseDir, 'req2.json'), JSON.stringify(req2, null, 2), 'utf-8');
  const sse2 = path.join(baseDir, 'sse2.log');
  await postSSE(`${serverBase}/responses`, req2, headers, sse2, null);

  console.log('[multi-turn] capture dir:', baseDir);
}

main().catch(e => { console.error('[multi-turn] fatal', e?.message || String(e)); process.exit(1); });
