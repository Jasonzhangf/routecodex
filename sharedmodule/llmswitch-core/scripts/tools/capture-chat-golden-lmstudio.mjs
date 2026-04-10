#!/usr/bin/env node
/**
 * Capture Chat golden sample from LM Studio (OpenAI-compatible)
 * - Discovers models via /v1/models
 * - Sends non-streaming /v1/chat/completions
 * - Saves provider-response snapshot under ~/.routecodex/codex-samples/openai-chat/
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectSSEText, makeReqBase } from './lib/sse-utils.mjs';

function randId(n=9){ return Math.random().toString(36).slice(2,2+n); }

async function detectLMStudio() {
  // Defaults
  const base = process.env.LMSTUDIO_BASEURL || 'http://127.0.0.1:1234/v1';
  const apiKey = process.env.LMSTUDIO_API_KEY || 'lm-studio';
  return { baseURL: base.replace(/\/$/, ''), apiKey };
}

async function pickModel(baseURL, apiKey) {
  const resp = await fetch(`${baseURL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!resp.ok) throw new Error(`List models failed: HTTP ${resp.status}`);
  const data = await resp.json();
  const id = data?.data?.[0]?.id || data?.[0]?.id;
  if (!id) throw new Error('No models found on LM Studio');
  return id;
}

async function sendChat(baseURL, apiKey, model, prompt) {
  const body = { model, messages: [{ role: 'user', content: prompt }], stream: false };
  const resp = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  const text = await resp.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  if (!resp.ok) throw new Error(`chat failed ${resp.status}: ${text}`);
  return json;
}

async function sendChatStream(baseURL, apiKey, model, prompt) {
  const body = { model, messages: [{ role: 'user', content: prompt }], stream: true };
  const resp = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  if (!resp.ok || !resp.body) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`chat stream failed ${resp.status}: ${txt}`);
  }
  return resp.body;
}

async function saveSnapshot(payload) {
  const dir = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-chat');
  await fs.mkdir(dir, { recursive: true });
  const ts = Date.now();
  const file = path.join(dir, `req_${ts}_${randId()}_provider-response.json`);
  const snapshot = { data: { body: payload } };
  await fs.writeFile(file, JSON.stringify(snapshot, null, 2), 'utf-8');
  return file;
}

async function main() {
  const { baseURL, apiKey } = await detectLMStudio();
  const model = await pickModel(baseURL, apiKey);
  const prompt = 'Please reply a short sentence for golden capture.';
  const json = await sendChat(baseURL, apiKey, model, prompt);
  const file = await saveSnapshot(json);
  console.log(`Saved LM Studio chat provider-response: ${file}`);

  // Also save under golden_samples/chat/<stamp>/ with SSE events
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const goldenDir = path.join(os.homedir(), '.routecodex', 'golden_samples', 'chat', stamp);
  await fs.mkdir(goldenDir, { recursive: true });
  await fs.writeFile(path.join(goldenDir, 'provider-response.json'), JSON.stringify(json, null, 2), 'utf-8');
  // capture SSE
  try {
    const stream = await sendChatStream(baseURL, apiKey, model, prompt);
    const sseText = await collectSSEText(stream);
    await fs.writeFile(path.join(goldenDir, 'events.sse'), sseText, 'utf-8');
    // parse minimal events
    const events = [];
    let current = {};
    for (const line of sseText.split('\n')) {
      const l = line.trim();
      if (!l) { if (Object.keys(current).length) { events.push(current); current = {}; } continue; }
      if (l.startsWith('event:')) current.event = l.slice(6).trim();
      else if (l.startsWith('data:')) { const d = l.slice(5).trim(); try { current.data = JSON.parse(d); } catch { current.data = { raw: d }; } }
      else if (l.startsWith('id:')) current.id = l.slice(3).trim();
    }
    if (Object.keys(current).length) events.push(current);
    await fs.writeFile(path.join(goldenDir, 'events.json'), JSON.stringify({ model, baseURL, capturedAt: stamp, events }, null, 2), 'utf-8');
  } catch (e) {
    console.warn('SSE capture failed:', (e && e.message) || e);
  }
}

main().catch((e) => { console.error('Capture LM Studio failed:', e); process.exit(1); });
