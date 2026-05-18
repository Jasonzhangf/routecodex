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

async function createMockUpstream({ status, body, onHit }) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.post('/responses', (req, res) => {
    onHit?.(req.body);
    res.status(status).json(body);
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

async function createHarnessServer({ userConfig, RouteCodexHttpServer, handleResponses }) {
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

  await routeCodex.initializeWithUserConfig(userConfig);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.post('/v1/responses', (req, res) =>
    handleResponses(req, res, {
      executePipeline: (input) => routeCodex.executePortAwarePipeline(5555, input),
      errorHandling: routeCodex.errorHandling
    }));

  const httpHarness = await listenHttpServer(http.createServer(app));
  return { routeCodex, httpHarness };
}

async function postResponses(baseUrl) {
  const res = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
  const sessionDir = path.join(tmpDir, 'sessions');
  const restores = [];
  let servers = [];
  try {
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });
    restores.push(
      setEnv('HOME', home),
      setEnv('ROUTECODEX_SESSION_DIR', sessionDir),
      setEnv('ROUTECODEX_SNAPSHOT', '0'),
      setEnv('ROUTECODEX_SERVERTOOL_ENABLED', '0'),
      setEnv('ROUTECODEX_HTTP_RESPONSES_TIMEOUT_MS', String(responsesTimeoutMs)),
      setEnv('ROUTECODEX_MAX_PROVIDER_ATTEMPTS', String(maxProviderAttempts))
    );
    const { RouteCodexHttpServer } = await import('../../dist/server/runtime/http-server/index.js');
    const { handleResponses } = await import('../../dist/server/handlers/responses-handler.js');
    const { __requestExecutorTestables } = await import('../../dist/server/runtime/http-server/request-executor.js');
    const ingress = await import(
      '../../sharedmodule/llmswitch-core/dist/router/virtual-router/provider-runtime-ingress.js'
    );
    const providerErrorEvents = [];
    const observerOwner = {};
    ingress.resetProviderRuntimeIngressForTests?.();
    ingress.setProviderRuntimeObserverHooks?.(observerOwner, {
      onProviderErrorReported(event) {
        providerErrorEvents.push({
          code: event?.code,
          stage: event?.stage,
          status: event?.status,
          recoverable: event?.recoverable,
          providerKey: event?.runtime?.providerKey
        });
      }
    });
    return await fn({
      tmpDir,
      sessionDir,
      RouteCodexHttpServer,
      handleResponses,
      __requestExecutorTestables,
      providerErrorEvents,
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
    assert.equal(primaryHits, 1);
    assert.equal(backupHits, 2);

    const providerHealthPath = path.join(ctx.sessionDir, 'provider-health.json');
    const persisted = JSON.parse(await fs.readFile(providerHealthPath, 'utf8'));
    const healthSummary = summarizeHealthFile(persisted);
    assert.ok(
      healthSummary.providerCooldowns.some(
        (entry) =>
          typeof entry.providerKey === 'string'
          && entry.providerKey.startsWith('primary.')
          && entry.reason === '__http_503_daily_cooldown__'
      )
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
    assert.equal(primaryHits - beforeRestartPrimaryHits, 0);
    assert.equal(backupHits - beforeRestartBackupHits, 1);
    const primaryEvents = ctx.providerErrorEvents.filter(
      (event) => typeof event.providerKey === 'string' && event.providerKey.startsWith('primary.')
    );
    assert.equal(primaryEvents.length, 1, '503 scenario should report exactly one primary error event');

    return {
      firstRequest: { primaryHits: 1, backupHits: 1 },
      secondRequestTotals: { primaryHits, backupHits: 2 },
      restartRequest: {
        primaryHitsDelta: primaryHits - beforeRestartPrimaryHits,
        backupHitsDelta: backupHits - beforeRestartBackupHits
      },
      primaryErrorEvents: primaryEvents,
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

    const second = await postResponses(server.httpHarness.baseUrl);
    assert.equal(second.status, 200, 'second request should skip cooled-down primary and go straight to backup');
    assert.match(second.body, /ok-from-backup-502/);
    assert.equal(primaryHits, 3, 'second request must not hit primary again after 3 consecutive 502 failures');
    assert.equal(backupHits, 2, 'second request should hit backup directly');

    const health = server.routeCodex.virtualRouter?.getStatus?.()?.health ?? [];
    const primaryState = Array.isArray(health)
      ? health.find((entry) => typeof entry?.provider_key === 'string' ? entry.provider_key.startsWith('primary.') : entry?.providerKey?.startsWith?.('primary.'))
      : undefined;
    const primaryEvents = ctx.providerErrorEvents.filter(
      (event) => typeof event.providerKey === 'string' && event.providerKey.startsWith('primary.')
    );
    assert.equal(primaryEvents.length, 3, '502 scenario should report exactly three primary error events');
    assert.ok(
      primaryEvents.every((event) => event.stage === 'provider.http'),
      '502 scenario should be reported only by provider runtime, not request-executor duplicate stages'
    );

    return {
      firstRequestTotals: { primaryHits: 3, backupHits: 1 },
      secondRequestTotals: { primaryHits, backupHits: 2 },
      primaryErrorEvents: primaryEvents,
      primaryHealthState: primaryState ?? null
    };
  });
}

async function main() {
  const result503 = await run503Scenario();
  const include502 = process.argv.includes('--include-502');
  const result502 = include502 ? await run502Scenario() : undefined;
  console.log(
    JSON.stringify(
      {
        ok: true,
        scenario503: result503,
        ...(result502 ? { scenario502: result502 } : {})
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('[provider-failure-ban-blackbox] failed');
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
