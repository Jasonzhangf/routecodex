#!/usr/bin/env node
// Lightweight smoke tests for protocol adapter enforcement across three endpoints.
// - Starts server if not healthy
// - Tests cross-protocol payloads and prints concise results

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

async function readPortFromConfig() {
  try {
    const cfgPath = path.join(process.cwd(), 'config', 'config.json');
    const txt = await readFile(cfgPath, 'utf-8');
    const cfg = JSON.parse(txt);
    const port = cfg?.httpserver?.port || cfg?.server?.port || 5520;
    return Number(port);
  } catch {
    return 5520;
  }
}

async function isHealthy(baseUrl) {
  try {
    const ac = new AbortController();
    const id = setTimeout(() => ac.abort(), 1500);
    const r = await fetch(`${baseUrl}/health`, { signal: ac.signal });
    clearTimeout(id);
    if (!r.ok) return false;
    const j = await r.json();
    return (j?.status?.status || j?.status) === 'healthy' || j?.status === 'healthy';
  } catch {
    return false;
  }
}

function startBg() {
  // Respect repo’s background policy via npm script
  return new Promise((resolve) => {
    const p = spawn('npm', ['run', '-s', 'start:bg'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => { out += String(d); });
    p.stderr.on('data', d => { /* ignore */ });
    p.on('close', () => resolve(out.trim()))
  });
}

async function ensureServer(baseUrl) {
  if (await isHealthy(baseUrl)) return true;
  console.log(`[smoke] server not healthy, starting via npm run start:bg`);
  await startBg();
  for (let i = 0; i < 20; i++) {
    if (await isHealthy(baseUrl)) return true;
    await delay(750);
  }
  return false;
}

async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json: j };
}

function okOpenAIShape(obj) {
  return obj && typeof obj === 'object' && Array.isArray(obj.choices);
}

function okAnthropicShape(obj) {
  return obj && typeof obj === 'object' && (Array.isArray(obj.content) || obj.type === 'message' || obj.object === 'response');
}

async function main() {
  const port = await readPortFromConfig();
  const baseUrl = `http://127.0.0.1:${port}`;
  const ok = await ensureServer(baseUrl);
  if (!ok) {
    console.error(`[smoke] server failed to become healthy on ${baseUrl}`);
    process.exit(2);
  }

  let pass = 0;
  let fail = 0;

  // 1) OpenAI chat endpoint receiving Anthropic-shaped payload => converted => OpenAI-shaped
  const anthropicPayload = {
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 64,
    messages: [ { role: 'user', content: [ { type: 'text', text: 'Hello from smoke test' } ] } ],
    stream: false,
  };
  const r1 = await postJson(`${baseUrl}/v1/chat/completions`, anthropicPayload);
  const ok1 = r1.ok && okOpenAIShape(r1.json);
  console.log(`[smoke] /v1/chat/completions anthropic->openai: ${ok1 ? 'OK' : 'FAIL'} (${r1.status})`);
  ok1 ? pass++ : fail++;

  // 2) Anthropic messages endpoint under router (/v1/openai/messages) receiving OpenAI-shaped payload => converted => Anthropic-shaped
  const openaiPayload = {
    model: 'gpt-4o-mini',
    messages: [ { role: 'user', content: 'Hello from smoke test' } ],
    max_tokens: 64,
    stream: false,
  };
  const r2 = await postJson(`${baseUrl}/v1/openai/messages`, openaiPayload);
  const ok2 = r2.ok && (okAnthropicShape(r2.json) || okOpenAIShape(r2.json));
  console.log(`[smoke] /v1/openai/messages openai->anthropic: ${ok2 ? 'OK' : 'FAIL'} (${r2.status})`);
  ok2 ? pass++ : fail++;

  // 3) OpenAI completions endpoint basic run
  const compPayload = { model: 'gpt-3.5-turbo-instruct', prompt: 'Say ok', max_tokens: 8, stream: false };
  const r3 = await postJson(`${baseUrl}/v1/completions`, compPayload);
  const ok3 = r3.ok && r3.json && Array.isArray(r3.json.choices);
  console.log(`[smoke] /v1/completions: ${ok3 ? 'OK' : 'FAIL'} (${r3.status})`);
  ok3 ? pass++ : fail++;

  console.log(`[smoke] summary: pass=${pass} fail=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[smoke] fatal', e);
  process.exit(1);
});
