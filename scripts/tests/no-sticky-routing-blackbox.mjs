#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

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

function responseBody(text, model = 'gpt-5.4') {
  return {
    id: `resp_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    object: 'response',
    status: 'completed',
    model,
    output: [{
      id: `msg_${Date.now()}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text }]
    }],
    output_text: text,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
  };
}

async function createUpstream({ label, hits }) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.post(['/', '/responses'], (req, res) => {
    hits.push({ label, body: req.body });
    res.json(responseBody(`ok-${label}`));
  });
  return listen(http.createServer(app));
}

function buildConfig(searchBase, defaultBase) {
  return {
    version: '1.0.0',
    httpserver: {
      host: '127.0.0.1',
      port: 5555,
      ports: [{
        port: 5555,
        host: '127.0.0.1',
        mode: 'router',
        routingPolicyGroup: 'gateway_priority_5555',
        sameProtocolBehavior: 'relay'
      }]
    },
    virtualrouter: {
      routingPolicyGroups: {
        gateway_priority_5555: {
          routing: {
            search: [{ id: 'search', priority: 100, mode: 'priority', targets: ['searcher.gpt-5.4'] }],
            default: [{ id: 'default', priority: 10, mode: 'priority', targets: ['defaultp.gpt-5.4'] }]
          }
        }
      },
      providers: {
        searcher: {
          id: 'searcher',
          providerType: 'responses',
          type: 'responses',
          endpoint: searchBase,
          auth: { type: 'apikey', apiKey: 's'.repeat(24) },
          models: { 'gpt-5.4': {} }
        },
        defaultp: {
          id: 'defaultp',
          providerType: 'responses',
          type: 'responses',
          endpoint: defaultBase,
          auth: { type: 'apikey', apiKey: 'd'.repeat(24) },
          models: { 'gpt-5.4': {} }
        }
      },
      routing: {
        search: [{ id: 'search', priority: 100, mode: 'priority', targets: ['searcher.gpt-5.4'] }],
        default: [{ id: 'default', priority: 10, mode: 'priority', targets: ['defaultp.gpt-5.4'] }]
      },
      quota: { apikeyDailyResetTime: '00:00' }
    }
  };
}

async function postResponses(baseUrl, body) {
  const res = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(body.__headers || {}) },
    body: JSON.stringify((delete body.__headers, body))
  });
  return { status: res.status, text: await res.text() };
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

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-no-sticky-routing-'));
  const restores = [
    setEnv('HOME', path.join(tmp, 'home')),
    setEnv('ROUTECODEX_SESSION_DIR', path.join(tmp, 'sessions')),
    setEnv('ROUTECODEX_SNAPSHOT', '0'),
    setEnv('ROUTECODEX_SERVERTOOL_ENABLED', '0'),
    setEnv('ROUTECODEX_HTTP_RESPONSES_TIMEOUT_MS', '15000')
  ];
  let searchServer;
  let defaultServer;
  let harness;
  let routeCodex;
  try {
    await fs.mkdir(process.env.HOME, { recursive: true });
    await fs.mkdir(process.env.ROUTECODEX_SESSION_DIR, { recursive: true });
    const searchHits = [];
    const defaultHits = [];
    searchServer = await createUpstream({ label: 'search', hits: searchHits });
    defaultServer = await createUpstream({ label: 'default', hits: defaultHits });

    const { RouteCodexHttpServer } = await import('../../dist/server/runtime/http-server/index.js');
    const { handleResponses } = await import('../../dist/server/handlers/responses-handler.js');
    routeCodex = new RouteCodexHttpServer({
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
    const userConfig = buildConfig(searchServer.baseUrl, defaultServer.baseUrl);
    await writeProviderConfigs(userConfig);
    await routeCodex.initializeWithUserConfig(userConfig);
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.post('/v1/responses', (req, res) => handleResponses(req, res, {
      executePipeline: (input) => routeCodex.executePortAwarePipeline(5555, input),
      errorHandling: routeCodex.errorHandling
    }));
    harness = await listen(http.createServer(app));

    const sessionId = `session-no-sticky-${Date.now()}`;
    const first = await postResponses(harness.baseUrl, {
      model: 'gpt-5.4',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'search current docs' }] }],
      metadata: { sessionId },
      stream: false,
      __headers: { 'x-route-hint': 'search' }
    });
    assert.equal(first.status, 200, first.text);
    assert.match(first.text, /ok-search/);
    assert.equal(searchHits.length, 1, 'first request must hit search route');
    assert.equal(defaultHits.length, 0, 'first request must not hit default route');

    const second = await postResponses(harness.baseUrl, {
      model: 'gpt-5.4',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'read local file only' }] }],
      metadata: { sessionId },
      stream: false
    });
    assert.equal(second.status, 200, second.text);
    assert.match(second.text, /ok-default/);
    assert.equal(searchHits.length, 1, 'second request must not inherit previous search route');
    assert.equal(defaultHits.length, 1, 'second request must route by current request only');

    const legacyStickyInstruction = await postResponses(harness.baseUrl, {
      model: 'gpt-5.4',
      input: [{ role: 'user', content: [{ type: 'input_text', text: '<**sticky:searcher.gpt-5.4**> read local file only' }] }],
      metadata: { sessionId },
      stream: false
    });
    assert.equal(legacyStickyInstruction.status, 200, legacyStickyInstruction.text);
    assert.match(legacyStickyInstruction.text, /ok-default/, 'legacy sticky instruction must be ignored, not force search route');
    assert.equal(searchHits.length, 1, 'legacy sticky instruction must not hit search provider');
    assert.equal(defaultHits.length, 2, 'legacy sticky instruction must use normal current-request route');

    console.log(JSON.stringify({ ok: true, searchHits: searchHits.length, defaultHits: defaultHits.length }, null, 2));
  } finally {
    await close(harness?.server);
    await routeCodex?.disposeProviders?.().catch(() => {});
    await close(searchServer?.server);
    await close(defaultServer?.server);
    for (const restore of restores.reverse()) restore();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

main().then(() => {
  setTimeout(() => process.exit(0), 20).unref();
}).catch((error) => {
  console.error('[no-sticky-routing-blackbox] failed');
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
