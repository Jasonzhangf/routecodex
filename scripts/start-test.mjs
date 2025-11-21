#!/usr/bin/env node
import { spawn } from 'node:child_process';
import http from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';

const CFG = process.env.ROUTECODEX_TEST_CONFIG || `${process.env.HOME}/.routecodex/provider/glm/config.v1.json`;
const PORT = Number(process.env.ROUTECODEX_PORT || 5555);

function startServer() {
  const env = { ...process.env, ROUTECODEX_PORT: String(PORT) };
  const args = ['start', '--config', CFG];
  const child = spawn('routecodex', args, { stdio: 'inherit', env });
  return child;
}

async function waitForReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise(resolve => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health' }, res => {
        resolve(res.statusCode === 200);
        res.resume();
      });
      req.on('error', () => resolve(false));
    });
    if (ok) return true;
    await wait(250);
  }
  return false;
}

async function postResponses(payload) {
  return await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/v1/responses', method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(payload));
    req.end();
  });
}

(async () => {
  const server = startServer();
  const ready = await waitForReady();
  if (!ready) {
    console.error('Server not ready on port', PORT);
    process.exit(2);
  }
  const payload = {
    model: 'glm-4.5-air',
    input: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    max_tokens: 64,
    stream: false
  };
  const resp = await postResponses(payload);
  if (resp.status !== 200) {
    console.error('Unexpected status', resp.status, resp.body);
    process.exit(3);
  }
  try {
    const j = JSON.parse(resp.body);
    if (j && j.object === 'response' && j.status && j.output && j.usage) {
      console.log('start:test OK');
    } else {
      console.error('Invalid content', j);
      process.exit(4);
    }
  } catch {
    console.error('Invalid JSON', resp.body);
    process.exit(5);
  }
  try { server.kill('SIGTERM'); } catch {}
})();

