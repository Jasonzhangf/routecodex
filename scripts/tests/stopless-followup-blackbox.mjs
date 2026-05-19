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
  return () => {
    if (old === undefined) delete process.env[name]; else process.env[name] = old;
  };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  return { server, baseUrl: `http://127.0.0.1:${a.port}` };
}

async function close(server) {
  if (!server) return;
  await new Promise((r) => server.close(() => r()));
}

function buildConfig(upstreamBase) {
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
            thinking: [{ id: 'thinking', priority: 100, mode: 'priority', targets: ['crs.gpt-5.3-codex'] }],
            default: [{ id: 'default', priority: 10, mode: 'priority', targets: ['crs.gpt-5.3-codex'] }]
          }
        }
      },
      providers: {
        crs: {
          id: 'crs',
          type: 'responses',
          endpoint: upstreamBase,
          auth: { type: 'apikey', apiKey: 'x'.repeat(24) },
          models: { 'gpt-5.3-codex': {} }
        }
      },
      routing: {
        thinking: [{ id: 'thinking', priority: 100, mode: 'priority', targets: ['crs.gpt-5.3-codex'] }],
        default: [{ id: 'default', priority: 10, mode: 'priority', targets: ['crs.gpt-5.3-codex'] }]
      },
      quota: { apikeyDailyResetTime: '00:00' }
    }
  };
}

function upstreamResponse(text, finish = 'stop') {
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
    output_text: text,
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    finish_reason: finish
  };
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-stopless-blackbox-'));
  const home = path.join(tmp, 'home');
  const sessionDir = path.join(tmp, 'sessions');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });

  const restores = [
    setEnv('HOME', home),
    setEnv('ROUTECODEX_SESSION_DIR', sessionDir),
    setEnv('ROUTECODEX_SNAPSHOT', '0'),
    setEnv('ROUTECODEX_SERVERTOOL_ENABLED', '1'),
    setEnv('ROUTECODEX_HTTP_RESPONSES_TIMEOUT_MS', '15000'),
    setEnv('ROUTECODEX_MAX_PROVIDER_ATTEMPTS', '2')
  ];

  let upstreamServer;
  let harnessServer;

  try {
    const upstreamHits = [];
    let followupSeen = false;

    const upstreamApp = express();
    upstreamApp.use(express.json({ limit: '2mb' }));
    upstreamApp.post('/responses', (req, res) => {
      upstreamHits.push(req.body);
      const isFollowup = String(req.body?.metadata?.__rt?.serverToolFollowup || '') === 'true'
        || String(req.body?.request_id || '').includes(':stop_followup')
        || (Array.isArray(req.body?.input) && JSON.stringify(req.body.input).includes('继续执行'));
      if (isFollowup) followupSeen = true;
      // first response deliberately ends with stop to trigger stopless
      if (upstreamHits.length === 1) {
        return res.json(upstreamResponse('阶段完成', 'stop'));
      }
      return res.json(upstreamResponse('继续执行中', 'stop'));
    });
    upstreamServer = await listen(http.createServer(upstreamApp));

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

    await routeCodex.initializeWithUserConfig(buildConfig(upstreamServer.baseUrl));

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.post('/v1/responses', (req, res) => handleResponses(req, res, {
      executePipeline: (input) => routeCodex.executePortAwarePipeline(5555, input),
      errorHandling: routeCodex.errorHandling
    }));
    harnessServer = await listen(http.createServer(app));

    const sessionId = `sess_${Date.now()}`;
    const resp = await fetch(`${harnessServer.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        stream: false,
        metadata: { sessionId },
        input: [{
          role: 'user',
          content: [{ type: 'input_text', text: '请直接回复一句“阶段完成”，然后结束。<**stopless:on**>' }]
        }]
      })
    });

    const text = await resp.text();
    assert.equal(resp.status, 200, `expected 200, got ${resp.status}, body=${text}`);
    assert.ok(upstreamHits.length >= 2, `expected upstream >=2 hits (initial + followup), got ${upstreamHits.length}`);
    assert.ok(followupSeen, 'expected stopless followup request to be seen by upstream');

    console.log('✅ stopless blackbox passed', JSON.stringify({
      upstreamHits: upstreamHits.length,
      followupSeen,
      status: resp.status
    }));
  } finally {
    await close(harnessServer?.server);
    await close(upstreamServer?.server);
    for (const r of restores.reverse()) r();
  }
}

main().catch((err) => {
  console.error('❌ stopless blackbox failed');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
