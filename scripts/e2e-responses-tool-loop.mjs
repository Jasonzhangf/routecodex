#!/usr/bin/env node
// End-to-end Responses tool-loop test (server + client, single script)
// - Spawns RouteCodex server in bg on a test port
// - Sends a Responses request (with a simple echo tool)
// - Consumes SSE named events; when required_action arrives, executes the tool
// - Submits tool outputs to /v1/responses/:id/submit_tool_outputs and continues until done
//
// Notes:
// - Requires local networking permissions to 127.0.0.1
// - Uses only the Responses wire (no Chat conversion on client side)

import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';

const BASE = 'http://127.0.0.1';
const PORT = Number(process.env.RCC_E2E_PORT || 5523);
const BASE_URL = `${BASE}:${PORT}/v1`;

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function sseRequest(url, body){
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + (u.search||''),
      method: 'POST',
      headers: {
        'Accept': 'text/event-stream',
        'Content-Type': 'application/json'
      }
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
    resolve(req);
  });
}

async function* consumeSSE(res){
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res){
    const s = typeof chunk === 'string' ? chunk : decoder.decode(chunk);
    buf += s;
    while (true){
      const idx = buf.indexOf('\n\n');
      if (idx < 0) break;
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      yield frame;
    }
  }
}

function parseEventFrame(frame){
  const lines = frame.split('\n');
  let event = 'message';
  let data = '';
  for (const ln of lines){
    if (ln.startsWith(':')) return { event: 'comment', data: ln.slice(1).trim() };
    if (ln.startsWith('event:')) event = ln.slice(6).trim();
    if (ln.startsWith('data:')) data += (data ? '\n' : '') + ln.slice(5).trim();
  }
  return { event, data };
}

async function startServer(){
  const root = process.cwd();
  // Ensure a merged-config for test port exists by copying 5520 variant if present
  try {
    const fsn = await import('node:fs');
    const p5520 = path.join(root, 'config', 'merged-config.5520.json');
    const pTest = path.join(root, 'config', `merged-config.${PORT}.json`);
    const src = fsn.existsSync(p5520) ? p5520 : pTest;
    if (fsn.existsSync(src)) {
      const raw = await fs.readFile(src, 'utf-8');
      const j = JSON.parse(raw);
      try { if (j.httpserver && typeof j.httpserver === 'object') j.httpserver.port = PORT; } catch {}
      try { if (j.modules && j.modules.httpserver && j.modules.httpserver.config) j.modules.httpserver.config.port = PORT; } catch {}
      try {
        const pipes = Array.isArray(j.pipelines) ? j.pipelines : [];
        for (const p of pipes) {
          if (p && p.modules && p.modules.provider && p.modules.provider.config) {
            // Ensure providerType exists for V2 provider factory
            if (!p.modules.provider.config.providerType) {
              // Heuristic: if baseUrl contains 'bigmodel.cn', treat as 'glm'; otherwise 'openai'
              const bu = String(p.modules.provider.config.baseUrl || p.modules.provider.config.baseURL || '');
              p.modules.provider.config.providerType = bu.includes('bigmodel.cn') ? 'glm' : 'openai';
            }
          }
        }
        j.pipelines = pipes;
      } catch {}
      await fs.writeFile(pTest, JSON.stringify(j, null, 2), 'utf-8');
      console.log(`[e2e] wrote merged-config.${PORT}.json with port=${PORT}`);
    }
  } catch { /* ignore */ }
  const env = {
    ...process.env,
    ROUTECODEX_PORT: String(PORT),
    ROUTECODEX_CONFIG_PATH: path.join(root, 'config', 'config.json'),
    RCC_RESPONSES_FILTERS_OFF: '1',
    ROUTECODEX_STREAM_PRE_HEARTBEAT: '0',
    RCC_R2C_COALESCE_MS: '0'
  };
  const child = spawn(process.execPath, ['dist/index.js'], { stdio: ['ignore','pipe','pipe'], env });
  child.stdout.on('data', d => process.stdout.write(String(d)));
  child.stderr.on('data', d => process.stderr.write(String(d)));
  await sleep(1500);
  return child;
}

async function waitHealth(){
  for (let i=0;i<30;i++){
    try {
      const res = await fetch(`${BASE}:${PORT}/health`).catch(()=>null);
      if (res && res.ok) return true;
    } catch {}
    await sleep(300);
  }
  return false;
}

async function main(){
  console.log(`[e2e] starting server on ${PORT}`);
  const srv = await startServer();
  const healthy = await waitHealth();
  if (!healthy){
    console.error('[e2e] server not healthy');
    try { srv.kill('SIGKILL'); } catch {}
    process.exit(2);
  }

  // Round 1: ask tool
  const payload = {
    model: 'glm-4.6',
    input: [ { role:'user', content:[ { type:'input_text', text:'调用 echo 工具，参数 {"text":"ping"}' } ] } ],
    tools: [ { type:'function', name:'echo', parameters:{ type:'object', properties:{ text:{ type:'string' } }, required:['text'] } } ],
    stream: true
  };

  console.log('[e2e] POST /v1/responses');
  const res = await fetch(`${BASE_URL}/responses`, {
    method: 'POST',
    headers: { 'Accept':'text/event-stream', 'Content-Type':'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok){
    console.error('[e2e] request failed', res.status, await res.text());
    try { srv.kill('SIGKILL'); } catch {}
    process.exit(2);
  }

  let responseId = '';
  const toolCalls = [];
  for await (const frame of consumeSSE(res.body)){
    const ev = parseEventFrame(frame);
    if (ev.event === 'comment') continue;
    if (ev.event === 'message' && ev.data === '[DONE]') break;
    if (!ev.data) continue;
    try{
      const data = JSON.parse(ev.data);
      if (ev.event === 'response.created') responseId = String(data?.response?.id||'');
      if (ev.event === 'response.required_action'){
        const tc = (data?.required_action?.submit_tool_outputs?.tool_calls)||[];
        for (const c of tc) toolCalls.push(c);
        break; // proceed to submit tool outputs
      }
    }catch{/* ignore */}
  }

  if (!responseId){ console.error('[e2e] no responseId'); try { srv.kill('SIGKILL'); } catch {}; process.exit(2); }
  if (toolCalls.length === 0){ console.error('[e2e] no tool calls emitted'); try { srv.kill('SIGKILL'); } catch {}; process.exit(2); }
  console.log('[e2e] responseId', responseId, 'tool_calls', toolCalls.length);

  // Execute tools locally and submit outputs
  const outputs = toolCalls.map(c => ({ tool_call_id: String(c.id||c.call_id||''), output: (()=>{ try { const a = JSON.parse(c.function?.arguments||'{}'); return String(a?.text || JSON.stringify(a)); } catch { return String(c.function?.arguments||''); } })() }));
  console.log('[e2e] submit tool_outputs', outputs);
  const res2 = await fetch(`${BASE_URL}/responses/${encodeURIComponent(responseId)}/submit_tool_outputs`, {
    method: 'POST',
    headers: { 'Accept':'text/event-stream', 'Content-Type':'application/json' },
    body: JSON.stringify({ tool_outputs: outputs, stream: true })
  });
  if (!res2.ok){ console.error('[e2e] submit failed', res2.status, await res2.text()); try{ srv.kill('SIGKILL'); }catch{}; process.exit(2); }

  let completed = false, done = false, textLen = 0;
  for await (const frame of consumeSSE(res2.body)){
    const ev = parseEventFrame(frame);
    if (ev.event === 'comment') continue;
    if (ev.event === 'message' && ev.data === '[DONE]') break;
    if (!ev.data) continue;
    try{
      const data = JSON.parse(ev.data);
      if (ev.event === 'response.output_text.delta') textLen += String(data?.delta||'').length;
      if (ev.event === 'response.completed') completed = true;
      if (ev.event === 'response.done') done = true;
    }catch{/* ignore */}
  }
  console.log('[e2e] next round completed=', completed, 'done=', done, 'textLen=', textLen);

  try { srv.kill('SIGKILL'); } catch {}
  if (!completed || !done){ process.exit(2); }
  console.log('[e2e] PASSED');
}

main().catch(e=>{ console.error('[e2e] fatal', e?.message||String(e)); process.exit(2); });
