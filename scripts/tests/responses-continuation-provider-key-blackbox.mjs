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
async function close(server) { if (server) await new Promise((resolve) => server.close(() => resolve())); }
function textResponse(text) {
  return { id: `resp_${text}_${Date.now()}`, object: 'response', status: 'completed', model: 'gpt-5.4', output: [{ id: `msg_${Date.now()}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] }], output_text: text, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
}
function toolCallResponse() {
  return { id: 'resp_continuation_1', object: 'response', status: 'completed', model: 'gpt-5.4', output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{}' }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
}
async function createUpstream({ label, hits }) {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.get(['/models', '/v1/models'], (_req, res) => {
    res.status(404).json({ error: { message: 'models endpoint intentionally unavailable in harness' } });
  });
  app.use((req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: { message: 'method not allowed', method: req.method, path: req.path } });
      return;
    }
    hits.push({ label, body: req.body, path: req.path, method: req.method });
    if (label === 'p1' && hits.filter((h) => h.label === 'p1').length === 1) res.json(toolCallResponse());
    else res.json(textResponse(`ok-${label}`));
  });
  return listen(http.createServer(app));
}
function provider(id, endpoint) {
  return { id, providerType: 'responses', type: 'responses', endpoint, auth: { type: 'apikey', apiKey: `${id}-`.padEnd(24, 'x') }, models: { 'gpt-5.4': {} }, responses: { streaming: 'never' } };
}
function buildConfig(p1Base, p2Base, sameProtocolBehavior, label) {
  const p1Id = `p1${label.replace(/[^a-z0-9]+/gi, '')}`;
  const p2Id = `p2${label.replace(/[^a-z0-9]+/gi, '')}`;
  const routing = { default: [{ id: 'default', priority: 10, mode: 'round-robin', targets: [`${p1Id}.gpt-5.4`, `${p2Id}.gpt-5.4`] }] };
  return { version: '1.0.0', httpserver: { host: '127.0.0.1', port: 5555, ports: [{ port: 5555, host: '127.0.0.1', mode: 'router', routingPolicyGroup: 'gateway_priority_5555', sameProtocolBehavior }] }, virtualrouter: { routingPolicyGroups: { gateway_priority_5555: { routing } }, providers: { [p1Id]: provider(p1Id, p1Base), [p2Id]: provider(p2Id, p2Base) }, routing, quota: { apikeyDailyResetTime: '00:00' } } };
}
async function writeProviderConfigs(userConfig) {
  const providerRoot = path.join(process.env.RCC_HOME || path.join(process.env.HOME, '.rcc'), 'provider');
  await fs.mkdir(providerRoot, { recursive: true });
  for (const [providerId, providerConfig] of Object.entries(userConfig.virtualrouter.providers)) {
    const providerDir = path.join(providerRoot, providerId);
    await fs.mkdir(providerDir, { recursive: true });
    await fs.writeFile(path.join(providerDir, 'config.v2.json'), `${JSON.stringify({ version: '2.0.0', providerId, provider: providerConfig }, null, 2)}\n`);
  }
}
async function post(baseUrl, body) {
  const res = await fetch(`${baseUrl}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}
async function runScenario({ sameProtocolBehavior, expectedSecondProvider, label }) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `rcc-continuation-${label}-`));
  const restores = [
    setEnv('HOME', path.join(tmp, 'home')),
    setEnv('RCC_HOME', path.join(tmp, 'home', '.rcc')),
    setEnv('ROUTECODEX_SESSION_DIR', path.join(tmp, 'sessions')),
    setEnv('ROUTECODEX_SNAPSHOT', '0'),
    setEnv('ROUTECODEX_SERVERTOOL_ENABLED', '0'),
    setEnv('ROUTECODEX_HTTP_RESPONSES_TIMEOUT_MS', '15000')
  ];
  let p1; let p2; let harness; let routeCodex;
  try {
    await fs.mkdir(process.env.HOME, { recursive: true });
    await fs.mkdir(process.env.ROUTECODEX_SESSION_DIR, { recursive: true });
    const hits = [];
    p1 = await createUpstream({ label: 'p1', hits });
    p2 = await createUpstream({ label: 'p2', hits });
    const userConfig = buildConfig(p1.baseUrl, p2.baseUrl, sameProtocolBehavior, label);
    await writeProviderConfigs(userConfig);
    const { RouteCodexHttpServer } = await import('../../dist/server/runtime/http-server/index.js');
    const { handleResponses } = await import('../../dist/server/handlers/responses-handler.js');
    routeCodex = new RouteCodexHttpServer({ server: { host: '127.0.0.1', port: 5555 }, pipeline: {}, logging: { level: 'error', enableConsole: false }, providers: {} });
    routeCodex.managerDaemon = { getModule(id) { if (id !== 'quota') return undefined; return { registerProviderStaticConfig: () => {}, getQuotaView: () => (providerKey) => ({ providerKey, inPool: true, priorityTier: 100 }), getQuotaViewReadOnly: () => (providerKey) => ({ providerKey, inPool: true, priorityTier: 100 }) }; } };
    await routeCodex.initializeWithUserConfig(userConfig);
    const app = express();
    app.use(express.json({ limit: '4mb' }));
    app.post('/v1/responses', (req, res) => handleResponses(req, res, { executePipeline: (input) => routeCodex.executePortAwarePipeline(5555, input), errorHandling: routeCodex.errorHandling }));
    harness = await listen(http.createServer(app));
    const sessionId = `continuation-${label}-${Date.now()}`;
    if (sameProtocolBehavior === 'relay') {
      const advance = await post(harness.baseUrl, { model: 'gpt-5.4', input: [{ role: 'user', content: [{ type: 'input_text', text: 'advance round robin' }] }], metadata: { sessionId }, stream: false });
      assert.equal(advance.status, 200, `${advance.text} hits=${JSON.stringify(hits)}`);
      assert.equal(hits[0]?.label, 'p1', `${label}: advance request should hit p1`);
      const { captureResponsesRequestContextForRequest, recordResponsesResponseForRequest } = await import('../../dist/modules/llmswitch/bridge.js');
      const seedRequestId = `seed-${label}-${Date.now()}`;
      await captureResponsesRequestContextForRequest({
        requestId: seedRequestId,
        payload: { model: 'gpt-5.4', store: true, input: [{ role: 'user', content: [{ type: 'input_text', text: 'call tool' }] }], tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }], metadata: { sessionId }, stream: false },
        context: { input: [{ role: 'user', content: [{ type: 'input_text', text: 'call tool' }] }], toolsRaw: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }] },
        sessionId,
        providerKey: 'p1'
      });
      await recordResponsesResponseForRequest({ requestId: seedRequestId, response: toolCallResponse(), sessionId, providerKey: 'p1' });
      const resumed = await post(harness.baseUrl, { model: 'gpt-5.4', response_id: 'resp_continuation_1', tool_outputs: [{ tool_call_id: 'call_1', output: 'ok' }], metadata: { sessionId }, stream: false });
      assert.equal(resumed.status, 200, `${resumed.text} hits=${JSON.stringify(hits)}`);
      assert.equal(hits[1]?.label, expectedSecondProvider, `${label}: local/relay continuation must not pin provider; hits=${JSON.stringify(hits.map((h) => h.label))}`);
      return { label, sameProtocolBehavior, hits: hits.map((h) => h.label) };
    }
    const first = await post(harness.baseUrl, { model: 'gpt-5.4', store: true, input: [{ role: 'user', content: [{ type: 'input_text', text: 'call tool' }] }], tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }], metadata: { sessionId }, stream: false });
    assert.equal(first.status, 200, `${first.text} hits=${JSON.stringify(hits)}`);
    assert.equal(hits[0]?.label, 'p1', `${label}: seed request should hit p1`);
    const second = await post(harness.baseUrl, { model: 'gpt-5.4', response_id: 'resp_continuation_1', tool_outputs: [{ tool_call_id: 'call_1', output: 'ok' }], metadata: { sessionId }, stream: false });
    assert.equal(second.status, 200, `${second.text} hits=${JSON.stringify(hits)}`);
    assert.equal(hits[1]?.label, expectedSecondProvider, `${label}: continuation provider mismatch; hits=${JSON.stringify(hits.map((h) => h.label))}`);
    return { label, sameProtocolBehavior, hits: hits.map((h) => h.label) };
  } finally {
    await close(harness?.server);
    await routeCodex?.disposeProviders?.().catch(() => {});
    await close(p1?.server);
    await close(p2?.server);
    for (const r of restores.reverse()) r();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

function runScenarioChild(name) {
  const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname], {
    env: { ...process.env, RCC_CONTINUATION_SCENARIO: name },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  });
  if (child.stdout) {
    process.stdout.write(child.stdout);
  }
  assert.equal(child.status, 0, `${name} child failed with status ${child.status}`);
  const resultLine = String(child.stdout || '').split(/\r?\n/).find((line) => line.startsWith('__RCC_CONTINUATION_RESULT__'));
  assert.ok(resultLine, `${name} child did not emit result marker`);
  return JSON.parse(resultLine.slice('__RCC_CONTINUATION_RESULT__'.length));
}

async function main() {
  const scenario = process.env.RCC_CONTINUATION_SCENARIO;
  if (scenario === 'direct') {
    const direct = await runScenario({ label: 'direct-remote', sameProtocolBehavior: 'direct', expectedSecondProvider: 'p1' });
    console.log(`__RCC_CONTINUATION_RESULT__${JSON.stringify(direct)}`);
    return;
  }
  if (scenario === 'relay') {
    const relay = await runScenario({ label: 'relay-local', sameProtocolBehavior: 'relay', expectedSecondProvider: 'p2' });
    console.log(`__RCC_CONTINUATION_RESULT__${JSON.stringify(relay)}`);
    return;
  }
  const direct = runScenarioChild('direct');
  const relay = runScenarioChild('relay');
  console.log(JSON.stringify({ ok: true, direct, relay }, null, 2));
}
main().then(() => setTimeout(() => process.exit(0), 20).unref()).catch((error) => { console.error('[responses-continuation-provider-key-blackbox] failed'); console.error(error instanceof Error ? error.stack || error.message : error); process.exit(1); });
