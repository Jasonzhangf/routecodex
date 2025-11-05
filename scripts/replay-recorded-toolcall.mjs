#!/usr/bin/env node
// End-to-end tool-call replay using a recorded OpenAI Chat raw request
// Usage:
//   node scripts/replay-recorded-toolcall.mjs [--raw <path/to/_raw-request.json>] [--port <n>]
// Behavior:
//   - Starts the RouteCodex server if not healthy
//   - Sends a streaming Chat request using the recorded body (with stream:true)
//   - Captures the first tool_calls SSE chunk
//   - Executes supported tools locally (shell, update_plan minimal)
//   - Sends a second non-stream request with assistant tool_calls + tool result
//   - Prints a one-line summary of success

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEV_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { raw: '', port: 0 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--raw') { out.raw = String(argv[++i] || ''); continue; }
    if (a === '--port') { out.port = Number(argv[++i] || '0'); continue; }
  }
  return out;
}

async function readJson(p) {
  const raw = await fs.readFile(p, 'utf-8');
  return JSON.parse(raw);
}

async function sleep(ms) { await new Promise(r => setTimeout(r, ms)); }

async function getPortFromConfig() {
  try {
    const envPath = process.env.ROUTECODEX_CONFIG_PATH || process.env.ROUTECODEX_CONFIG || '';
    const candidate = envPath || path.join(os.homedir(), '.routecodex', 'config.json');
    if (fsSync.existsSync(candidate)) {
      const cfg = await readJson(candidate);
      const p = (cfg && cfg.httpserver && typeof cfg.httpserver.port === 'number') ? cfg.httpserver.port : cfg.port;
      if (typeof p === 'number' && p > 0) return p;
    }
  } catch {}
  return 5520;
}

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    if (!res.ok) return false;
    const j = await res.json().catch(() => null);
    return !!j && (j.status === 'ok' || j.status === 'healthy' || j.status === 'ready');
  } catch { return false; }
}

async function startServerIfNeeded(port) {
  if (await health(port)) return;
  await new Promise((resolve, reject) => {
    const p = spawn('npm', ['-s', 'run', 'start:bg'], { cwd: DEV_ROOT, stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', () => resolve());
  });
  for (let i = 0; i < 60; i++) { if (await health(port)) return; await sleep(500); }
  throw new Error('Server not healthy after start');
}

function pickLatestRaw() {
  const dir = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-chat');
  if (!fsSync.existsSync(dir)) throw new Error(`No snapshot dir: ${dir}`);
  const files = fsSync.readdirSync(dir)
    .filter(f => f.endsWith('_raw-request.json'))
    .map(f => ({ f, mtime: fsSync.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) throw new Error('No *_raw-request.json found');
  return path.join(dir, files[0].f);
}

async function readStreamingToolCall(port, body) {
  const ctrl = new AbortController();
  const to = setTimeout(() => { try { ctrl.abort(); } catch {} }, 60000);
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
    body: JSON.stringify({ ...body, stream: true }),
    signal: ctrl.signal
  });
  if (!res.ok || !res.body) throw new Error(`SSE request failed: ${res.status}`);
  const reader = res.body.getReader();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString('utf-8');
      // Look for a data: line with tool_calls
      const lines = buf.split(/\r?\n/);
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6);
        if (jsonStr === '[DONE]') continue;
        let obj; try { obj = JSON.parse(jsonStr); } catch { continue; }
        const tc = obj?.choices?.[0]?.delta?.tool_calls;
        if (Array.isArray(tc) && tc.length > 0) {
          clearTimeout(to);
          return { chunk: obj, toolCall: tc[0] };
        }
      }
      // retain only the last few KB
      if (buf.length > 100_000) buf = buf.slice(-50_000);
    }
  } finally { clearTimeout(to); }
  throw new Error('No tool_calls observed in SSE');
}

async function runTool(toolCall) {
  const name = String(toolCall?.function?.name || '');
  const argsStr = String(toolCall?.function?.arguments || '');
  let args = {};
  try { args = JSON.parse(argsStr); } catch {}
  if (name === 'shell') {
    const cmd = args.command;
    if (!cmd) return { output: 'no command' };
    if (Array.isArray(cmd)) {
      return await execSpawn(cmd[0], cmd.slice(1));
    } else if (typeof cmd === 'string') {
      return await execShell(cmd);
    }
    return { output: 'unsupported command format' };
  }
  if (name === 'update_plan') {
    return { status: 'ok', note: 'update_plan acknowledged' };
  }
  return { error: 'unsupported_tool', name };
}

async function execSpawn(bin, args) {
  return await new Promise(resolve => {
    const p = spawn(bin, Array.isArray(args) ? args : [], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => out += String(d));
    p.stderr.on('data', d => err += String(d));
    p.on('close', code => resolve({ code, stdout: out, stderr: err }));
    p.on('error', e => resolve({ error: String(e) }));
  });
}

async function execShell(cmd) {
  return await new Promise(resolve => {
    const p = spawn('bash', ['-lc', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => out += String(d));
    p.stderr.on('data', d => err += String(d));
    p.on('close', code => resolve({ code, stdout: out, stderr: err }));
    p.on('error', e => resolve({ error: String(e) }));
  });
}

function buildAssistantToolMsg(tc) {
  return {
    role: 'assistant',
    tool_calls: [
      {
        id: tc.id || `call_${Date.now()}`,
        type: 'function',
        function: {
          name: tc?.function?.name || 'unknown',
          arguments: String(tc?.function?.arguments || '{}')
        }
      }
    ]
  };
}

function buildToolResultMsg(tc, toolResultObj) {
  return {
    role: 'tool',
    tool_call_id: tc.id || `call_${Date.now()}`,
    content: JSON.stringify(toolResultObj)
  };
}

async function main() {
  const { raw, port: cliPort } = parseArgs(process.argv);
  const port = cliPort > 0 ? cliPort : await getPortFromConfig();
  await startServerIfNeeded(port);
  const rawPath = raw || pickLatestRaw();
  const recorded = await readJson(rawPath);
  const body = recorded?.body;
  if (!body || !Array.isArray(body.messages)) throw new Error('Invalid raw-request body');

  console.log(`[replay] Using raw-request: ${rawPath}`);
  const { toolCall } = await readStreamingToolCall(port, body);
  const toolName = toolCall?.function?.name || 'unknown';
  console.log(`[replay] tool_call received: ${toolName}`);
  const toolResult = await runTool(toolCall);
  console.log(`[replay] tool executed: ${toolName} -> ${Object.keys(toolResult).join(',')}`);

  const assistantMsg = buildAssistantToolMsg(toolCall);
  const toolMsg = buildToolResultMsg(toolCall, toolResult);
  const second = {
    model: body.model,
    tools: body.tools,
    messages: [...body.messages, assistantMsg, toolMsg]
  };

  const res2 = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(second)
  });
  const j2 = await res2.json().catch(() => null);
  if (!res2.ok) {
    console.error('[replay] second call failed', j2 || res2.statusText);
    process.exit(2);
  }
  const finish = j2?.choices?.[0]?.finish_reason || 'unknown';
  const content = j2?.choices?.[0]?.message?.content || null;
  const nextTool = j2?.choices?.[0]?.message?.tool_calls || null;
  console.log('[replay] second call ok:', { finish, content: content ? String(content).slice(0, 160) : null, nextTool: Array.isArray(nextTool) ? nextTool[0]?.function?.name : null });
}

main().catch(err => { console.error(err); process.exit(1); });

