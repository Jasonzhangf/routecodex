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

async function withRuntime(fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-longcontext-blackbox-'));
  const restores = [
    setEnv('RCC_HOME', tmp),
    setEnv('ROUTECODEX_HOME', tmp),
    setEnv('ROUTECODEX_DISABLE_DAEMON', '1')
  ];
  const tracked = [];
  try {
    return await fn({ track: (value) => { tracked.push(value); return value; }, tmp });
  } finally {
    for (const item of tracked.reverse()) {
      if (item?.httpHarness?.server) await close(item.httpHarness.server);
      if (item?.routeCodex?.shutdown) await item.routeCodex.shutdown().catch(() => {});
      if (item?.server) await close(item.server);
    }
    for (const restore of restores.reverse()) restore();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

function responseBody(text, model = 'mimo-pro') {
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

async function createUpstream({ label, text }) {
  const hits = [];
  const app = express();
  app.use(express.json({ limit: '6mb' }));
  app.post(['/', '/responses', '/chat/completions', '/messages'], (req, res) => {
    hits.push({ label, body: req.body, path: req.path });
    res.json(responseBody(text));
  });
  const server = await listen(http.createServer(app));
  return { ...server, hits };
}

async function writeProviderConfigs(userConfig) {
  const providers = userConfig?.virtualrouter?.providers;
  const userDir = process.env.RCC_HOME || path.join(process.env.HOME, '.rcc');
  const providerRoot = path.join(userDir, 'provider');
  await fs.mkdir(providerRoot, { recursive: true });
  for (const [providerId, provider] of Object.entries(providers)) {
    const providerDir = path.join(providerRoot, providerId);
    await fs.mkdir(providerDir, { recursive: true });
    await fs.writeFile(
      path.join(providerDir, 'config.v2.json'),
      `${JSON.stringify({ version: '2.0.0', providerId, provider }, null, 2)}\n`,
      'utf8'
    );
  }
}

async function createHarnessServer(userConfig) {
  const { RouteCodexHttpServer } = await import('../../dist/server/runtime/http-server/index.js');
  const { handleResponses } = await import('../../dist/server/handlers/responses-handler.js');
  await writeProviderConfigs(userConfig);
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
  app.use(express.json({ limit: '6mb' }));
  app.post('/v1/responses', (req, res) =>
    handleResponses(req, res, {
      executePipeline: (input) => routeCodex.executePortAwarePipeline(5555, input),
      errorHandling: routeCodex.errorHandling
    }));

  const httpHarness = await listen(http.createServer(app));
  return { routeCodex, httpHarness };
}

async function postResponses(baseUrl, body, headers = {}) {
  const res = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ stream: false, ...body })
  });
  return { status: res.status, text: await res.text() };
}

function config(bigBase, smallBase) {
  return {
    version: '1.0.0',
    httpserver: {
      host: '127.0.0.1',
      port: 5555,
      ports: [{ port: 5555, host: '127.0.0.1', mode: 'router', routingPolicyGroup: 'gateway_priority_5555', sameProtocolBehavior: 'relay' }]
    },
    virtualrouter: {
      classifier: { longContextThresholdTokens: 180000, thinkingKeywords: [], backgroundKeywords: [] },
      contextRouting: { warnRatio: 0.9, hardLimit: false },
      routingPolicyGroups: {
        gateway_priority_5555: {
          routing: {
            longcontext: [{
              id: 'gateway-priority-5555-longcontext',
              priority: 200,
              mode: 'priority',
              targets: ['big.mimo-pro']
            }],
            default: [{
              id: 'gateway-priority-5555-default',
              priority: 100,
              mode: 'priority',
              targets: ['small.mini-200k']
            }]
          }
        }
      },
      providers: {
        big: {
          id: 'big', providerType: 'responses', type: 'responses', endpoint: bigBase,
          auth: { type: 'apikey', apiKey: 'b'.repeat(24) }, responses: { streaming: 'never' },
          models: {
            'mimo-pro': {
              supportsStreaming: true,
              maxContext: 1048576,
              maxContextTokens: 200000,
              contextWindow: 200000,
              capabilities: ['text', 'longcontext']
            }
          }
        },
        small: {
          id: 'small', providerType: 'responses', type: 'responses', endpoint: smallBase,
          auth: { type: 'apikey', apiKey: 's'.repeat(24) }, responses: { streaming: 'never' },
          models: { 'mini-200k': { supportsStreaming: true, maxContextTokens: 200000, capabilities: ['text'] } }
        }
      },
      routing: {
        longcontext: [{ id: 'longcontext', priority: 200, mode: 'priority', targets: ['big.mimo-pro'] }],
        default: [{ id: 'default', priority: 100, mode: 'priority', targets: ['small.mini-200k'] }]
      },
      quota: { apikeyDailyResetTime: '00:00' }
    }
  };
}

async function main() {
  const result = await withRuntime(async ({ track }) => {
    const big = track(await createUpstream({ label: 'big-longcontext', text: 'ok-big-longcontext' }));
    const small = track(await createUpstream({ label: 'small-default', text: 'bad-small-default' }));
    const harness = track(await createHarnessServer(config(big.baseUrl, small.baseUrl)));
    const largeText = 'longcontext-token '.repeat(120_000);
    const res = await postResponses(harness.httpHarness.baseUrl, {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: largeText }] }]
    }, { 'x-session-id': 'longcontext-window-blackbox' });
    assert.equal(res.status, 200, res.text);
    assert.match(res.text, /ok-big-longcontext/, 'longcontext request must be served by longcontext-capable big provider');
    assert.ok(big.hits.length >= 1, 'big longcontext provider should receive the request');
    assert.equal(small.hits.length, 0, 'default/small provider must not receive longcontext overflow request');
    return { bigHits: big.hits.length, smallHits: small.hits.length };
  });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

main().then(() => {
  setTimeout(() => process.exit(0), 20).unref();
}).catch((error) => {
  console.error('[virtual-router-longcontext-context-window-blackbox] failed');
  console.error(error instanceof Error ? error.stack || error.message : error);
  setTimeout(() => process.exit(1), 20).unref();
});
