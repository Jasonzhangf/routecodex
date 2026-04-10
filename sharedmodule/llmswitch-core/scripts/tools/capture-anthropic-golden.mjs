#!/usr/bin/env node

/**
 * Capture Anthropic SSE golden sample from a provider config.
 * - Reads provider config JSON (glm-anthropic)
 * - Sends a streaming /v1/messages request
 * - Saves raw SSE, parsed events, and reconstructed message JSON
 *
 * Usage:
 *   node scripts/tools/capture-anthropic-golden.mjs \
 *     --config ~/.routecodex/provider/glm-anthropic/config.json \
 *     --prompt "Say hi in one sentence" \
 *     [--outdir ~/.routecodex/golden_samples/anthropic]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

function parseArgs(argv) {
  const args = { config: path.join(os.homedir(), '.routecodex/provider/glm-anthropic/config.json'), prompt: 'Hello from llmswitch-core', outdir: path.join(os.homedir(), '.routecodex/golden_samples/anthropic') };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--config' || a === '-c') && argv[i+1]) { args.config = argv[++i]; continue; }
    if ((a === '--prompt' || a === '-p') && argv[i+1]) { args.prompt = argv[++i]; continue; }
    if ((a === '--outdir' || a === '-o') && argv[i+1]) { args.outdir = argv[++i]; continue; }
  }
  return args;
}

async function loadProvider(cfgPath) {
  const raw = await fs.readFile(cfgPath, 'utf-8');
  const cfg = JSON.parse(raw);
  const providers = cfg?.virtualrouter?.providers || {};
  const entry = providers['glm-anthropic'] || Object.values(providers)[0];
  if (!entry) throw new Error('No provider entry found in config');
  const baseURL = entry.baseURL?.replace(/\/$/, '') || 'https://api.anthropic.com/v1';
  const apiKey = (Array.isArray(entry.apiKey) ? entry.apiKey[0] : entry.auth?.apiKey || entry.apiKey) || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('No apiKey found in provider config or env ANTHROPIC_API_KEY');
  const routeDefault = cfg?.virtualrouter?.routing?.default?.[0] || '';
  // "glm-anthropic.glm-4.6" → model = "glm-4.6"
  const model = routeDefault.split('.').slice(1).join('.') || Object.keys(entry.models || {})[0] || 'glm-4.6';
  return { baseURL, apiKey, model };
}

async function ensureDir(dir) { await fs.mkdir(dir, { recursive: true }); }

function mask(s) {
  if (!s) return s;
  const t = String(s);
  return t.length <= 8 ? '****' : t.slice(0, 4) + '…' + t.slice(-4);
}

async function captureSSE(url, apiKey, model, prompt) {
  const headers = {
    'content-type': 'application/json',
    'accept': 'text/event-stream',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };
  const body = {
    model,
    messages: [
      { role: 'user', content: [ { type: 'text', text: prompt } ] }
    ],
    max_tokens: 256,
    stream: true
  };
  const resp = await fetch(url + '/messages', { method: 'POST', headers, body: JSON.stringify(body) });
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${text}`);
  }
  // Collect raw SSE and event objects
  let raw = '';
  const events = [];
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    raw += chunk;
    const lines = (buffer + chunk).split('\n');
    buffer = lines.pop() || '';
    let current = {};
    for (const line of lines) {
      const l = line.trim();
      if (!l) { if (Object.keys(current).length) { events.push(current); current = {}; } continue; }
      if (l.startsWith('event:')) { current.event = l.slice(6).trim(); continue; }
      if (l.startsWith('data:')) { const d = l.slice(5).trim(); try { current.data = JSON.parse(d); } catch { current.data = { raw: d }; } continue; }
      if (l.startsWith('id:')) { current.id = l.slice(3).trim(); continue; }
      if (l.startsWith('retry:')) { current.retry = Number(l.slice(6).trim()); continue; }
    }
    if (Object.keys(current).length) { events.push(current); current = {}; }
  }
  return { raw, events };
}

async function reconstructMessageFromEvents(events) {
  const { AnthropicSseToJsonConverter } = await import('../../dist/sse/sse-to-json/anthropic-sse-to-json-converter.js');
  // create AsyncIterable<string> from joined text
  const rawText = events.map(ev => `event: ${ev.event}\n` + `data: ${JSON.stringify(ev.data)}\n\n`).join('');
  async function* gen() { yield rawText; }
  const conv = new AnthropicSseToJsonConverter();
  const msg = await conv.convertSseToJson(gen(), { requestId: `anthropic_golden_${Date.now()}` });
  return msg;
}

async function main() {
  const args = parseArgs(process.argv);
  const { baseURL, apiKey, model } = await loadProvider(args.config);
  console.log(`Provider: ${baseURL} | model=${model} | key=${mask(apiKey)}`);
  const { raw, events } = await captureSSE(baseURL, apiKey, model, args.prompt);
  const message = await reconstructMessageFromEvents(events);

  const dir = path.join(args.outdir, new Date().toISOString().replace(/[:.]/g, '-'));
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, 'events.sse'), raw, 'utf-8');
  await fs.writeFile(path.join(dir, 'events.json'), JSON.stringify(events, null, 2), 'utf-8');
  await fs.writeFile(path.join(dir, 'message.json'), JSON.stringify(message, null, 2), 'utf-8');
  console.log(`Saved golden sample to ${dir}`);
}

main().catch((e) => { console.error('Capture failed:', e); process.exitCode = 1; });
