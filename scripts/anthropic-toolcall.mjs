#!/usr/bin/env node
// Send Chat→Anthropic (Messages) with a simple tool and check for tool_use in SSE, then convert to Chat.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const PROVIDER_DIR = path.join(os.homedir(), '.routecodex', 'provider');
const OUT_DIR = path.join(os.homedir(), '.routecodex', 'logs', 'anthropic-sse');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function nowStamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

function findProviderConfig(providerId='glm-anthropic') {
  const dir = path.join(PROVIDER_DIR, providerId);
  const candidates = ['config.v1.json', 'config.json'];
  for (const name of candidates) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  }
  throw new Error('no provider config');
}

function extract(base) {
  // Try pipeline_assembler first
  try {
    const p = base?.pipeline_assembler?.config?.pipelines?.[0]?.modules?.provider?.config;
    const baseURL = p?.baseUrl?.replace(/\/$/, '') || p?.baseURL?.replace(/\/$/, '');
    const apiKey = p?.auth?.apiKey;
    const model = p?.model || p?.modelId || p?.defaultModel || 'glm-4.6';
    if (baseURL && apiKey) return { baseURL, apiKey, model };
  } catch {}
  const providers = base?.virtualrouter?.providers || {};
  const entry = providers['glm-anthropic'] || Object.values(providers)[0];
  if (!entry) throw new Error('no provider entry');
  const baseURL = entry.baseURL?.replace(/\/$/, '') || 'https://api.anthropic.com/v1';
  const apiKey = (Array.isArray(entry.apiKey) ? entry.apiKey[0] : (entry.auth?.apiKey || entry.apiKey));
  const route = base?.virtualrouter?.routing?.default?.[0] || '';
  const model = route.split('.').slice(1).join('.') || Object.keys(entry.models||{})[0] || 'glm-4.6';
  return { baseURL, apiKey, model };
}

async function main() {
  const cfg = findProviderConfig();
  const { baseURL, apiKey, model } = extract(cfg);
  if (!apiKey) throw new Error('no apiKey');
  const chat = {
    model: 'dummy',
    messages: [
      { role: 'user', content: 'Using tools, call add with {"a":2,"b":3}. Return only a function call.' }
    ],
    tools: [ { type: 'function', function: { name: 'add', description: 'add two numbers', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a','b'] } } } ],
    tool_choice: 'auto'
  };

  const codecPath = pathToFileURL(path.join(process.cwd(), 'sharedmodule/llmswitch-core/dist/conversion/codecs/anthropic-openai-codec.js')).href;
  const { buildAnthropicRequestFromOpenAIChat, buildOpenAIChatFromAnthropic } = await import(codecPath);
  const req = buildAnthropicRequestFromOpenAIChat(chat);
  req.model = model;
  req.stream = true;
  req.max_tokens = 256;

  ensureDir(OUT_DIR);
  const base = path.join(OUT_DIR, `glm_anthropic_${nowStamp()}`);
  const sseLog = `${base}.sse.log`;
  const jsonOut = `${base}.json`;
  const chatOut = `${base}.chat.json`;
  fs.writeFileSync(`${base}.request.json`, JSON.stringify(req, null, 2));

  const headers = {
    'content-type': 'application/json',
    'accept': 'text/event-stream',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };
  const resp = await fetch(baseURL + '/messages', { method: 'POST', headers, body: JSON.stringify(req) });
  if (!resp.ok || !resp.body) {
    const t = await resp.text().catch(()=> '');
    throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${t}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const lines = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    const parts = (buffer + chunk).split('\n');
    buffer = parts.pop() || '';
    for (const l of parts) if (l.trim()) lines.push(l.trim());
  }
  // reconstruct SSE text for converter
  const sseText = lines
    .map((l, i, arr) => l.startsWith('event:') || l.startsWith('data:') ? l : '')
    .filter(Boolean)
    .join('\n')
    .replace(/\n(?=event:)/g, '\n\n');
  fs.writeFileSync(sseLog, sseText, 'utf-8');

  const convPath = pathToFileURL(path.join(process.cwd(), 'sharedmodule/llmswitch-core/dist/sse/sse-to-json/anthropic-sse-to-json-converter.js')).href;
  const { AnthropicSseToJsonConverter } = await import(convPath);
  async function* gen() { yield sseText; }
  const conv = new AnthropicSseToJsonConverter();
  const message = await conv.convertSseToJson(gen(), { requestId: path.basename(base) });
  fs.writeFileSync(jsonOut, JSON.stringify(message, null, 2));
  const chatResp = buildOpenAIChatFromAnthropic({ messages: [message] });
  fs.writeFileSync(chatOut, JSON.stringify(chatResp, null, 2));
  const tc = chatResp?.choices?.[0]?.message?.tool_calls || [];
  console.log('[anthropic-toolcall] model=%s tool_calls=%s out=%s', model, Array.isArray(tc)? tc.length : 0, chatOut);
}

main().catch(e => { console.error(e); process.exit(1); });
