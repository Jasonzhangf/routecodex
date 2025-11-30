#!/usr/bin/env node
// Replay a codex-samples request against a running RouteCodex instance and
// capture the resulting JSON/SSE output for auditing.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BASE_URL = process.env.ROUTECODEX_BASE || 'http://127.0.0.1:5555';
const DEFAULT_API_KEY = process.env.ROUTECODEX_API_KEY || 'routecodex-test';

function usage() {
  console.log(`Usage:
  node scripts/replay-codex-sample.mjs --sample <file> [--label run1] [--base URL] [--key TOKEN]
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { base: DEFAULT_BASE_URL, key: DEFAULT_API_KEY };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--sample') options.sample = args[++i];
    else if (arg === '--label') options.label = args[++i];
    else if (arg === '--base') options.base = args[++i];
    else if (arg === '--key') options.key = args[++i];
    else if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    else { console.error(`Unknown arg: ${arg}`); usage(); process.exit(1); }
  }
  if (!options.sample) { usage(); process.exit(1); }
  return options;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function extractEndpoint(doc) {
  return doc?.data?.url || doc?.endpoint || '/v1/responses';
}

function extractBody(doc) {
  const body = doc?.data?.body;
  if (!body) return undefined;
  if (typeof body.body === 'object') return body.body;
  if (typeof body === 'object') return body;
  if (typeof doc.data.data === 'object') return doc.data.data;
  return undefined;
}

function detectStream(doc, requestBody) {
  if (doc?.data?.meta?.stream === true) return true;
  if (doc?.data?.body?.metadata?.stream === true) return true;
  if (requestBody?.stream === true) return true;
  return false;
}

async function readSse(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Response is not streamable');
  const decoder = new TextDecoder();
  let buffer = '';
  const frames = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      if (chunk) frames.push(chunk);
    }
  }
  buffer += decoder.decode(new Uint8Array(), { stream: false });
  if (buffer.trim()) frames.push(buffer.trim());
  return frames;
}

async function main() {
  const opts = parseArgs();
  const samplePath = path.resolve(opts.sample);
  const sample = readJson(samplePath);
  const requestBody = extractBody(sample);
  if (!requestBody) throw new Error('Sample does not contain request body');
  const endpoint = extractEndpoint(sample);
  const wantsSse = detectStream(sample, requestBody);
  const requestId = sample?.requestId || sample?.data?.meta?.requestId || `sample_${Date.now()}`;
  const label = opts.label || new Date().toISOString().replace(/[:.]/g, '-');
  const baseDir = path.dirname(samplePath);
  const runDir = path.join(baseDir, 'runs', requestId, label);
  ensureDir(runDir);

  const baseUrl = opts.base.replace(/\/$/, '');
  const targetUrl = `${baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': wantsSse ? 'text/event-stream' : 'application/json',
    'Authorization': `Bearer ${opts.key}`,
    'OpenAI-Beta': 'responses-2024-12-17',
    'X-Route-Hint': 'default'
  };

  console.log(`[replay-codex-sample] ${endpoint} → ${targetUrl} (requestId=${requestId})`);

  const res = await fetch(targetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody)
  });

  const meta = {
    endpoint,
    targetUrl,
    wantsSse,
    status: res.status,
    statusText: res.statusText,
    headers: Object.fromEntries(res.headers.entries())
  };
  fs.writeFileSync(path.join(runDir, 'request.json'), JSON.stringify({ endpoint, body: requestBody }, null, 2));
  fs.writeFileSync(path.join(runDir, 'response.meta.json'), JSON.stringify(meta, null, 2));

  if (!res.ok) {
    const bodyText = await res.text();
    fs.writeFileSync(path.join(runDir, 'response.error.txt'), bodyText, 'utf8');
    throw new Error(`HTTP ${res.status}: ${bodyText}`);
  }

  if (wantsSse) {
    const frames = await readSse(res);
    fs.writeFileSync(path.join(runDir, 'response.sse.log'), frames.map((f) => `${f}\n\n`).join(''), 'utf8');
    fs.writeFileSync(path.join(runDir, 'response.sse.ndjson'), frames.join('\n'), 'utf8');
    console.log(`[replay-codex-sample] captured ${frames.length} SSE frames → ${runDir}`);
  } else {
    const json = await res.json();
    fs.writeFileSync(path.join(runDir, 'response.json'), JSON.stringify(json, null, 2));
    console.log(`[replay-codex-sample] captured JSON response → ${runDir}`);
  }
}

main().catch((err) => {
  console.error('[replay-codex-sample] failed:', err);
  process.exit(1);
});
