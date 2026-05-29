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
  app.use(express.json({ limit: '4mb' }));
  app.post(['/', '/responses'], (req, res) => {
    hits.push({ label, body: req.body });
    res.json(responseBody(`ok-${label}`));
  });
  return listen(http.createServer(app));
}

function provider(id, endpoint) {
  return {
    id,
    providerType: 'responses',
    type: 'responses',
    endpoint,
    auth: { type: 'apikey', apiKey: `${id}-`.padEnd(24, 'x') },
    models: { 'gpt-5.4': {} }
  };
}

function buildConfig({ codingBase, defaultBase }) {
  const routing = {
    coding: [{ id: 'coding', priority: 100, mode: 'priority', targets: ['codingp.gpt-5.4'] }],
    thinking: [{ id: 'thinking', priority: 90, mode: 'priority', targets: ['defaultp.gpt-5.4'] }],
    tools: [{ id: 'tools', priority: 80, mode: 'priority', targets: ['defaultp.gpt-5.4'] }],
    search: [{ id: 'search', priority: 70, mode: 'priority', targets: ['defaultp.gpt-5.4'] }],
    default: [{ id: 'default', priority: 10, mode: 'priority', targets: ['defaultp.gpt-5.4'] }]
  };
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
      routingPolicyGroups: { gateway_priority_5555: { routing } },
      providers: {
        codingp: provider('codingp', codingBase),
        defaultp: provider('defaultp', defaultBase)
      },
      routing,
      quota: { apikeyDailyResetTime: '00:00' }
    }
  };
}

async function writeProviderConfigs(userConfig) {
  const providers = userConfig?.virtualrouter?.providers;
  const userDir = process.env.RCC_HOME || path.join(process.env.HOME, '.rcc');
  const providerRoot = path.join(userDir, 'provider');
  await fs.mkdir(providerRoot, { recursive: true });
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    const providerDir = path.join(providerRoot, providerId);
    await fs.mkdir(providerDir, { recursive: true });
    await fs.writeFile(
      path.join(providerDir, 'config.v2.json'),
      `${JSON.stringify({ version: '2.0.0', providerId, provider: providerConfig }, null, 2)}\n`,
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
  app.use(express.json({ limit: '4mb' }));
  app.post('/v1/responses', (req, res) => handleResponses(req, res, {
    executePipeline: (input) => routeCodex.executePortAwarePipeline(5555, input),
    errorHandling: routeCodex.errorHandling
  }));
  const httpHarness = await listen(http.createServer(app));
  return { routeCodex, httpHarness };
}

async function postResponses(baseUrl, body) {
  const res = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, text: await res.text() };
}

function msg(role, text) {
  return { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] };
}

function functionCall(name, callId, argumentsValue) {
  return { type: 'function_call', id: callId, call_id: callId, name, arguments: JSON.stringify(argumentsValue) };
}

function functionOutput(callId, output) {
  return { type: 'function_call_output', call_id: callId, output };
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-coding-current-turn-'));
  const restores = [
    setEnv('HOME', path.join(tmp, 'home')),
    setEnv('ROUTECODEX_SESSION_DIR', path.join(tmp, 'sessions')),
    setEnv('ROUTECODEX_SNAPSHOT', '0'),
    setEnv('ROUTECODEX_SERVERTOOL_ENABLED', '0'),
    setEnv('ROUTECODEX_HTTP_RESPONSES_TIMEOUT_MS', '15000')
  ];
  let codingServer;
  let defaultServer;
  let harness;
  try {
    await fs.mkdir(process.env.HOME, { recursive: true });
    await fs.mkdir(process.env.ROUTECODEX_SESSION_DIR, { recursive: true });
    const codingHits = [];
    const defaultHits = [];
    codingServer = await createUpstream({ label: 'coding', hits: codingHits });
    defaultServer = await createUpstream({ label: 'default', hits: defaultHits });
    harness = await createHarness(buildConfig({ codingBase: codingServer.baseUrl, defaultBase: defaultServer.baseUrl }));

    const declaredOnly = await postResponses(harness.httpHarness.baseUrl, {
      model: 'gpt-5.4',
      input: [msg('user', 'please inspect the repository')],
      tools: [{ type: 'function', function: { name: 'apply_patch', description: 'write files', parameters: { type: 'object' } } }],
      stream: false
    });
    assert.equal(declaredOnly.status, 200, declaredOnly.text);
    assert.match(declaredOnly.text, /ok-default/, 'declaring apply_patch must not route to coding');
    assert.equal(codingHits.length, 0, 'tool declaration alone must not hit coding provider');

    const writeTurn = await postResponses(harness.httpHarness.baseUrl, {
      model: 'gpt-5.4',
      input: [
        msg('user', 'apply this patch'),
        functionCall('apply_patch', 'call_patch', { patch: '*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch' }),
        functionOutput('call_patch', 'APPLY_PATCH_APPLIED')
      ],
      stream: false
    });
    assert.equal(writeTurn.status, 200, writeTurn.text);
    assert.match(writeTurn.text, /ok-coding/, 'actual apply_patch turn must route to coding');
    assert.equal(codingHits.length, 1, 'actual write operation must hit coding exactly once');

    const readAfterWriteSameSegment = await postResponses(harness.httpHarness.baseUrl, {
      model: 'gpt-5.4',
      input: [
        msg('user', 'continue working'),
        functionCall('apply_patch', 'call_old_patch', { patch: '*** Begin Patch\n*** Add File: old.txt\n+old\n*** End Patch' }),
        functionOutput('call_old_patch', 'APPLY_PATCH_APPLIED'),
        functionCall('read_file', 'call_read', { path: 'old.txt' }),
        functionOutput('call_read', 'old contents')
      ],
      stream: false
    });
    assert.equal(readAfterWriteSameSegment.status, 200, readAfterWriteSameSegment.text);
    assert.match(readAfterWriteSameSegment.text, /ok-default/, 'latest read_file turn must not inherit earlier apply_patch coding route');
    assert.equal(codingHits.length, 1, 'historical coding tool in same segment must not add another coding hit');

    const updatePlanAfterWriteSameSegment = await postResponses(harness.httpHarness.baseUrl, {
      model: 'gpt-5.4',
      input: [
        msg('user', 'continue working'),
        functionCall('apply_patch', 'call_old_patch_2', { patch: '*** Begin Patch\n*** Add File: old2.txt\n+old\n*** End Patch' }),
        functionOutput('call_old_patch_2', 'APPLY_PATCH_APPLIED'),
        functionCall('update_plan', 'call_plan', { plan: [{ step: 'read', status: 'completed' }] }),
        functionOutput('call_plan', 'plan updated')
      ],
      stream: false
    });
    assert.equal(updatePlanAfterWriteSameSegment.status, 200, updatePlanAfterWriteSameSegment.text);
    assert.match(updatePlanAfterWriteSameSegment.text, /ok-default/, 'latest update_plan turn must not inherit earlier apply_patch coding route');
    assert.equal(codingHits.length, 1, 'update_plan after write must not add coding hit');

    console.log(JSON.stringify({ ok: true, codingHits: codingHits.length, defaultHits: defaultHits.length }, null, 2));
  } finally {
    await close(harness?.httpHarness?.server);
    await harness?.routeCodex?.disposeProviders?.().catch(() => {});
    await close(codingServer?.server);
    await close(defaultServer?.server);
    for (const restore of restores.reverse()) restore();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

main().then(() => {
  setTimeout(() => process.exit(0), 20).unref();
}).catch((error) => {
  console.error('[virtual-router-coding-current-turn-blackbox] failed');
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
