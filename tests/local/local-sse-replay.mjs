// Local replay test for Chat SSE path using StreamingManager (unique entry)
// Replays recorded SSE chunks and uses compat-post as final candidate to verify
// terminal tool_calls synthesis OR immediate textual extraction.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const requestId = process.argv[2];
if (!requestId) {
  console.error('Usage: node tests/local/local-sse-replay.mjs <requestId>');
  process.exit(1);
}

function readCompatPost(reqId) {
  const base = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-chat');
  const file = path.join(base, `${reqId}_compat-post.json`);
  const raw = fs.readFileSync(file, 'utf-8');
  const j = JSON.parse(raw);
  return (j?.data?.data) || j?.data || j;
}

function readSSEChunks(reqId) {
  const file = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-chat', `${reqId}_sse-events.log`);
  const lines = fs.readFileSync(file, 'utf-8').trim().split(/\r?\n/);
  const chunks = [];
  for (const line of lines) {
    if (!line) continue;
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.event === 'chunk' && obj?.data) { chunks.push(obj.data); }
  }
  return chunks;
}

const compat = readCompatPost(requestId);
const sseChunks = readSSEChunks(requestId);

// Minimal Express.Response stub
class ResStub {
  constructor() { this.headers = {}; this.out = []; this.ended = false; }
  setHeader(k, v) { this.headers[k] = v; }
  write(s) { this.out.push(String(s)); }
  end() { this.ended = true; }
  getOutput() { return this.out.join(''); }
  getHeaders() { return this.headers; }
}

async function run() {
  const { StreamingManager } = await import('../../dist/server/utils/streaming-manager.js');
  const mgr = new StreamingManager({ enablePipeline: true });
  const res = new ResStub();
  const pipelineResponse = { data: sseChunks, __final: compat };
  await mgr.streamResponse({ data: sseChunks, __final: compat }, requestId, res, compat?.model || 'unknown');
  const out = res.getOutput();
  console.log('--- HEADERS ---');
  console.log(JSON.stringify(res.getHeaders(), null, 2));
  console.log('--- OUTPUT (first 40 lines) ---');
  console.log(out.split(/\n/).slice(0, 40).join('\n'));
  const hasTool = /tool_calls/.test(out);
  if (!hasTool) {
    console.error('FAIL: No tool_calls emitted in replay output');
    process.exit(2);
  }
  console.log('OK: tool_calls present in replay output');
}

await run();

