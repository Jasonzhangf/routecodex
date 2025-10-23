#!/usr/bin/env node
// Dry-run: Replay captured Anthropic request via /v1/messages, using a local mock upstream.
// - Starts mock-anthropic-server with a provided messages JSON
// - Writes ~/.routecodex/monitor.json to enable transparent routing to the mock
// - Posts captured request body to local RC /v1/messages and prints a brief summary
//
// Usage:
//   node scripts/messages-dryrun-replay.mjs \
//     --req ~/.routecodex/codex-samples/anth-replay/raw-request_req_xxx.json \
//     --mock-file /path/to/messages.json \
//     [--port 5520]

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

function parseArgs() {
  const out = { req: '', mockFile: '', port: 5520, timeoutMs: Number(process.env.DRYRUN_TIMEOUT_MS || 30000) };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--req' || a === '-r') && argv[i+1]) out.req = argv[++i];
    else if ((a === '--mock-file' || a === '-f') && argv[i+1]) out.mockFile = argv[++i];
    else if ((a === '--port' || a === '-p') && argv[i+1]) out.port = Number(argv[++i]) || 5520;
    else if ((a === '--timeout' || a === '--timeout-ms') && argv[i+1]) out.timeoutMs = Number(argv[++i]) || out.timeoutMs;
  }
  if (!out.req || !out.mockFile) {
    console.error('Usage: --req <raw-request.json> --mock-file <messages.json> [--port 5520]');
    process.exit(1);
  }
  return out;
}

function readJSON(p) { return JSON.parse(fs.readFileSync(path.resolve(p), 'utf-8')); }

async function writeMonitorTransparent(port) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const p = path.join(home, '.routecodex', 'monitor.json');
  const cfg = fs.existsSync(p) ? readJSON(p) : {};
  const out = {
    ...(cfg || {}),
    mode: 'transparent',
    transparent: {
      ...(cfg?.transparent || {}),
      enabled: true,
      endpoints: { ...(cfg?.transparent?.endpoints || {}), anthropic: `http://127.0.0.1:${port}` },
      timeoutMs: 15000,
    }
  };
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, JSON.stringify(out, null, 2), 'utf-8');
  return p;
}

async function postMessages(rcPort, body, timeoutMs) {
  const url = `http://127.0.0.1:${rcPort}/v1/messages`;
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  const controller = new AbortController();
  const to = setTimeout(() => { try { controller.abort(); } catch {} }, Math.max(1, timeoutMs||30000));
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body || {}), signal: controller.signal });
  } finally {
    clearTimeout(to);
  }
  const txt = await res.text();
  let data = null; try { data = JSON.parse(txt); } catch { /* keep raw */ }
  return { status: res.status, ok: res.ok, data: data ?? { text: txt } };
}

async function main() {
  const args = parseArgs();
  const raw = readJSON(args.req);
  const body = raw?.body || raw;
  // Force non-stream for simple dry-run
  body.stream = false;

  // Start mock server on a random high port
  const mockPort = Math.floor(20000 + Math.random() * 20000);
  const mock = spawn(process.execPath, [ path.resolve('scripts/mock-anthropic-server.mjs'), '--port', String(mockPort), '--file', path.resolve(args.mockFile), '--stream', 'false' ], { stdio: 'inherit' });
  let readyWait = setTimeout(()=>{},0);
  await new Promise(r => { readyWait = setTimeout(r, 600); });

  // Configure monitor.json transparent endpoint for anthropic
  const monitorPath = await writeMonitorTransparent(mockPort);
  console.log(`[dryrun] monitor.json written: ${monitorPath}`);

  // Post to local RC /v1/messages
  const rcPort = args.port;
  const res = await postMessages(rcPort, body, args.timeoutMs);
  console.log(`[dryrun] /v1/messages status=${res.status} ok=${res.ok}`);
  // Print minimal summary (avoid dumping huge body)
  try {
    const content = Array.isArray(res.data?.content) ? res.data.content : [];
    const blocks = content.map(b => b?.type).filter(Boolean);
    console.log(`[dryrun] content blocks: ${blocks.join(', ')}`);
  } catch {}

  // cleanup
  try { mock.kill('SIGTERM'); } catch {}
  // Ensure no lingering mock processes
  setTimeout(() => { try { mock.kill('SIGKILL'); } catch {} }, 250);
}

main().catch(err => { console.error('[dryrun] failed:', err?.stack || String(err)); process.exit(1); });
