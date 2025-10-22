#!/usr/bin/env node
// Dry-run: Replay captured OpenAI Responses request via /v1/responses with a local mock upstream.
// - Starts mock-openai-responses-server with a provided responses JSON
// - Writes ~/.routecodex/monitor.json to enable transparent routing to the mock (OpenAI wire)
// - Optionally restarts local RC with transparent env to ensure passthrough enabled
// - Posts captured request body to local RC /v1/responses and prints a brief summary
//
// Usage:
//   node scripts/responses-dryrun-replay.mjs \
//     --req ~/.routecodex/codex-samples/anth-replay/raw-request_req_xxx.json \
//     --resp ~/.routecodex/codex-samples/anth-replay/responses-final_req_xxx.json \
//     [--port 5520] [--timeout 30000] [--restart yes|no]

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

function parseArgs() {
  const out = { req: '', resp: '', port: 5520, timeoutMs: Number(process.env.DRYRUN_TIMEOUT_MS || 30000), restart: 'no' };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--req' || a === '-r') && argv[i+1]) out.req = argv[++i];
    else if ((a === '--resp' || a === '-f') && argv[i+1]) out.resp = argv[++i];
    else if ((a === '--port' || a === '-p') && argv[i+1]) out.port = Number(argv[++i]) || 5520;
    else if ((a === '--timeout' || a === '--timeout-ms') && argv[i+1]) out.timeoutMs = Number(argv[++i]) || out.timeoutMs;
    else if ((a === '--restart') && argv[i+1]) out.restart = (argv[++i] || '').toLowerCase();
  }
  if (!out.req || !out.resp) {
    console.error('Usage: --req <raw-request.json> --resp <responses.json> [--port 5520] [--timeout 30000] [--restart yes|no]');
    process.exit(1);
  }
  return out;
}

function readJSON(p) { return JSON.parse(fs.readFileSync(path.resolve(p), 'utf-8')); }

async function writeMonitorTransparentOpenAI(port) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const p = path.join(home, '.routecodex', 'monitor.json');
  const cfg = fs.existsSync(p) ? readJSON(p) : {};
  const out = {
    ...(cfg || {}),
    mode: 'transparent',
    transparent: {
      ...(cfg?.transparent || {}),
      enabled: true,
      endpoints: { ...(cfg?.transparent?.endpoints || {}), openai: `http://127.0.0.1:${port}` },
      timeoutMs: 15000,
    }
  };
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, JSON.stringify(out, null, 2), 'utf-8');
  return p;
}

async function postResponses(rcPort, body, timeoutMs) {
  const url = `http://127.0.0.1:${rcPort}/v1/responses`;
  const headers = { 'content-type': 'application/json', 'OpenAI-Beta': 'responses-2024-12-17' };
  const controller = new AbortController();
  const to = setTimeout(() => { try { controller.abort(); } catch {} }, Math.max(1, timeoutMs||30000));
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body || {}), signal: controller.signal });
  } finally { clearTimeout(to); }
  const txt = await res.text();
  let data = null; try { data = JSON.parse(txt); } catch { /* keep raw */ }
  return { status: res.status, ok: res.ok, data: data ?? { text: txt } };
}

async function restartServerWithTransparent() {
  return new Promise((resolve) => {
    const child = spawn(process.env.SHELL || 'bash', ['-lc', 'ROUTECODEX_TRANSPARENT_ROUTING=1 npm run -s start:bg'], { stdio: 'inherit' });
    child.on('exit', () => resolve(void 0));
  });
}

async function main() {
  const args = parseArgs();
  const raw = readJSON(args.req);
  const body = raw?.body || raw; body.stream = false; // simplify: JSON dry-run

  // Start mock responses server
  const mockPort = Math.floor(20000 + Math.random() * 20000);
  const mock = spawn(process.execPath, [ path.resolve('scripts/mock-openai-responses-server.mjs'), '--port', String(mockPort), '--file', path.resolve(args.resp), '--stream', 'false' ], { stdio: 'inherit' });
  await new Promise(r => setTimeout(r, 600));

  // Configure monitor.json for OpenAI endpoint
  const monitorPath = await writeMonitorTransparentOpenAI(mockPort);
  console.log(`[dryrun] monitor.json written: ${monitorPath}`);

  // Optionally restart server with transparent env
  if (args.restart === 'yes' || args.restart === 'true') {
    await restartServerWithTransparent();
  }

  // Post to local RC /v1/responses
  const res = await postResponses(args.port, body, args.timeoutMs);
  console.log(`[dryrun] /v1/responses status=${res.status} ok=${res.ok}`);
  try {
    const output = Array.isArray(res.data?.output) ? res.data.output : [];
    const types = output.map(it => it?.type).filter(Boolean);
    console.log(`[dryrun] output types: ${types.join(', ')}`);
  } catch {}

  try { mock.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { mock.kill('SIGKILL'); } catch {} }, 250);
}

main().catch(err => { console.error('[dryrun] failed:', err?.stack || String(err)); process.exit(1); });

