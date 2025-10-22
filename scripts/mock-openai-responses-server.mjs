#!/usr/bin/env node
// Minimal mock OpenAI Responses server for dry-run replay
// Usage:
//   node scripts/mock-openai-responses-server.mjs --port 7002 --file /path/to/responses.json [--stream false]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

function parseArgs() {
  const out = { port: 7002, file: '', stream: undefined };
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
  console.error('mock-openai-responses-server: missing --file <responses.json>');
  process.exit(2);
}

const payload = readJSON(path.resolve(cfg.file));

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/v1/responses') {
    let buf = '';
    req.on('data', chunk => { buf += chunk.toString('utf-8'); });
    req.on('end', () => {
      try {
        const body = buf ? JSON.parse(buf) : {};
        const wantStream = typeof cfg.stream === 'boolean' ? cfg.stream : body?.stream === true;
        if (wantStream) {
          // Serve minimal Responses SSE: created + completed
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
          const created = { type: 'response.created', response: { ...(payload || {}), status: 'in_progress' } };
          res.write(`event: response.created\n`);
          res.write(`data: ${JSON.stringify(created)}\n\n`);
          const completed = { type: 'response.completed', response: { ...(payload || {}), status: 'completed' } };
          res.write(`event: response.completed\n`);
          res.write(`data: ${JSON.stringify(completed)}\n\n`);
          res.end();
          return;
        }
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
  console.log(`[mock-openai-responses] listening on :${cfg.port}, file=${path.basename(cfg.file)}`);
});

