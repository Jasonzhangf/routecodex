#!/usr/bin/env node
// Replay all captured raw-request_req_*.json against local /v1/responses to regenerate logs
// Usage: node scripts/responses-batch-replay.mjs [--host 127.0.0.1] [--port 5520] [--limit N]

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

function parseArgs() {
  const args = process.argv.slice(2);
  const cfg = { host: '127.0.0.1', port: 5520, limit: 0 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '--host' || a === '-H') && args[i+1]) cfg.host = args[++i];
    else if ((a === '--port' || a === '-p') && args[i+1]) cfg.port = Number(args[++i]) || 5520;
    else if ((a === '--limit' || a === '-n') && args[i+1]) cfg.limit = Number(args[++i]) || 0;
  }
  return cfg;
}

function listRaw(dir, limit) {
  if (!fs.existsSync(dir)) return [];
  let files = fs.readdirSync(dir).filter(f => /^raw-request_req_.*\.json$/.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => a.t - b.t) // older first
    .map(x => path.join(dir, x.f));
  if (limit > 0) files = files.slice(0, limit);
  return files;
}

function postJSON({ host, port, body }) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body || {});
    const req = http.request({ host, port, path: '/v1/responses', method: 'POST', headers: {
      'content-type': 'application/json',
      'accept': 'application/json',
      'OpenAI-Beta': 'responses-2024-12-17',
      'content-length': Buffer.byteLength(payload)
    }}, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (e) => resolve({ status: 0, error: String(e) }));
    req.write(payload); req.end();
  });
}

async function main() {
  const cfg = parseArgs();
  const dir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.routecodex', 'codex-samples', 'anth-replay');
  const files = listRaw(dir, cfg.limit);
  if (files.length === 0) { console.log('[batch-replay] no raw-request files found'); process.exit(0); }
  console.log(`[batch-replay] host=${cfg.host} port=${cfg.port} files=${files.length}`);
  let ok = 0, fail = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    const body = raw?.body || raw || {};
    body.stream = false; // enforce non-stream to simplify
    try {
      const res = await postJSON({ host: cfg.host, port: cfg.port, body });
      const good = res.status >= 200 && res.status < 300;
      if (good) ok++; else fail++;
      if ((i+1) % 25 === 0 || !good) {
        console.log(`[batch-replay] ${i+1}/${files.length} status=${res.status} file=${path.basename(f)}`);
      }
    } catch (e) {
      fail++;
      console.log(`[batch-replay] ${i+1}/${files.length} error=${e?.message || String(e)} file=${path.basename(f)}`);
    }
  }
  console.log(JSON.stringify({ total: files.length, ok, fail }, null, 2));
}

main().catch(e => { console.error('[batch-replay] failed:', e?.message || String(e)); process.exit(2); });

