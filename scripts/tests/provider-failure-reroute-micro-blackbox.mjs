#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';

function setEnv(name, value) {
  const original = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  return () => {
    if (original === undefined) delete process.env[name]; else process.env[name] = original;
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address.port !== 'number') throw new Error('Failed to resolve dynamic port');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(server) {
  if (!server) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 500);
    server.close(() => { clearTimeout(timer); resolve(); });
  });
}

function okResponse(text) {
  return {
    id: `resp_${Date.now()}`,
    object: 'response',
    status: 'completed',
    model: 'gpt-5.3-codex',
    output: [{
      id: `msg_${Date.now()}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text }]
    }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
  };
}

async function createUpstream({ status, text, hits }) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.post(['/', '/responses'], (_req, res) => {
    hits.count += 1;
    if (status === 200) {
      res.json(okResponse(text));
      return;
    }
    res.status(status).json({ error: { message: text, code: `HTTP_${status}` } });
  });
  return listen(http.createServer(app));
}

function buildConfig(primaryBase, backupBase) {
  return {
    version: '1.0.0',
    httpserver: {
      host: '127.0.0.1',
      port: 5555,
      ports: [{ port: 5555, host: '127.0.0.1', mode: 'router', routingPolicyGroup: 'gateway_priority_5555', sameProtocolBehavior: 'relay' }]
    },
    virtualrouter: {
      routingPolicyGroups: {
        gateway_priority_5555: {
          routing: {
            thinking: [{ id: 'thinking', priority: 100, mode: 'priority', targets: ['primary.gpt-5.3-codex', 'backup.gpt-5.3-codex'] }],
            default: [{ id: 'default', priority: 10, mode: 'priority', targets: ['primary.gpt-5.3-codex', 'backup.gpt-5.3-codex'] }]
          }
        }
      },
      providers: {
        primary: { id: 'primary', providerType: 'responses', type: 'responses', endpoint: primaryBase, auth: { type: 'apikey', apiKey: 'x'.repeat(24) }, models: { 'gpt-5.3-codex': {} } },
        backup: { id: 'backup', providerType: 'responses', type: 'responses', endpoint: backupBase, auth: { type: 'apikey', apiKey: 'y'.repeat(24) }, models: { 'gpt-5.3-codex': {} } }
      },
      routing: {
        thinking: [{ id: 'thinking', priority: 100, mode: 'priority', targets: ['primary.gpt-5.3-codex', 'backup.gpt-5.3-codex'] }],
        default: [{ id: 'default', priority: 10, mode: 'priority', targets: ['primary.gpt-5.3-codex', 'backup.gpt-5.3-codex'] }]
      },
      quota: { apikeyDailyResetTime: '00:00' }
    }
  };
}


async function writeProviderConfigs(userConfig) {
  const providers = userConfig?.virtualrouter?.providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    throw new Error('blackbox requires virtualrouter.providers');
  }
  const userDir = process.env.RCC_HOME || path.join(process.env.HOME, '.rcc');
  const providerRoot = path.join(userDir, 'provider');
  await fs.mkdir(providerRoot, { recursive: true });
  for (const [providerId, provider] of Object.entries(providers)) {
    const providerDir = path.join(providerRoot, providerId);
    await fs.mkdir(providerDir, { recursive: true });
    await fs.writeFile(
      path.join(providerDir, 'config.v2.json'),
      `${JSON.stringify({ version: '2.0.0', providerId, provider }, null, 2)}
`,
      'utf8'
    );
  }
}

async function createHarness(userConfig) {
  await writeProviderConfigs(userConfig);
  const { RouteCodexHttpServer } = await import('../../dist/server/runtime/http-server/index.js');
  const { handleResponses } = await import('../../dist/server/handlers/responses-handler.js');
  const routeCodex = new RouteCodexHttpServer({
    server: { host: '127.0.0.1', port: 5555 },
    pipeline: {},
    logging: { level: 'error', enableConsole: false },
    providers: {}
  });
  routeCodex.managerDaemon = {
    getModule(id) {
      if (id !== 'quota') return undefined;
      return {
        registerProviderStaticConfig: () => {},
        getQuotaView: () => (providerKey) => ({ providerKey, inPool: true, priorityTier: 100 }),
        getQuotaViewReadOnly: () => (providerKey) => ({ providerKey, inPool: true, priorityTier: 100 })
      };
    }
  };
  await routeCodex.initializeWithUserConfig(userConfig);
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.post('/v1/responses', (req, res) => handleResponses(req, res, {
    executePipeline: (input) => routeCodex.executePortAwarePipeline(5555, input),
    errorHandling: routeCodex.errorHandling
  }));
  const httpHarness = await listen(http.createServer(app));
  return { routeCodex, httpHarness };
}

async function post(baseUrl) {
  const res = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.3-codex',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'micro reroute test' }] }],
      stream: false
    })
  });
  return { status: res.status, body: await res.text() };
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-provider-reroute-micro-'));
  const home = path.join(tmp, 'home');
  const sessionDir = path.join(tmp, 'sessions');
  const restores = [
    setEnv('HOME', home),
    setEnv('ROUTECODEX_SESSION_DIR', sessionDir),
    setEnv('ROUTECODEX_SNAPSHOT', '0'),
    setEnv('ROUTECODEX_SERVERTOOL_ENABLED', '0'),
    setEnv('ROUTECODEX_STAGE_LOG', '1'),
    setEnv('ROUTECODEX_HTTP_RESPONSES_TIMEOUT_MS', '12000'),
    setEnv('ROUTECODEX_MAX_PROVIDER_ATTEMPTS', '3')
  ];
  const primaryHits = { count: 0 };
  const backupHits = { count: 0 };
  let primary;
  let backup;
  let harness;
  try {
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });
    primary = await createUpstream({ status: 502, text: 'bad gateway', hits: primaryHits });
    backup = await createUpstream({ status: 200, text: 'ok-backup', hits: backupHits });
    harness = await createHarness(buildConfig(primary.baseUrl, backup.baseUrl));
    const response = await post(harness.httpHarness.baseUrl);
    assert.equal(response.status, 200, 'micro blackbox: 502 reroute request should recover to backup');
    assert.match(response.body, /ok-backup/, 'micro blackbox: final body should come from backup');
    assert.equal(primaryHits.count, 3, 'micro blackbox: primary should be attempted exactly 3 times before cooldown/reroute');
    assert.equal(backupHits.count, 1, 'micro blackbox: backup should receive the recovered attempt');
    console.log(JSON.stringify({ ok: true, primaryHits: primaryHits.count, backupHits: backupHits.count }, null, 2));
  } finally {
    await delay(20);
    if (harness?.httpHarness?.server) await close(harness.httpHarness.server);
    if (harness?.routeCodex?.disposeProviders) await harness.routeCodex.disposeProviders().catch(() => {});
    if (primary?.server) await close(primary.server);
    if (backup?.server) await close(backup.server);
    for (const restore of restores.reverse()) restore();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

main().then(() => {
  setTimeout(() => process.exit(0), 20).unref();
}).catch((error) => {
  console.error('[provider-failure-reroute-micro-blackbox] failed');
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
