#!/usr/bin/env node
/**
 * E2E tool-calling test against OpenAI-compatible endpoint.
 * - Starts server via start-verify (bg + timeout)
 * - Forces a tool call to "list_local_files" using tool_choice
 * - Executes the tool locally (lists files under repo CWD) and sends tool result
 * - Prints final assistant message head + HTTP codes
 *
 * Usage:
 *   node scripts/e2e-tools-openai.mjs --config <path> --model <model> [--timeout <sec>]
 */
import fs from 'fs';
import path from 'path';

function parseArgs() {
  const argv = process.argv.slice(2);
  const out = { config: '', model: '', timeout: 120 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--config' || a === '-c') && argv[i+1]) { out.config = argv[++i]; continue; }
    if ((a === '--model' || a === '-m') && argv[i+1]) { out.model = argv[++i]; continue; }
    if ((a === '--timeout' || a === '-t') && argv[i+1]) { out.timeout = Number(argv[++i]) || 120; continue; }
  }
  if (!out.config || !out.model) throw new Error('Usage: --config <path> --model <model> [--timeout <sec>]');
  return out;
}

function listLocalFiles(dir) {
  try {
    const abs = path.resolve(process.cwd(), dir || '.');
    const ents = fs.readdirSync(abs, { withFileTypes: true });
    const files = ents.map(e => (e.isDirectory() ? `[D] ${e.name}` : `[F] ${e.name}`));
    return { ok: true, dir: abs, files };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

async function startServer(config, timeout) {
  const { spawn } = await import('child_process');
  const p = spawn('node', ['scripts/start-verify.mjs', '--config', config, '--timeout', String(timeout), '--mode', 'bg'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const chunks = [];
  await new Promise((resolve) => { p.stdout.on('data', d => chunks.push(String(d))); p.on('close', () => resolve(null)); });
  const text = chunks.join('');
  // Robustly parse the last JSON block printed by start-verify (pretty-printed)
  let json = null;
  try {
    // Try direct parse first
    json = JSON.parse(text);
  } catch {
    // Fallback: find the last '{' and parse from there
    const tryParseFrom = (s) => {
      for (let i = s.lastIndexOf('{'); i >= 0; i = s.lastIndexOf('{', i - 1)) {
        const sub = s.slice(i).trim();
        try { return JSON.parse(sub); } catch {}
      }
      return null;
    };
    json = tryParseFrom(text) || null;
  }
  if (!json || json.ok !== true) {
    return { ok: false, raw: text, json };
  }
  return { ok: true, ...json };
}

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json };
}

async function main() {
  const args = parseArgs();
  const started = await startServer(args.config, args.timeout);
  if (!started.ok) {
    console.log(JSON.stringify({ ok: false, phase: 'start', details: started.json || started.raw }, null, 2));
    process.exit(2);
  }
  const base = `http://${started.host}:${started.port}`;
  const url = `${base}/v1/chat/completions`;
  // Step 1: force tool call
  const tools = [{
    type: 'function',
    function: {
      name: 'list_local_files',
      description: 'List local files under a directory',
      parameters: {
        type: 'object',
        properties: { dir: { type: 'string', description: 'Directory relative to repo root' } },
        required: ['dir']
      }
    }
  }];
  const req1 = {
    model: args.model,
    messages: [
      { role: 'user', content: '请调用工具 list_local_files 列出当前工程根目录下的文件。' }
    ],
    tools,
    tool_choice: { type: 'function', function: { name: 'list_local_files' } },
    stream: false
  };
  const r1 = await postJson(url, req1);
  if (r1.status !== 200 || !r1.json?.choices?.[0]?.message) {
    console.log(JSON.stringify({ ok: false, phase: 'tool_call', status: r1.status, body: r1.text.slice(0, 500), server: started }, null, 2));
    process.exit(3);
  }
  const m1 = r1.json.choices[0].message;
  const tc = Array.isArray(m1.tool_calls) ? m1.tool_calls[0] : null;
  if (!tc || tc.type !== 'function' || !tc.function) {
    console.log(JSON.stringify({ ok: false, phase: 'tool_call', note: 'no_tool_calls', status: r1.status, head: JSON.stringify(m1).slice(0, 300), server: started }, null, 2));
    process.exit(4);
  }
  let argsObj = {}; try { argsObj = JSON.parse(tc.function.arguments || '{}'); } catch {}
  if (!argsObj.dir) argsObj.dir = '.';
  const toolRes = listLocalFiles(argsObj.dir);
  // Step 2: send tool result and get final answer
  const messages = [
    { role: 'user', content: '请调用工具 list_local_files 列出当前工程根目录下的文件。' },
    { role: 'assistant', tool_calls: [tc], content: null },
    { role: 'tool', name: tc.function.name, tool_call_id: tc.id, content: JSON.stringify(toolRes) }
  ];
  const r2 = await postJson(url, { model: args.model, messages, stream: false, tool_choice: 'none' });
  const outMsg = r2.json?.choices?.[0]?.message;
  console.log(JSON.stringify({ ok: r2.status === 200, phase: 'final', status: r2.status, head: String(outMsg?.content || '').slice(0, 300), server: started, log: started.log }, null, 2));
  // cleanup single instance
  try { process.kill(Number(started.pid), 'SIGTERM'); } catch {}
}

main().catch(e => { console.error(JSON.stringify({ ok: false, error: e?.message || String(e) })); process.exit(2); });
