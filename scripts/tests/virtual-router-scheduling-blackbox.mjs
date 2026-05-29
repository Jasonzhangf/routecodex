#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
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

function responseBody(text, model = 'gpt-5.4', extras = {}) {
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
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    ...extras
  };
}

async function createUpstream({ label, handler }) {
  const hits = [];
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.post(['/', '/responses', '/chat/completions', '/messages'], (req, res) => {
    hits.push({ label, body: req.body, path: req.path });
    handler(req, res, hits.length);
  });
  const server = await listen(http.createServer(app));
  return { ...server, hits };
}

async function writeProviderConfigs(userConfig) {
  const providers = userConfig?.virtualrouter?.providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    throw new Error('virtual router blackbox requires virtualrouter.providers');
  }
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
  app.use(express.json({ limit: '2mb' }));
  app.post('/v1/responses', (req, res) =>
    handleResponses(req, res, {
      executePipeline: (input) => routeCodex.executePortAwarePipeline(5555, input),
      errorHandling: routeCodex.errorHandling
    }));

  const httpHarness = await listen(http.createServer(app));
  return { routeCodex, httpHarness };
}

async function postResponses(baseUrl, body, headers = {}) {
  const requestBody = body && typeof body === 'object' && !Array.isArray(body)
    ? { stream: false, ...body }
    : body;
  const res = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(requestBody)
  });
  return { status: res.status, text: await res.text() };
}

function weightedConfig(aBase, bBase) {
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
            default: [{
              id: 'default',
              priority: 100,
              mode: 'priority',
              targets: ['wa.gpt-5.4', 'wb.gpt-5.4'],
              loadBalancing: { strategy: 'weighted', weights: { 'wa.gpt-5.4': 1, 'wb.gpt-5.4': 1 } }
            }]
          }
        }
      },
      providers: {
        wa: { id: 'wa', providerType: 'responses', type: 'responses', endpoint: aBase, auth: { type: 'apikey', apiKey: 'a'.repeat(24) }, models: { 'gpt-5.4': {} }, responses: { streaming: 'never' } },
        wb: { id: 'wb', providerType: 'responses', type: 'responses', endpoint: bBase, auth: { type: 'apikey', apiKey: 'b'.repeat(24) }, models: { 'gpt-5.4': {} }, responses: { streaming: 'never' } }
      },
      routing: {
        default: [{
          id: 'default',
          priority: 100,
          mode: 'priority',
          targets: ['wa.gpt-5.4', 'wb.gpt-5.4'],
          loadBalancing: { strategy: 'weighted', weights: { 'wa.gpt-5.4': 1, 'wb.gpt-5.4': 1 } }
        }]
      },
      quota: { apikeyDailyResetTime: '00:00' }
    }
  };
}

function weightedMinimaxConfig(mimoBase, minimaxBase) {
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
            search: [{
              id: 'gateway-priority-5555-search',
              priority: 100,
              mode: 'priority',
              targets: ['ra.gpt-5.4', 'rb.gpt-5.4'],
              loadBalancing: {
                strategy: 'weighted',
                weights: {
                  'ra.gpt-5.4': 1,
                  'rb.gpt-5.4': 1
                }
              }
            }],
            default: [{
              id: 'default',
              priority: 10,
              mode: 'priority',
              targets: ['ra.gpt-5.4', 'rb.gpt-5.4'],
              loadBalancing: {
                strategy: 'weighted',
                weights: {
                  'ra.gpt-5.4': 1,
                  'rb.gpt-5.4': 1
                }
              }
            }]
          }
        }
      },
      providers: {
        ra: {
          id: 'ra',
          providerType: 'responses',
          type: 'responses',
          endpoint: mimoBase,
          auth: { type: 'apikey', apiKey: 'm'.repeat(24) },
          models: { 'gpt-5.4': { capabilities: ['text', 'web_search'] } }, responses: { streaming: 'never' }
        },
        rb: {
          id: 'rb',
          providerType: 'responses',
          type: 'responses',
          endpoint: minimaxBase,
          auth: { type: 'apikey', apiKey: 'n'.repeat(24) },
          models: { 'gpt-5.4': { capabilities: ['text', 'web_search'] } }, responses: { streaming: 'never' }
        }
      },
      routing: {
        search: [{
          id: 'gateway-priority-5555-search',
          priority: 100,
          mode: 'priority',
          targets: ['ra.gpt-5.4', 'rb.gpt-5.4'],
          loadBalancing: {
            strategy: 'weighted',
            weights: {
              'ra.gpt-5.4': 1,
              'rb.gpt-5.4': 1
            }
          }
        }],
        default: [{
          id: 'default',
          priority: 10,
          mode: 'priority',
          targets: ['ra.gpt-5.4', 'rb.gpt-5.4'],
          loadBalancing: {
            strategy: 'weighted',
            weights: {
              'ra.gpt-5.4': 1,
              'rb.gpt-5.4': 1
            }
          }
        }]
      },
      quota: { apikeyDailyResetTime: '00:00' }
    }
  };
}

function failoverConfig(primaryBase, backupBase) {
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
            default: [{ id: 'default', priority: 100, mode: 'priority', targets: ['primary.gpt-5.4', 'backup.gpt-5.4'] }]
          }
        }
      },
      providers: {
        primary: { id: 'primary', providerType: 'responses', type: 'responses', endpoint: primaryBase, auth: { type: 'apikey', apiKey: 'p'.repeat(24) }, models: { 'gpt-5.4': {} }, responses: { streaming: 'never' } },
        backup: { id: 'backup', providerType: 'responses', type: 'responses', endpoint: backupBase, auth: { type: 'apikey', apiKey: 'q'.repeat(24) }, models: { 'gpt-5.4': {} }, responses: { streaming: 'never' } }
      },
      routing: {
        default: [{ id: 'default', priority: 100, mode: 'priority', targets: ['primary.gpt-5.4', 'backup.gpt-5.4'] }]
      },
      quota: { apikeyDailyResetTime: '00:00' }
    }
  };
}

function routeHintConfig(searchBase, defaultBase) {
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
            search: [{ id: 'search', priority: 100, mode: 'priority', targets: ['searcher.gpt-5.4'] }],
            default: [{ id: 'default', priority: 10, mode: 'priority', targets: ['defaultp.gpt-5.4'] }]
          }
        }
      },
      providers: {
        searcher: { id: 'searcher', providerType: 'responses', type: 'responses', endpoint: searchBase, auth: { type: 'apikey', apiKey: 's'.repeat(24) }, models: { 'gpt-5.4': {} }, responses: { streaming: 'never' } },
        defaultp: { id: 'defaultp', providerType: 'responses', type: 'responses', endpoint: defaultBase, auth: { type: 'apikey', apiKey: 'd'.repeat(24) }, models: { 'gpt-5.4': {} }, responses: { streaming: 'never' } }
      },
      routing: {
        search: [{ id: 'search', priority: 100, mode: 'priority', targets: ['searcher.gpt-5.4'] }],
        default: [{ id: 'default', priority: 10, mode: 'priority', targets: ['defaultp.gpt-5.4'] }]
      },
      quota: { apikeyDailyResetTime: '00:00' }
    }
  };
}

async function withRuntime(fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-vr-blackbox-'));
  const home = path.join(tmp, 'home');
  const sessionDir = path.join(tmp, 'sessions');
  const rccHome = path.join(tmp, 'rcc-home');
  const restores = [
    setEnv('HOME', home),
    setEnv('RCC_HOME', rccHome),
    setEnv('ROUTECODEX_USER_DIR', rccHome),
    setEnv('ROUTECODEX_HOME', rccHome),
    setEnv('ROUTECODEX_SESSION_DIR', sessionDir),
    setEnv('ROUTECODEX_SNAPSHOT', '0'),
    setEnv('ROUTECODEX_SERVERTOOL_ENABLED', '0'),
    setEnv('ROUTECODEX_HTTP_RESPONSES_TIMEOUT_MS', '12000'),
    setEnv('RCC_HTTP_RESPONSES_TIMEOUT_MS', '12000'),
    setEnv('RCC_RECOVERABLE_BACKOFF_BASE_MS', '10'),
    setEnv('ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS', '10'),
    setEnv('ROUTECODEX_MAX_PROVIDER_ATTEMPTS', '3')
  ];
  const closers = [];
  try {
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(rccHome, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });
    return await fn({ track(resource) { closers.push(resource); return resource; }, sessionDir });
  } finally {
    for (const item of closers.reverse()) {
      if (item?.httpHarness?.server) await close(item.httpHarness.server);
      if (item?.routeCodex?.disposeProviders) await item.routeCodex.disposeProviders().catch(() => {});
      if (item?.server) await close(item.server);
    }
    for (const restore of restores.reverse()) restore();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function runWeightedScenario() {
  return withRuntime(async ({ track }) => {
    const a = track(await createUpstream({ label: 'wa', handler: (_req, res) => res.json(responseBody('ok-wa')) }));
    const b = track(await createUpstream({ label: 'wb', handler: (_req, res) => res.json(responseBody('ok-wb')) }));
    const harness = track(await createHarnessServer(weightedConfig(a.baseUrl, b.baseUrl)));
    for (let i = 0; i < 6; i += 1) {
      const r = await postResponses(harness.httpHarness.baseUrl, { model: 'gpt-5.4', input: [{ role: 'user', content: [{ type: 'input_text', text: `weighted-${i}` }] }] });
      assert.equal(r.status, 200);
    }
    assert.ok(a.hits.length > 0, 'weighted blackbox: provider A never selected');
    assert.ok(b.hits.length > 0, 'weighted blackbox: provider B never selected');
    return { aHits: a.hits.length, bHits: b.hits.length };
  });
}

async function runWeightedMinimaxPresenceScenario() {
  return withRuntime(async ({ track }) => {
    const mimo = track(await createUpstream({ label: 'mimo', handler: (_req, res) => res.json(responseBody('ok-mimo', 'mimo-v2.5')) }));
    const minimax = track(await createUpstream({ label: 'minimax', handler: (_req, res) => res.json(responseBody('ok-minimax', 'MiniMax-M2.7')) }));
    const harness = track(await createHarnessServer(weightedMinimaxConfig(mimo.baseUrl, minimax.baseUrl)));
    for (let i = 0; i < 8; i += 1) {
      const r = await postResponses(
        harness.httpHarness.baseUrl,
        { model: 'gpt-5.4', input: [{ role: 'user', content: [{ type: 'input_text', text: `weighted-minimax-${i}` }] }] },
        { 'x-route-hint': 'search', 'x-session-id': 'weighted-minimax-presence' }
      );
      assert.equal(r.status, 200);
    }
    assert.ok(mimo.hits.length > 0, 'weighted minimax blackbox: mimo never selected');
    assert.ok(minimax.hits.length > 0, 'weighted minimax blackbox: minimax never selected');
    return { mimoHits: mimo.hits.length, minimaxHits: minimax.hits.length };
  });
}

async function runRecoverableFailoverScenario() {
  return withRuntime(async ({ track }) => {
    let primaryHits = 0;
    let backupHits = 0;
    const primary = track(await createUpstream({
      label: 'primary',
      handler: (_req, res) => {
        primaryHits += 1;
        res.status(502).json({ error: { message: 'bad gateway', code: 'HTTP_502' } });
      }
    }));
    const backup = track(await createUpstream({
      label: 'backup',
      handler: (_req, res) => {
        backupHits += 1;
        res.json(responseBody('ok-backup'));
      }
    }));
    const harness = track(await createHarnessServer(failoverConfig(primary.baseUrl, backup.baseUrl)));

    const first = await postResponses(harness.httpHarness.baseUrl, { model: 'gpt-5.4', input: [{ role: 'user', content: [{ type: 'input_text', text: 'recoverable-1' }] }] });
    assert.equal(first.status, 200, 'recoverable blackbox first request should recover to backup');
    assert.match(first.text, /ok-backup/);
    assert.equal(primaryHits, 3, 'recoverable blackbox should allow exactly 3 primary failures before switching');
    assert.equal(backupHits, 1, 'recoverable blackbox should switch to backup on first request after threshold');

    const second = await postResponses(harness.httpHarness.baseUrl, { model: 'gpt-5.4', input: [{ role: 'user', content: [{ type: 'input_text', text: 'recoverable-2' }] }] });
    assert.equal(second.status, 200, 'recoverable blackbox second request should bypass cooled-down primary');
    assert.match(second.text, /ok-backup/);
    assert.equal(primaryHits, 3, 'recoverable blackbox should not hit primary again immediately after cooldown');
    assert.equal(backupHits, 2, 'recoverable blackbox should send second request directly to backup');
    return { primaryHits, backupHits };
  });
}

async function runNoStickyScenario() {
  return withRuntime(async ({ track }) => {
    const searcher = track(await createUpstream({ label: 'search', handler: (_req, res) => res.json(responseBody('ok-search')) }));
    const defaultp = track(await createUpstream({ label: 'default', handler: (_req, res) => res.json(responseBody('ok-default')) }));
    const harness = track(await createHarnessServer(routeHintConfig(searcher.baseUrl, defaultp.baseUrl)));

    const r1 = await postResponses(
      harness.httpHarness.baseUrl,
      { model: 'gpt-5.4', input: [{ role: 'user', content: [{ type: 'input_text', text: 'search turn' }] }] },
      { 'x-route-hint': 'search', 'x-session-id': 'same-session' }
    );
    assert.equal(r1.status, 200);

    const r2 = await postResponses(
      harness.httpHarness.baseUrl,
      { model: 'gpt-5.4', input: [{ role: 'user', content: [{ type: 'input_text', text: 'normal turn' }] }] },
      { 'x-session-id': 'same-session' }
    );
    assert.equal(r2.status, 200);

    assert.equal(searcher.hits.length, 1, 'no-sticky blackbox: search provider should only serve hinted request');
    assert.equal(defaultp.hits.length, 1, 'no-sticky blackbox: default provider should serve next non-continuation request');
    return { searchHits: searcher.hits.length, defaultHits: defaultp.hits.length };
  });
}

async function main() {
  const only = process.argv[2] || 'all';
  if (only === 'all') {
    const scenarios = ['weighted', 'weighted-minimax', 'failover', 'no-sticky'];
    for (const scenario of scenarios) {
      const res = spawnSync(process.execPath, [new URL(import.meta.url).pathname, scenario], {
        cwd: process.cwd(),
        stdio: 'inherit',
        env: process.env
      });
      if ((res.status ?? 0) !== 0) {
        throw new Error(`scenario ${scenario} failed with status ${res.status}`);
      }
    }
    console.log(JSON.stringify({ ok: true, scenarios }, null, 2));
    return;
  }
  const results = {};
  if (only === 'weighted') results.weighted = await runWeightedScenario();
  else if (only === 'weighted-minimax') results.weightedMinimax = await runWeightedMinimaxPresenceScenario();
  else if (only === 'failover') results.failover = await runRecoverableFailoverScenario();
  else if (only === 'no-sticky') results.noSticky = await runNoStickyScenario();
  else throw new Error(`unknown scenario: ${only}`);
  console.log(JSON.stringify({ ok: true, ...results }, null, 2));
}

main().then(() => {
  setTimeout(() => process.exit(0), 20).unref();
}).catch((error) => {
  console.error('[virtual-router-scheduling-blackbox] failed');
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
