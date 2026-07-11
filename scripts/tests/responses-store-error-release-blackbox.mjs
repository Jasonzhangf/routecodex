#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { getResponsesConversationStoreDebugStats } from '../helpers/llmswitch-direct-native.mjs';

function setEnv(name, value) {
  const old = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  return () => { if (old === undefined) delete process.env[name]; else process.env[name] = old; };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

async function createFailingUpstream(hits) {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.post(['/', '/responses'], (req, res) => {
    hits.push(req.body);
    res.status(502).json({ error: { code: 'HTTP_502', message: 'bad gateway' } });
  });
  return listen(http.createServer(app));
}

function buildConfig(baseUrl) {
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
            default: [{ id: 'default', priority: 100, mode: 'priority', targets: ['bad.gpt-5.4'] }]
          }
        }
      },
      providers: {
        bad: { id: 'bad', providerType: 'responses', type: 'responses', endpoint: baseUrl, auth: { type: 'apikey', apiKey: 'b'.repeat(24) }, models: { 'gpt-5.4': {} }, responses: { streaming: 'never' } }
      },
      routing: { default: [{ id: 'default', priority: 100, mode: 'priority', targets: ['bad.gpt-5.4'] }] },
      quota: { apikeyDailyResetTime: '00:00' }
    }
  };
}

async function writeProviderConfigs(userConfig) {
  const providers = userConfig?.virtualrouter?.providers;
  const userDir = process.env.RCC_HOME || path.join(process.env.HOME, '.rcc');
  const providerRoot = path.join(userDir, 'provider');
  await fs.mkdir(providerRoot, { recursive: true });
  for (const [providerId, provider] of Object.entries(providers)) {
    const providerDir = path.join(providerRoot, providerId);
    await fs.mkdir(providerDir, { recursive: true });
    await fs.writeFile(path.join(providerDir, 'config.v2.json'), `${JSON.stringify({ version: '2.0.0', providerId, provider }, null, 2)}\n`, 'utf8');
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
  app.use(express.json({ limit: '4mb' }));
  app.post('/v1/responses', (req, res) => handleResponses(req, res, {
    executePipeline: (input) => routeCodex.executePortAwarePipeline(5555, input),
    errorHandling: routeCodex.errorHandling
  }));
  const httpHarness = await listen(http.createServer(app));
  return { routeCodex, httpHarness };
}

async function getStoreStats() {
  return getResponsesConversationStoreDebugStats();
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-store-error-release-'));
  const home = path.join(tmp, 'home');
  const rccHome = path.join(tmp, 'rcc-home');
  const sessionDir = path.join(tmp, 'sessions');
  const restores = [
    setEnv('HOME', home),
    setEnv('RCC_HOME', rccHome),
    setEnv('ROUTECODEX_USER_DIR', rccHome),
    setEnv('ROUTECODEX_HOME', rccHome),
    setEnv('ROUTECODEX_SESSION_DIR', sessionDir),
    setEnv('ROUTECODEX_SNAPSHOT', '0'),
    setEnv('ROUTECODEX_SERVERTOOL_ENABLED', '0'),
    setEnv('ROUTECODEX_HTTP_RESPONSES_TIMEOUT_MS', '12000'),
    setEnv('ROUTECODEX_MAX_PROVIDER_ATTEMPTS', '3')
  ];
  const hits = [];
  let upstream;
  let harness;
  try {
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(rccHome, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });
    upstream = await createFailingUpstream(hits);
    harness = await createHarness(buildConfig(upstream.baseUrl));
    const before = await getStoreStats();
    const input = Array.from({ length: 8 }, (_, i) => ({ role: 'user', content: [{ type: 'input_text', text: `store-error-${i}` }] }));
    const res = await fetch(`${harness.httpHarness.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-id': 'store-error-session' },
      body: JSON.stringify({ model: 'gpt-5.4', input, stream: false, metadata: { sessionId: 'store-error-session' } })
    });
    const text = await res.text();
    assert.notEqual(res.status, 200, text);
    assert.ok(hits.length >= 1, 'failing provider should receive at least one request');
    const after = await getStoreStats();
    assert.equal(after.requestEntriesWithoutLastResponseId, before.requestEntriesWithoutLastResponseId, 'failed request must not leave pendingNoResponseId entries');
    assert.equal(after.retainedInputItems, before.retainedInputItems, 'failed request must not retain input items');
    console.log(JSON.stringify({ ok: true, before, after, hits: hits.length }, null, 2));
  } finally {
    await close(harness?.httpHarness?.server);
    await harness?.routeCodex?.disposeProviders?.().catch(() => {});
    await close(upstream?.server);
    for (const restore of restores.reverse()) restore();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

main().then(() => {
  setTimeout(() => process.exit(0), 20).unref();
}).catch((error) => {
  console.error('[responses-store-error-release-blackbox] failed');
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
