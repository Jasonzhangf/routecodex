#!/usr/bin/env node
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import os from 'os';

const port = process.env.PORT || process.argv[2] || '5520';
const url = `http://localhost:${port}/v1/openai/chat/completions`;

// Try to get a real GLM key to override per-request (ensures success)
function getGlmKey() {
  if (process.env.GLM_API_KEY && String(process.env.GLM_API_KEY).trim()) return String(process.env.GLM_API_KEY).trim();
  try {
    const p = path.join(os.homedir(), '.routecodex', 'config.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const key = j?.virtualrouter?.providers?.glm?.apiKey?.[0];
    if (typeof key === 'string' && key && key !== '***REDACTED***') return key;
  } catch {}
  return null;
}

const body = {
  model: 'glm-4.6',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: '用中文简要回答：新流水线逻辑已启用了吗？' }
  ],
  temperature: 0.2,
  max_tokens: 64
};

const headers = { 'Content-Type': 'application/json' };
const key = getGlmKey();
if (key) headers['Authorization'] = `Bearer ${key}`;

const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
console.log('status', res.status, res.statusText);
const text = await res.text();
console.log(text.slice(0, 400));
