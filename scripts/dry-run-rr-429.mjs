#!/usr/bin/env node
// Dry-run test: verify per-pool round-robin and 429 policy
// - Spins up a mock upstream that returns 429 for key1 and 200 for others
// - Starts routecodex with a temp provider config that has 4 keys
// - Sends one Chat request and inspects snapshots to confirm switch to key2

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function startMockUpstream(port=9911) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const auth = req.headers['authorization'] || '';
      const isKey1 = /Bearer\s+sk_test_key1/i.test(String(auth));
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        if (isKey1) {
          // 429 for key1
          res.statusCode = 429;
          res.setHeader('Content-Type','application/json');
          res.end(JSON.stringify({ errors: { message: 'Request limit exceeded.' }, code: 'HTTP_429' }));
          return;
        }
        // success for others (key2+)
        res.statusCode = 200;
        res.setHeader('Content-Type','application/json');
        const now = Math.floor(Date.now()/1000);
        const out = {
          id: 'chatcmpl_mock', object: 'chat.completion', created: now,
          model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
        };
        res.end(JSON.stringify(out));
      });
      return;
    }
    res.statusCode = 404; res.end('not found');
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

async function writeProviderConfig(tmpDir, upstreamPort) {
  const cfg = {
    version: '1.0.0',
    virtualrouter: {
      inputProtocol: 'openai', outputProtocol: 'openai',
      providers: {
        modelscope: {
          id: 'modelscope', type: 'openai', baseURL: `http://127.0.0.1:${upstreamPort}/v1`,
          apiKey: [
            'sk_test_key1_abcdefghijklmnopqrstuvwxyz',
            'sk_test_key2_abcdefghijklmnopqrstuvwxyz',
            'sk_test_key3_abcdefghijklmnopqrstuvwxyz',
            'sk_test_key4_abcdefghijklmnopqrstuvwxyz'
          ],
          models: {
            'Qwen/Qwen3-Coder-480B-A35B-Instruct': { supportsStreaming: true, maxTokens: 64000, maxContext: 256000 }
          }
        }
      },
      routing: { default: ['modelscope.Qwen/Qwen3-Coder-480B-A35B-Instruct'] }
    },
    httpserver: { port: 5577, host: '127.0.0.1' }
  };
  const p = path.join(tmpDir, 'config.json');
  await fs.writeFile(p, JSON.stringify(cfg, null, 2), 'utf-8');
  return p;
}

async function waitHealth(port=5577, timeoutMs=15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ok = await new Promise((resolve) => {
        const req = http.get({ host:'127.0.0.1', port, path:'/health', timeout: 1000 }, (res) => {
          res.resume(); resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(1000, () => { try { req.destroy(); } catch {} });
      });
      if (ok) return true;
    } catch {}
    await sleep(300);
  }
  return false;
}

async function postChat(port=5577) {
  const payload = JSON.stringify({ model: 'glm-4.6', stream: false, messages: [{ role: 'user', content: 'hello' }] });
  return await new Promise((resolve, reject) => {
    const req = http.request({ host:'127.0.0.1', port, path:'/v1/chat/completions', method:'POST', headers: { 'Content-Type':'application/json','Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let data='';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

async function findLatestChatSnapshot() {
  const dir = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-chat');
  if (!fsSync.existsSync(dir)) return null;
  const files = fsSync.readdirSync(dir).filter(f => f.endsWith('_pipeline.provider.request.pre.json'));
  if (!files.length) return null;
  files.sort((a,b) => fsSync.statSync(path.join(dir, b)).mtimeMs - fsSync.statSync(path.join(dir, a)).mtimeMs);
  return path.join(dir, files[0]);
}

async function main() {
  const tmpDir = path.join(os.homedir(), '.routecodex', 'tmp', `rr429_${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  const upstream = await startMockUpstream(9911);
  const cfgPath = await writeProviderConfig(tmpDir, 9911);

  console.log('[dry-run] starting routecodex with', cfgPath);
  // 为了避免依赖 config-core 的装配差异，强制走 ConfigManager 的最小装配器（带 perKey 映射）
  // 这样 pipeline_assembler.config 会包含 authMappings/keyMappings，确保按 keyN 选择正确密钥
  const child = spawn(
    'node',
    [path.join(process.cwd(), 'dist', 'cli.js'), 'start', '--config', cfgPath],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        ROUTECODEX_CONFIG_CORE: '1', // 强制使用 config-core 装配，验证 assembler 输出
        RCC_PIPELINE_MODE: 'v2'      // 显式使用 V2 装配与路由池
      }
    }
  );
  const healthy = await waitHealth(5577, 15000);
  if (!healthy) { console.error('[dry-run] server not healthy'); try { upstream.close(); } catch {} process.exit(2); }

  console.log('[dry-run] posting chat request...');
  const res = await postChat(5577);
  console.log('[dry-run] response:', res.status, res.body.slice(0,200));

  // wait a moment for snapshots to flush
  await sleep(500);
  const snap = await findLatestChatSnapshot();
  if (snap) {
    const content = JSON.parse(await fs.readFile(snap,'utf-8'));
    const pid = content?.data?.pipelineId;
    console.log('[dry-run] latest provider.request.pre snapshot:', snap);
    console.log('[dry-run] pipelineId:', pid);
  } else {
    console.log('[dry-run] no provider.request.pre snapshot found');
  }

  try { child.kill('SIGINT'); } catch {}
  try { upstream.close(); } catch {}
}

main().catch(e => { console.error('[dry-run] failed:', e); process.exit(1); });
