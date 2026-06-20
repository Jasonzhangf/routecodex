#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

function setEnv(name, value) {
  const original = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  return () => {
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  };
}

async function listenHttpServer(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address.port !== 'number') {
    throw new Error('Failed to resolve dynamic port');
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

function buildResponsesOkBody(text) {
  return {
    id: `resp_${text}`,
    object: 'response',
    status: 'completed',
    model: 'gpt-5.3-codex',
    output: [
      {
        id: 'msg_1',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text }]
      }
    ],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2
    }
  };
}

function sanitizeSessionSegment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function canonicalizeServerId(host, port) {
  const rawHost = String(host || '').trim();
  const normalizedHost = (() => {
    if (!rawHost) return '127.0.0.1';
    const lowered = rawHost.toLowerCase();
    if (lowered === '0.0.0.0' || lowered === '::' || lowered === '::0') {
      return '127.0.0.1';
    }
    return rawHost;
  })();
  const normalizedPort = Number.isFinite(port) ? Math.floor(port) : port;
  return `${normalizedHost}:${normalizedPort}`;
}

function resolveProviderHealthPathForPortScope(ctx, userConfig, port) {
  const portConfig = userConfig?.httpserver?.ports?.find((entry) => Number(entry?.port) === port);
  assert.ok(portConfig, `blackbox missing port config for ${port}`);
  const serverId = canonicalizeServerId(portConfig.host ?? userConfig?.httpserver?.host, port);
  const serverSegment = sanitizeSessionSegment(serverId);
  const rawScope = typeof portConfig.routingPolicyGroup === 'string' && portConfig.routingPolicyGroup.trim()
    ? portConfig.routingPolicyGroup.trim()
    : String(port);
  const scopeSegment = sanitizeSessionSegment(rawScope);
  assert.ok(serverSegment, 'blackbox failed to resolve server session segment');
  assert.ok(scopeSegment, 'blackbox failed to resolve port session segment');
  return path.join(ctx.rccHome, 'sessions', serverSegment, 'ports', scopeSegment, 'provider-health.json');
}

function readRoutingGroupHealth(routeCodex, routingPolicyGroup) {
  const groupPipelines = routeCodex?.hubPipelinesByRoutingPolicyGroup;
  const pipeline = groupPipelines instanceof Map ? groupPipelines.get(routingPolicyGroup) : undefined;
  return pipeline?.getVirtualRouter?.()?.getStatus?.()?.health ?? [];
}

async function createMockUpstream({ status, body, onHit }) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => {
    if (req.method === 'GET' && req.path.endsWith('/models')) {
      res.status(200).json({ data: [{ id: 'gpt-5.3-codex' }] });
      return;
    }
    if (req.method === 'POST' && req.path.endsWith('/responses')) {
      onHit?.(req.body);
      res.status(status).json(body);
      return;
    }
    next();
  });
  return listenHttpServer(http.createServer(app));
}

function buildUserConfig(upstreamA, upstreamB) {
  return {
    version: '1.0.0',
    httpserver: {
      host: '127.0.0.1',
      port: 5555,
      ports: [
        {
          port: 5555,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'gateway_priority_5555',
          sameProtocolBehavior: 'relay'
        }
      ]
    },
    virtualrouter: {
      routingPolicyGroups: {
        gateway_priority_5555: {
          routing: {
            thinking: [
              {
                id: 'thinking',
                priority: 100,
                mode: 'priority',
                targets: ['primary.gpt-5.3-codex', 'backup.gpt-5.3-codex']
              }
            ],
            default: [
              {
                id: 'default',
                priority: 10,
                mode: 'priority',
                targets: ['primary.gpt-5.3-codex', 'backup.gpt-5.3-codex']
              }
            ]
          }
        }
      },
      providers: {
        primary: {
          id: 'primary',
          type: 'responses',
          endpoint: upstreamA,
          auth: { type: 'apikey', apiKey: 'x'.repeat(24) },
          models: { 'gpt-5.3-codex': {} }
        },
        backup: {
          id: 'backup',
          type: 'responses',
          endpoint: upstreamB,
          auth: { type: 'apikey', apiKey: 'y'.repeat(24) },
          models: { 'gpt-5.3-codex': {} }
        }
      },
      routing: {
        thinking: [
          {
            id: 'thinking',
            priority: 100,
            mode: 'priority',
            targets: ['primary.gpt-5.3-codex', 'backup.gpt-5.3-codex']
          }
        ],
        default: [
          {
            id: 'default',
            priority: 10,
            mode: 'priority',
            targets: ['primary.gpt-5.3-codex', 'backup.gpt-5.3-codex']
          }
        ]
      },
      quota: {
        apikeyDailyResetTime: '00:00'
      }
    }
  };
}



function buildPortIsolationUserConfig(upstreams) {
  return {
    version: '1.0.0',
    httpserver: {
      host: '127.0.0.1',
      port: 5555,
      ports: [
        { port: 5555, host: '127.0.0.1', mode: 'router', routingPolicyGroup: 'gateway_priority_5555_a', sameProtocolBehavior: 'relay' },
        { port: 6666, host: '127.0.0.1', mode: 'router', routingPolicyGroup: 'gateway_priority_6666_b', sameProtocolBehavior: 'relay' }
      ]
    },
    virtualrouter: {
      activeRoutingPolicyGroup: 'gateway_priority_5555_a',
      routingPolicyGroups: {
        gateway_priority_5555_a: {
          routing: {
            thinking: [{ id: 'a-thinking', priority: 100, mode: 'priority', targets: ['primarya.gpt-5.3-codex', 'backupa.gpt-5.3-codex'] }],
            default: [{ id: 'a-default', priority: 10, mode: 'priority', targets: ['primarya.gpt-5.3-codex', 'backupa.gpt-5.3-codex'] }]
          }
        },
        gateway_priority_6666_b: {
          routing: {
            thinking: [{ id: 'b-thinking', priority: 100, mode: 'priority', targets: ['primaryb.gpt-5.3-codex', 'backupb.gpt-5.3-codex'] }],
            default: [{ id: 'b-default', priority: 10, mode: 'priority', targets: ['primaryb.gpt-5.3-codex', 'backupb.gpt-5.3-codex'] }]
          }
        }
      },
      providers: {
        primarya: { id: 'primarya', type: 'responses', endpoint: upstreams.primarya, checkHealth: false, auth: { type: 'apikey', apiKey: 'a'.repeat(24) }, models: { 'gpt-5.3-codex': {} } },
        backupa: { id: 'backupa', type: 'responses', endpoint: upstreams.backupa, checkHealth: false, auth: { type: 'apikey', apiKey: 'b'.repeat(24) }, models: { 'gpt-5.3-codex': {} } },
        primaryb: { id: 'primaryb', type: 'responses', endpoint: upstreams.primaryb, checkHealth: false, auth: { type: 'apikey', apiKey: 'c'.repeat(24) }, models: { 'gpt-5.3-codex': {} } },
        backupb: { id: 'backupb', type: 'responses', endpoint: upstreams.backupb, checkHealth: false, auth: { type: 'apikey', apiKey: 'd'.repeat(24) }, models: { 'gpt-5.3-codex': {} } }
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

function cloneConfigForV2ProviderLoader(userConfig) {
  const cloned = JSON.parse(JSON.stringify(userConfig));
  if (cloned?.virtualrouter && typeof cloned.virtualrouter === 'object') {
    delete cloned.virtualrouter.providers;
  }
  return cloned;
}

async function createHarnessServer({ userConfig, RouteCodexHttpServer, handleResponses }) {
  await writeProviderConfigs(userConfig);
  const runtimeConfig = cloneConfigForV2ProviderLoader(userConfig);
  const routeCodex = new RouteCodexHttpServer({
    server: { host: '127.0.0.1', port: 5555 },
    pipeline: {},
    logging: { level: 'error', enableConsole: false },
    providers: {}
  });

  routeCodex.managerDaemon = {
    getModule(id) {
      if (id !== 'quota') {
        return undefined;
      }
      return {
        registerProviderStaticConfig: () => {},
        getQuotaView: () => (providerKey) => ({
          providerKey,
          inPool: true,
          priorityTier: 100
        }),
        getQuotaViewReadOnly: () => (providerKey) => ({
          providerKey,
          inPool: true,
          priorityTier: 100
        })
      };
    }
  };

  await routeCodex.initializeWithUserConfig(runtimeConfig);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.post('/v1/responses', (req, res) => {
    const requestedPort = Number(req.headers['x-rcc-test-port'] ?? 5555);
    const localPort = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : 5555;
    return handleResponses(req, res, {
      executePipeline: (input) => routeCodex.executePortAwarePipeline(localPort, input),
      errorHandling: routeCodex.errorHandling
    });
  });

  const httpHarness = await listenHttpServer(http.createServer(app));
  return { routeCodex, httpHarness };
}

async function postResponses(baseUrl, options = {}) {
  const port = typeof options.port === 'number' ? options.port : undefined;
  const headers = { 'content-type': 'application/json' };
  if (port) headers['x-rcc-test-port'] = String(port);
  const res = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'gpt-5.3-codex',
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'hello provider failure blackbox' }]
        }
      ],
      stream: false
    })
  });
  return {
    status: res.status,
    body: await res.text()
  };
}

function summarizeHealthFile(parsed) {
  return {
    providerCooldowns: Array.isArray(parsed?.providerCooldowns)
      ? parsed.providerCooldowns.map((entry) => ({
          providerKey: entry?.providerKey,
          reason: entry?.reason,
          cooldownExpiresAt: entry?.cooldownExpiresAt
        }))
      : []
  };
}

async function findProviderHealthFiles(rootDir) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === 'provider-health.json') {
        files.push(fullPath);
      }
    }
  }
  await walk(rootDir);
  return files.sort();
}

async function readOptionalProviderHealthSummary(providerHealthPath) {
  try {
    return summarizeHealthFile(JSON.parse(await fs.readFile(providerHealthPath, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return summarizeHealthFile(undefined);
    }
    throw error;
  }
}

function findHealthEntry(entries, prefix) {
  if (!Array.isArray(entries)) {
    return undefined;
  }
  return entries.find((entry) => {
    const key = typeof entry?.provider_key === 'string'
      ? entry.provider_key
      : typeof entry?.providerKey === 'string'
        ? entry.providerKey
        : undefined;
    return typeof key === 'string' && key.startsWith(prefix);
  });
}

function readHealthState(entry) {
  return typeof entry?.state === 'string' ? entry.state : undefined;
}

function readHealthCooldownExpiresAt(entry) {
  return typeof entry?.cooldown_expires_at === 'number'
    ? entry.cooldown_expires_at
    : typeof entry?.cooldownExpiresAt === 'number'
      ? entry.cooldownExpiresAt
      : undefined;
}

async function withScenarioRuntime(options, fn) {
  const maxProviderAttempts =
    typeof options?.maxProviderAttempts === 'number' && Number.isFinite(options.maxProviderAttempts)
      ? Math.max(1, Math.floor(options.maxProviderAttempts))
      : 3;
  const responsesTimeoutMs =
    typeof options?.responsesTimeoutMs === 'number' && Number.isFinite(options.responsesTimeoutMs)
      ? Math.max(1000, Math.floor(options.responsesTimeoutMs))
      : 15000;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-provider-failure-'));
  const home = path.join(tmpDir, 'home');
  const rccHome = path.join(home, '.rcc');
  const sessionDir = path.join(tmpDir, 'sessions');
  const restores = [];
  let servers = [];
  try {
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });
    restores.push(
      setEnv('HOME', home),
      setEnv('RCC_HOME', rccHome),
      setEnv('ROUTECODEX_SESSION_DIR', sessionDir),
      setEnv('ROUTECODEX_SNAPSHOT', '0'),
      setEnv('ROUTECODEX_SERVERTOOL_ENABLED', '0'),
      setEnv('ROUTECODEX_HTTP_RESPONSES_TIMEOUT_MS', String(responsesTimeoutMs)),
      setEnv('ROUTECODEX_MAX_PROVIDER_ATTEMPTS', String(maxProviderAttempts))
    );
    const providerTraffic = await import('../../dist/server/runtime/http-server/provider-traffic-governor.js');
    providerTraffic.resetSharedProviderTrafficGovernorForTests?.();
    const { RouteCodexHttpServer } = await import('../../dist/server/runtime/http-server/index.js');
    const { handleResponses } = await import('../../dist/server/handlers/responses-handler.js');
    const { __requestExecutorTestables } = await import('../../dist/server/runtime/http-server/request-executor.js');
    return await fn({
      tmpDir,
      rccHome,
      sessionDir,
      RouteCodexHttpServer,
      handleResponses,
      __requestExecutorTestables,
      trackServer(server) {
        servers.push(server);
        return server;
      }
    });
  } finally {
    for (const server of servers.reverse()) {
      if (server?.httpHarness?.server) {
        await closeServer(server.httpHarness.server);
      }
      if (server?.routeCodex?.disposeProviders) {
        await server.routeCodex.disposeProviders().catch(() => {});
      }
      if (server?.server) {
        await closeServer(server.server);
      }
    }
    for (const restore of restores.reverse()) {
      restore();
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function run503Scenario() {
  return withScenarioRuntime({ maxProviderAttempts: 3, responsesTimeoutMs: 15000 }, async (ctx) => {
    let primaryHits = 0;
    let backupHits = 0;

    const primaryUpstream = ctx.trackServer(
      await createMockUpstream({
        status: 503,
        body: { error: { message: 'unavailable', code: 'HTTP_503' } },
        onHit: () => {
          primaryHits += 1;
        }
      })
    );
    const backupUpstream = ctx.trackServer(
      await createMockUpstream({
        status: 200,
        body: buildResponsesOkBody('ok-from-backup-503'),
        onHit: () => {
          backupHits += 1;
        }
      })
    );

    const userConfig = buildUserConfig(primaryUpstream.baseUrl, backupUpstream.baseUrl);
    let firstServer = ctx.trackServer(
      await createHarnessServer({
        userConfig,
        RouteCodexHttpServer: ctx.RouteCodexHttpServer,
        handleResponses: ctx.handleResponses
      })
    );

    const first = await postResponses(firstServer.httpHarness.baseUrl);
    assert.equal(first.status, 200);
    assert.match(first.body, /ok-from-backup-503/);
    assert.equal(primaryHits, 1);
    assert.equal(backupHits, 1);

    const second = await postResponses(firstServer.httpHarness.baseUrl);
    assert.equal(second.status, 200);
    assert.match(second.body, /ok-from-backup-503/);
    assert.equal(primaryHits, 2);
    assert.equal(backupHits, 2);

    const thirdBeforeRestart = await postResponses(firstServer.httpHarness.baseUrl);
    assert.equal(thirdBeforeRestart.status, 200);
    assert.match(thirdBeforeRestart.body, /ok-from-backup-503/);
    assert.equal(primaryHits, 3);
    assert.equal(backupHits, 3);

    const fourthBeforeRestart = await postResponses(firstServer.httpHarness.baseUrl);
    assert.equal(fourthBeforeRestart.status, 200);
    assert.match(fourthBeforeRestart.body, /ok-from-backup-503/);
    assert.equal(primaryHits, 3, 'fourth request should bypass runtime-cooled primary');
    assert.equal(backupHits, 4);

    const runtimeHealthAfter503 = readRoutingGroupHealth(firstServer.routeCodex, 'gateway_priority_5555');
    const primaryRuntimeHealthAfter503 = findHealthEntry(runtimeHealthAfter503, 'primary.');
    assert.ok(primaryRuntimeHealthAfter503, '503 scenario should mark primary in runtime health after third strike');
    assert.equal(readHealthState(primaryRuntimeHealthAfter503), 'tripped');

    const providerHealthPath = resolveProviderHealthPathForPortScope(ctx, userConfig, 5555);
    const providerHealthFiles = await findProviderHealthFiles(ctx.tmpDir);
    assert.deepEqual(
      providerHealthFiles.filter((filePath) => filePath !== providerHealthPath),
      [],
      'provider health must only persist under the port-scoped runtime truth path'
    );
    const healthSummary = await readOptionalProviderHealthSummary(providerHealthPath);
    assert.equal(
      healthSummary.providerCooldowns.length,
      0,
      '503 recoverable cooldown must not persist across restart'
    );
    await assert.rejects(
      () => fs.stat(path.join(ctx.sessionDir, 'provider-health.json')),
      (error) => error?.code === 'ENOENT',
      'provider health must not leak into legacy ROUTECODEX_SESSION_DIR root'
    );

    await closeServer(firstServer.httpHarness.server);
    await firstServer.routeCodex.disposeProviders();
    ctx.__requestExecutorTestables.resetRequestExecutorInternalStateForTests();
    firstServer = undefined;

    const beforeRestartPrimaryHits = primaryHits;
    const beforeRestartBackupHits = backupHits;

    const secondServer = ctx.trackServer(
      await createHarnessServer({
        userConfig,
        RouteCodexHttpServer: ctx.RouteCodexHttpServer,
        handleResponses: ctx.handleResponses
      })
    );

    const third = await postResponses(secondServer.httpHarness.baseUrl);
    assert.equal(third.status, 200);
    assert.match(third.body, /ok-from-backup-503/);
    assert.equal(primaryHits - beforeRestartPrimaryHits, 1);
    assert.equal(backupHits - beforeRestartBackupHits, 1);
    assert.equal(primaryHits, 4, 'restart should clear runtime cooldown so primary is probed once again');

    return {
      firstRequest: { primaryHits: 1, backupHits: 1 },
      secondRequestTotals: { primaryHits: 2, backupHits: 2 },
      thirdRequestTotals: { primaryHits: 3, backupHits: 3 },
      fourthRequestTotals: { primaryHits: beforeRestartPrimaryHits, backupHits: beforeRestartBackupHits },
      restartRequest: {
        primaryHitsDelta: primaryHits - beforeRestartPrimaryHits,
        backupHitsDelta: backupHits - beforeRestartBackupHits
      },
      primaryErrorAttempts: primaryHits,
      providerHealth: healthSummary
    };
  });
}

async function run502Scenario() {
  return withScenarioRuntime({ maxProviderAttempts: 6, responsesTimeoutMs: 40000 }, async (ctx) => {
    let primaryHits = 0;
    let backupHits = 0;

    const primaryUpstream = ctx.trackServer(
      await createMockUpstream({
        status: 502,
        body: { error: { message: 'bad gateway', code: 'HTTP_502' } },
        onHit: () => {
          primaryHits += 1;
        }
      })
    );
    const backupUpstream = ctx.trackServer(
      await createMockUpstream({
        status: 200,
        body: buildResponsesOkBody('ok-from-backup-502'),
        onHit: () => {
          backupHits += 1;
        }
      })
    );

    const userConfig = buildUserConfig(primaryUpstream.baseUrl, backupUpstream.baseUrl);
    const server = ctx.trackServer(
      await createHarnessServer({
        userConfig,
        RouteCodexHttpServer: ctx.RouteCodexHttpServer,
        handleResponses: ctx.handleResponses
      })
    );

    const first = await postResponses(server.httpHarness.baseUrl);
    assert.equal(first.status, 200, 'first request should recover after 3 internal 502 failures');
    assert.match(first.body, /ok-from-backup-502/);
    assert.equal(primaryHits, 3, 'first request should hit primary three times before threshold cooldown trips');
    assert.equal(backupHits, 1, 'first request should reroute to backup after threshold cooldown trips');

    const healthAfterFirst = server.routeCodex.virtualRouter?.getStatus?.()?.health ?? [];
    const primaryStateAfterFirst = Array.isArray(healthAfterFirst)
      ? healthAfterFirst.find((entry) => typeof entry?.provider_key === 'string' ? entry.provider_key.startsWith('primary.') : entry?.providerKey?.startsWith?.('primary.'))
      : undefined;
    assert.ok(primaryStateAfterFirst, '502 scenario should mark primary in health state after threshold cooldown');

    const second = await postResponses(server.httpHarness.baseUrl);
    assert.equal(second.status, 200, 'second request should skip cooled-down primary and go straight to backup');
    assert.match(second.body, /ok-from-backup-502/);
    assert.equal(primaryHits, 3, 'second request must not hit primary again after 3 consecutive 502 failures');
    assert.equal(backupHits, 2, 'second request should hit backup directly');

    const health = server.routeCodex.virtualRouter?.getStatus?.()?.health ?? [];
    const primaryState = Array.isArray(health)
      ? health.find((entry) => typeof entry?.provider_key === 'string' ? entry.provider_key.startsWith('primary.') : entry?.providerKey?.startsWith?.('primary.'))
      : undefined;
    assert.equal(primaryHits, 3, '502 scenario should reach exactly three primary provider attempts before cooldown');

    return {
      firstRequestTotals: { primaryHits: 3, backupHits: 1 },
      secondRequestTotals: { primaryHits, backupHits: 2 },
      primaryErrorAttempts: primaryHits,
      primaryHealthState: primaryState ?? null
    };
  });
}

async function runAuthQuotaScenario({ label, status, code, marker }) {
  return withScenarioRuntime({ maxProviderAttempts: 3, responsesTimeoutMs: 15000 }, async (ctx) => {
    let primaryHits = 0;
    let backupHits = 0;

    const primaryUpstream = ctx.trackServer(
      await createMockUpstream({
        status,
        body: {
          error: {
            message: `${label} primary failure`,
            code
          }
        },
        onHit: () => {
          primaryHits += 1;
        }
      })
    );
    const backupUpstream = ctx.trackServer(
      await createMockUpstream({
        status: 200,
        body: buildResponsesOkBody(marker),
        onHit: () => {
          backupHits += 1;
        }
      })
    );

    const userConfig = buildUserConfig(primaryUpstream.baseUrl, backupUpstream.baseUrl);
    const server = ctx.trackServer(
      await createHarnessServer({
        userConfig,
        RouteCodexHttpServer: ctx.RouteCodexHttpServer,
        handleResponses: ctx.handleResponses
      })
    );

    const first = await postResponses(server.httpHarness.baseUrl);
    assert.equal(
      first.status,
      200,
      `${label} provider error must reroute to backup instead of returning client-visible ${status}`
    );
    assert.match(first.body, new RegExp(marker));
    assert.equal(primaryHits, 1, `${label} should hit failing primary exactly once before exclusion`);
    assert.equal(backupHits, 1, `${label} should hit backup after primary exclusion`);

    return {
      status,
      code,
      primaryHits,
      backupHits,
      clientStatus: first.status
    };
  });
}


async function runPortIsolationScenario() {
  return withScenarioRuntime({ maxProviderAttempts: 3, responsesTimeoutMs: 15000 }, async (ctx) => {
    const hits = { primarya: 0, backupa: 0, primaryb: 0, backupb: 0 };
    const primarya = ctx.trackServer(await createMockUpstream({
      status: 503,
      body: { error: { message: 'a unavailable', code: 'HTTP_503' } },
      onHit: () => { hits.primarya += 1; }
    }));
    const backupa = ctx.trackServer(await createMockUpstream({
      status: 200,
      body: buildResponsesOkBody('ok-from-backup-a'),
      onHit: () => { hits.backupa += 1; }
    }));
    const primaryb = ctx.trackServer(await createMockUpstream({
      status: 200,
      body: buildResponsesOkBody('ok-from-primary-b'),
      onHit: () => { hits.primaryb += 1; }
    }));
    const backupb = ctx.trackServer(await createMockUpstream({
      status: 200,
      body: buildResponsesOkBody('ok-from-backup-b'),
      onHit: () => { hits.backupb += 1; }
    }));

    const userConfig = buildPortIsolationUserConfig({
      primarya: primarya.baseUrl,
      backupa: backupa.baseUrl,
      primaryb: primaryb.baseUrl,
      backupb: backupb.baseUrl
    });
    const server = ctx.trackServer(await createHarnessServer({
      userConfig,
      RouteCodexHttpServer: ctx.RouteCodexHttpServer,
      handleResponses: ctx.handleResponses
    }));

    const aFirst = await postResponses(server.httpHarness.baseUrl, { port: 5555 });
    assert.equal(aFirst.status, 200, 'port 5555 should recover within group A');
    assert.match(aFirst.body, /ok-from-backup-a/);
    assert.deepEqual(hits, { primarya: 1, backupa: 1, primaryb: 0, backupb: 0 }, 'port 5555 must not see group B pool');

    const aSecond = await postResponses(server.httpHarness.baseUrl, { port: 5555 });
    assert.equal(aSecond.status, 200, 'second 503 in group A should still probe primarya before backup');
    assert.match(aSecond.body, /ok-from-backup-a/);
    assert.deepEqual(hits, { primarya: 2, backupa: 2, primaryb: 0, backupb: 0 }, 'group A should accumulate runtime-only failures locally');

    const aThird = await postResponses(server.httpHarness.baseUrl, { port: 5555 });
    assert.equal(aThird.status, 200, 'third 503 in group A should still recover within the same request');
    assert.match(aThird.body, /ok-from-backup-a/);
    assert.deepEqual(hits, { primarya: 3, backupa: 3, primaryb: 0, backupb: 0 }, 'third group A request should trip runtime cooldown after the request');

    const bFirst = await postResponses(server.httpHarness.baseUrl, { port: 6666 });
    assert.equal(bFirst.status, 200, 'port 6666 should route within group B');
    assert.match(bFirst.body, /ok-from-primary-b/);
    assert.deepEqual(hits, { primarya: 3, backupa: 3, primaryb: 1, backupb: 0 }, 'group A runtime cooldown must not affect group B');

    const aFourth = await postResponses(server.httpHarness.baseUrl, { port: 5555 });
    assert.equal(aFourth.status, 200, 'fourth group A request should skip runtime-cooled primarya');
    assert.match(aFourth.body, /ok-from-backup-a/);
    assert.deepEqual(hits, { primarya: 3, backupa: 4, primaryb: 1, backupb: 0 }, 'port 5555 must stay isolated after local runtime cooldown');

    const bSecond = await postResponses(server.httpHarness.baseUrl, { port: 6666 });
    assert.equal(bSecond.status, 200, 'group B should remain unaffected after group A cooldown is active');
    assert.match(bSecond.body, /ok-from-primary-b/);
    assert.deepEqual(hits, { primarya: 3, backupa: 4, primaryb: 2, backupb: 0 }, 'group B must remain isolated after group A cooldown');

    return { hits };
  });
}

async function main() {
  const result503 = await run503Scenario();
  const result401 = await runAuthQuotaScenario({
    label: 'HTTP_401',
    status: 401,
    code: 'HTTP_401',
    marker: 'ok-from-backup-401'
  });
  const result403 = await runAuthQuotaScenario({
    label: 'HTTP_403',
    status: 403,
    code: 'HTTP_403',
    marker: 'ok-from-backup-403'
  });
  const resultQuota = await runAuthQuotaScenario({
    label: 'INSUFFICIENT_QUOTA',
    status: 429,
    code: 'INSUFFICIENT_QUOTA',
    marker: 'ok-from-backup-quota'
  });
  const resultPortIsolation = await runPortIsolationScenario();
  const include502 = process.argv.includes('--include-502');
  const result502 = include502 ? await run502Scenario() : undefined;
  console.log(
    JSON.stringify(
      {
        ok: true,
        scenario503: result503,
        scenario401: result401,
        scenario403: result403,
        scenarioInsufficientQuota: resultQuota,
        portIsolation: resultPortIsolation,
        ...(result502 ? { scenario502: result502 } : {})
      },
      null,
      2
    )
  );
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error('[provider-failure-ban-blackbox] failed');
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    setImmediate(() => process.exit(process.exitCode ?? 0));
  });
