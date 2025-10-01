#!/usr/bin/env node
// ModelScope multi-key test with simple retry and summary

import fs from 'fs';
import path from 'path';

const BASE = 'https://api-inference.modelscope.cn/v1/chat/completions';
const MODEL = process.env.MS_MODEL || 'Qwen/Qwen3-235B-A22B-Instruct-2507';
const MAX_RETRY = Number(process.env.MS_RETRY || 1);

function readMixed() {
  const p = path.resolve(process.env.HOME || '', '.routecodex', 'config', 'mixed.json');
  if (!fs.existsSync(p)) throw new Error(`Config not found: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function call(key) {
  const payload = {
    model: MODEL,
    messages: [{ role: 'user', content: '列出本地文件目录（如需可调用list_dir工具）' }],
    tools: [{ type: 'function', function: { name: 'list_dir', description: '列出指定路径下的文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }]
  };
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function main() {
  const mixed = readMixed();
  const ms = mixed?.virtualrouter?.providers?.modelscope;
  const keys = Array.isArray(ms?.apiKey) ? ms.apiKey : (ms?.auth?.apiKey ? [ms.auth.apiKey] : []);
  if (!keys.length) throw new Error('No ModelScope keys found in mixed.json');

  const summary = [];
  for (const key of keys) {
    let ok = 0, fail = 0, times = [];
    for (let i = 0; i < 3; i++) {
      let attempt = 0; let success = false; let lastStatus = 0;
      const t0 = Date.now();
      while (attempt <= MAX_RETRY && !success) {
        attempt++;
        try {
          const { status } = await call(key);
          lastStatus = status;
          if (status === 200) { success = true; ok++; times.push(Date.now() - t0); break; }
          if (status >= 500 || status === 429 || status === 408) { /* retryable */ }
          else { break; }
        } catch {
          // retry on network errors
        }
        await new Promise(r => setTimeout(r, 300 * attempt));
      }
      if (!success) { fail++; times.push(Date.now() - t0); }
      console.log(`key=****${key.slice(-6)} #${i+1} ${success ? 'OK' : 'FAIL'} in ${times.at(-1)}ms`);
    }
    const avg = times.length ? Math.round(times.reduce((a,b)=>a+b,0)/times.length) : 0;
    summary.push({ key: `****${key.slice(-6)}`, ok, fail, avgMs: avg });
  }
  console.table(summary);
}

main().catch(e => { console.error('test-modelscope error:', e); process.exit(2); });

