#!/usr/bin/env node
// Minimal mock Anthropic server for dry-run replay
// Usage:
//   node scripts/mock-anthropic-server.mjs --port 7001 --file /path/to/messages.json [--stream false]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

function parseArgs() {
  const out = { port: 7001, file: '', stream: undefined };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' && argv[i+1]) out.port = Number(argv[++i]);
    else if (a === '--file' && argv[i+1]) out.file = argv[++i];
    else if (a === '--stream' && argv[i+1]) out.stream = (argv[++i] || '').toLowerCase() === 'true';
  }
  return out;
}

function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }

const cfg = parseArgs();
if (!cfg.file || !fs.existsSync(path.resolve(cfg.file))) {
  console.error('mock-anthropic-server: missing --file <messages.json>');
  process.exit(2);
}

const payload = readJSON(path.resolve(cfg.file));

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/v1/messages') {
    let buf = '';
    req.on('data', chunk => { buf += chunk.toString('utf-8'); });
    req.on('end', () => {
      try {
        const body = buf ? JSON.parse(buf) : {};
        const wantStream = typeof cfg.stream === 'boolean' ? cfg.stream : body?.stream === true;
        if (wantStream) {
          // For dry-run simplicity: serve a single JSON message event, then [DONE]
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
          const ev = { type: 'message_start', message: { id: payload?.id || `msg_${Date.now()}`, model: payload?.model || body?.model || 'anthropic', role: 'assistant' } };
          res.write(`event: message_start\n`);
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
          const ev2 = { type: 'message_delta', delta: { stop_reason: payload?.stop_reason || 'end_turn' } };
          res.write(`event: message_delta\n`);
          res.write(`data: ${JSON.stringify(ev2)}\n\n`);
          res.write(`data: [DONE]\n\n`);
          res.end();
          return;
        }
        // Non-stream JSON echo
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(e?.message || e) } }));
      }
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(cfg.port, () => {
  console.log(`[mock-anthropic] listening on :${cfg.port}, file=${path.basename(cfg.file)}`);
});

