#!/usr/bin/env node
/**
 * Capture Chat golden sample from ModelScope (OpenAI-compatible)
 * - Reads provider config: ~/.routecodex/provider/modelscope/config.v1.json
 * - Picks routing.default model (strip provider prefix)
 * - Sends non-streaming /v1/chat/completions
 * - Saves provider-response snapshot under ~/.routecodex/codex-samples/openai-chat/
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function randId(n=9){ return Math.random().toString(36).slice(2,2+n); }

async function loadConfig() {
  const file = path.join(os.homedir(), '.routecodex', 'provider', 'modelscope', 'config.v1.json');
  const raw = await fs.readFile(file, 'utf-8');
  const cfg = JSON.parse(raw);
  const p = cfg?.virtualrouter?.providers?.modelscope;
  if (!p) throw new Error('No modelscope provider in config');
  const baseURL = (p.baseURL || '').replace(/\/$/, '') || 'https://api-inference.modelscope.cn/v1';
  const apiKey = Array.isArray(p.apiKey) ? p.apiKey[0] : (p.auth?.apiKey || p.apiKey);
  const def = cfg?.virtualrouter?.routing?.default?.[0] || '';
  const model = def.split('.').slice(1).join('.') || Object.keys(p.models||{})[0];
  if (!apiKey) throw new Error('No API key for modelscope');
  if (!model) throw new Error('No default model in modelscope config');
  return { baseURL, apiKey, model };
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
  const { baseURL, apiKey, model } = await loadConfig();
  const prompt = 'Please reply a short sentence for golden capture (ModelScope).';
  const json = await sendChat(baseURL, apiKey, model, prompt);
  const file = await saveSnapshot(json);
  console.log(`Saved ModelScope chat provider-response: ${file}`);
}

main().catch((e) => { console.error('Capture ModelScope failed:', e); process.exit(1); });

