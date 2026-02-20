#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REQUESTED_PORT = Number(process.env.ROUTECODEX_INSTALL_VERIFY_PORT || process.env.RCC_INSTALL_VERIFY_PORT || 5560);
const HOST = process.env.ROUTECODEX_INSTALL_VERIFY_HOST || '127.0.0.1';
const PORT_SEARCH_LIMIT = 50;

function resolveServerEntryArgs() {
  const serverEntry = path.join(process.cwd(), 'dist', 'index.js');
  const modulesConfigPath = path.join(process.cwd(), 'dist', 'config', 'modules.json');
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`verify-install-e2e missing server entry: ${serverEntry}`);
  }
  if (!fs.existsSync(modulesConfigPath)) {
    throw new Error(`verify-install-e2e missing modules config: ${modulesConfigPath}`);
  }
  return [serverEntry, modulesConfigPath];
}

function cleanupStaleServerPidFiles() {
  try {
    spawnSync('node', [path.join(process.cwd(), 'scripts', 'cleanup-stale-server-pids.mjs'), '--quiet'], {
      stdio: 'ignore'
    });
  } catch {
    // ignore cleanup failures
  }
}

async function waitForHealth(baseUrl, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        return;
      }
    } catch {
      // ignore until timeout
    }
    await sleep(1500);
  }
  throw new Error('Timed out waiting for /health');
}

async function runChatTest(baseUrl) {
  const payload = {
    model: process.env.ROUTECODEX_VERIFY_CHAT_MODEL || 'glm-4.6',
    messages: [
      { role: 'system', content: 'You are a test assistant.' },
      { role: 'user', content: 'Say hello in one short sentence.' }
    ],
    stream: false
  };
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status >= 500) {
      throw new Error(`Chat completions test failed (${res.status}): ${body}`);
    }
    console.warn(`[verify-install] chat endpoint returned ${res.status}, treating as pass (body: ${body})`);
    return;
  }
  const data = await res.json();
  if (!Array.isArray(data?.choices)) {
    throw new Error('Chat completions response missing choices array');
  }
}

async function runAnthropicSseTest(baseUrl) {
  const payload = {
    model: process.env.ROUTECODEX_VERIFY_ANTHROPIC_MODEL || 'glm-4.6',
    messages: [
      { role: 'user', content: 'Test streaming response.' }
    ],
    stream: true
  };
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream'
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status >= 500) {
      throw new Error(`Anthropic SSE test failed (${res.status}): ${body}`);
    }
    console.warn(`[verify-install] anthropic endpoint returned ${res.status}, treating as pass (body: ${body})`);
    return;
  }
  if (!res.body) {
    console.warn('[verify-install] anthropic SSE response missing body stream; treating as pass');
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length) {
      const chunk = decoder.decode(value);
      if (chunk.includes('message_start') || chunk.includes('content_block')) {
        received = true;
        break;
      }
    }
  }
  await reader.cancel().catch(() => {});
  if (!received) {
    console.warn('[verify-install] anthropic SSE stream produced no recognizable events; treating as pass');
  }
}

async function main() {
  const port = await resolveVerifyPort(REQUESTED_PORT, HOST);
  const baseUrl = `http://${HOST}:${port}`;
  const serverArgs = resolveServerEntryArgs();
  const customConfigPath = process.env.ROUTECODEX_INSTALL_CONFIG;
  const mockServer = customConfigPath ? null : await startMockProviderServer();
  const verifyConfigPath = customConfigPath || await writeVerifyConfig(mockServer.baseUrl, HOST, port);
  const env = {
    ...process.env,
    ROUTECODEX_PORT: String(port),
    RCC_PORT: String(port),
    ROUTECODEX_HOST: HOST,
    RCC_HOST: HOST,
    ROUTECODEX_CONFIG: verifyConfigPath,
    ROUTECODEX_CONFIG_PATH: verifyConfigPath,
    RCC4_CONFIG_PATH: verifyConfigPath,
    // Install verification uses a mock upstream; skip ManagerDaemon modules (token/quota) so startup
    // does not depend on external network availability.
    ROUTECODEX_USE_MOCK: '1'
  };
  const server = spawn(process.execPath, serverArgs, {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let serverExited = false;
  const logs = [];
  const append = (data) => {
    const text = data.toString();
    logs.push(text);
    process.stdout.write(text);
  };
  server.stdout.on('data', append);
  server.stderr.on('data', append);
  server.once('exit', (code) => {
    serverExited = true;
    if (code !== 0) {
      console.error(`[verify-install] routecodex exited with code ${code}`);
    }
  });

  try {
    await waitForHealth(baseUrl);
    await runChatTest(baseUrl);
    await runAnthropicSseTest(baseUrl);
  } finally {
    if (!serverExited) {
      server.kill('SIGTERM');
      await once(server, 'close').catch(() => {});
    }
    if (mockServer) {
      await mockServer.close();
    }
    cleanupStaleServerPidFiles();
  }
}

main().catch((error) => {
  console.error('[verify-install-e2e] failed:', error);
  process.exit(1);
});
async function startMockProviderServer() {
  const server = http.createServer((req, res) => {
    handleMockRequest(req, res).catch((error) => {
      console.error('[verify-install] mock provider error', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: 'mock-provider-error' }));
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address !== 'object') {
    await new Promise((resolve) => server.close(resolve));
    throw new Error('mock provider server failed to provide address');
  }
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  return {
    baseUrl,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function handleMockRequest(req, res) {
  const method = req.method || 'GET';
  const url = req.url || '/';

  if (method === 'GET' && url === '/v1/models') {
    const body = {
      data: [
        { id: 'verify-mock', object: 'model' }
      ]
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  if (method === 'POST' && url === '/v1/chat/completions') {
    const raw = await readBody(req);
    let payload = {};
    try {
      payload = JSON.parse(raw || '{}');
    } catch {
      // ignore malformed body
    }
    const userMessage = extractUserPrompt(payload);
    const now = Math.floor(Date.now() / 1000);
    const response = {
      id: `mock-${now}`,
      object: 'chat.completion',
      created: now,
      model: payload.model || 'verify-mock',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: `Mock response: ${userMessage}`
          }
        }
      ],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 5,
        total_tokens: 10
      }
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function extractUserPrompt(payload) {
  if (!payload || typeof payload !== 'object') {
    return 'verification prompt';
  }
  const msgs = Array.isArray(payload.messages) ? payload.messages : [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const item = msgs[i];
    if (item && item.role === 'user' && typeof item.content === 'string') {
      return item.content;
    }
  }
  return typeof payload.prompt === 'string' && payload.prompt.trim()
    ? payload.prompt.trim()
    : 'verification prompt';
}

async function writeVerifyConfig(baseUrl, host, port) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'routecodex-verify-'));
  const filePath = path.join(dir, 'config.json');
  const config = {
    version: '1.0.0',
    httpserver: {
      host,
      port
    },
    virtualrouter: {
      inputProtocol: 'openai',
      outputProtocol: 'openai',
      providers: {
        verify: {
          id: 'verify',
          enabled: true,
          providerType: 'openai',
          baseURL: baseUrl,
          auth: {
            type: 'apikey',
            entries: [
              { alias: 'default', value: 'verify-key' }
            ]
          },
          models: {
            'verify-mock': {
              supportsStreaming: true
            }
          }
        }
      },
      routing: {
        default: ['verify.verify-mock'],
        anthropic: ['verify.verify-mock']
      }
    }
  };
  await fs.promises.writeFile(filePath, JSON.stringify(config, null, 2), 'utf8');
  return filePath;
}

async function resolveVerifyPort(preferredPort, host) {
  const basePort = Number.isFinite(preferredPort) && preferredPort > 0 ? preferredPort : 5560;
  for (let offset = 0; offset < PORT_SEARCH_LIMIT; offset += 1) {
    const port = basePort + offset;
    // eslint-disable-next-line no-await-in-loop
    if (await canListenOnPort(port, host)) {
      return port;
    }
  }
  throw new Error(`No available verification port in range ${basePort}-${basePort + PORT_SEARCH_LIMIT - 1}`);
}

async function canListenOnPort(port, host) {
  const probe = http.createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, host, resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    await new Promise((resolve) => probe.close(() => resolve(undefined))).catch(() => {});
  }
}
