#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

function setEnv(name, value) { const old = process.env[name]; process.env[name] = value; return () => { if (old === undefined) delete process.env[name]; else process.env[name] = old; }; }
async function listen(server) { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const a = server.address(); return { server, baseUrl: `http://127.0.0.1:${a.port}` }; }
async function close(server) { if (server) await new Promise((resolve) => server.close(() => resolve())); }
function toolCallResponse() { return { id: 'resp_cross_port_1', object: 'response', status: 'completed', model: 'gpt-5.4', output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{}' }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }; }
function textResponse(text) { return { id: `resp_${text}_${Date.now()}`, object: 'response', status: 'completed', model: 'gpt-5.4', output: [{ id: `msg_${Date.now()}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }; }
async function upstream(label, hits) {
  const app = express(); app.use(express.json({ limit: '4mb' }));
  app.get(['/models', '/v1/models'], (_req, res) => res.json({ data: [{ id: 'gpt-5.4' }] }));
  app.use((req, res) => { if (req.method !== 'POST') return res.status(405).end(); hits.push(label); return res.json(label === 'a1' && hits.filter((x) => x === 'a1').length === 1 ? toolCallResponse() : textResponse(`ok-${label}`)); });
  return listen(http.createServer(app));
}
function provider(id, endpoint) { return { id, type: 'responses', endpoint, checkHealth: false, auth: { type: 'apikey', apiKey: `${id}-`.padEnd(24, 'x') }, models: { 'gpt-5.4': {} }, responses: { streaming: 'never' } }; }
function config(urls) { return { version: '1.0.0', httpserver: { host: '127.0.0.1', port: 5555, ports: [{ port: 5555, host: '127.0.0.1', mode: 'router', routingPolicyGroup: 'group_a', sameProtocolBehavior: 'direct' }, { port: 6666, host: '127.0.0.1', mode: 'router', routingPolicyGroup: 'group_b', sameProtocolBehavior: 'direct' }] }, virtualrouter: { activeRoutingPolicyGroup: 'group_a', routingPolicyGroups: { group_a: { routing: { default: [{ id: 'a-default', priority: 10, mode: 'priority', targets: ['a1.gpt-5.4'] }] } }, group_b: { routing: { default: [{ id: 'b-default', priority: 10, mode: 'priority', targets: ['b1.gpt-5.4'] }] } } }, providers: { a1: provider('a1', urls.a1), b1: provider('b1', urls.b1) }, quota: { apikeyDailyResetTime: '00:00' } } }; }
async function writeProviders(userConfig) { const root = path.join(process.env.RCC_HOME, 'provider'); await fs.mkdir(root, { recursive: true }); for (const [id, providerConfig] of Object.entries(userConfig.virtualrouter.providers)) { const dir = path.join(root, id); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'config.v2.json'), JSON.stringify({ version: '2.0.0', providerId: id, provider: providerConfig }, null, 2)); } }
async function post(baseUrl, port, body) { const res = await fetch(`${baseUrl}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-rcc-test-port': String(port) }, body: JSON.stringify(body) }); return { status: res.status, text: await res.text() }; }
async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-continuation-port-isolation-'));
  const restores = [setEnv('HOME', path.join(tmp, 'home')), setEnv('RCC_HOME', path.join(tmp, 'home', '.rcc')), setEnv('ROUTECODEX_SESSION_DIR', path.join(tmp, 'sessions')), setEnv('ROUTECODEX_SNAPSHOT', '0'), setEnv('ROUTECODEX_SERVERTOOL_ENABLED', '0'), setEnv('ROUTECODEX_HTTP_RESPONSES_TIMEOUT_MS', '15000')];
  let a1; let b1; let harness; let routeCodex;
  try {
    await fs.mkdir(process.env.RCC_HOME, { recursive: true }); await fs.mkdir(process.env.ROUTECODEX_SESSION_DIR, { recursive: true });
    const hits = [];
    a1 = await upstream('a1', hits); b1 = await upstream('b1', hits);
    const userConfig = config({ a1: a1.baseUrl, b1: b1.baseUrl }); await writeProviders(userConfig);
    const runtimeConfig = JSON.parse(JSON.stringify(userConfig)); delete runtimeConfig.virtualrouter.providers;
    const { RouteCodexHttpServer } = await import('../../dist/server/runtime/http-server/index.js');
    const { handleResponses } = await import('../../dist/server/handlers/responses-handler.js');
    routeCodex = new RouteCodexHttpServer({ server: { host: '127.0.0.1', port: 5555 }, pipeline: {}, logging: { level: 'error', enableConsole: false }, providers: {} });
    routeCodex.managerDaemon = { getModule: (id) => id === 'quota' ? ({ registerProviderStaticConfig: () => {}, getQuotaView: () => (providerKey) => ({ providerKey, inPool: true, priorityTier: 100 }), getQuotaViewReadOnly: () => (providerKey) => ({ providerKey, inPool: true, priorityTier: 100 }) }) : undefined };
    await routeCodex.initializeWithUserConfig(runtimeConfig);
    const app = express(); app.use(express.json({ limit: '4mb' }));
    app.post('/v1/responses', (req, res) => { const port = Number(req.headers['x-rcc-test-port'] ?? 5555); return handleResponses(req, res, { executePipeline: (input) => routeCodex.executePortAwarePipeline(port, input), errorHandling: routeCodex.errorHandling, portContext: { localPort: port, matchedPort: port, routingPolicyGroup: port === 6666 ? 'group_b' : 'group_a', logNamespace: `server-${port}` } }); });
    harness = await listen(http.createServer(app));
    const sessionId = `cross-port-${Date.now()}`;
    const first = await post(harness.baseUrl, 5555, { model: 'gpt-5.4', store: true, input: [{ role: 'user', content: [{ type: 'input_text', text: 'seed tool call on port A' }] }], tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }], metadata: { sessionId }, stream: false });
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(hits, ['a1']);
    const second = await post(harness.baseUrl, 6666, { model: 'gpt-5.4', response_id: 'resp_cross_port_1', tool_outputs: [{ tool_call_id: 'call_1', output: 'ok' }], metadata: { sessionId }, stream: false });
    assert.notEqual(second.status, 200, `cross-port continuation must not succeed: ${second.text}`);
    assert.deepEqual(hits, ['a1'], `port B must not see or route to port A continuation provider, hits=${JSON.stringify(hits)}`);
    console.log(JSON.stringify({ ok: true, firstStatus: first.status, secondStatus: second.status, hits }, null, 2));
  } finally { await close(harness?.server); await routeCodex?.disposeProviders?.().catch(() => {}); await close(a1?.server); await close(b1?.server); for (const r of restores.reverse()) r(); await fs.rm(tmp, { recursive: true, force: true }); }
}
main().then(() => setTimeout(() => process.exit(0), 20).unref()).catch((e) => { console.error(e?.stack || e); setTimeout(() => process.exit(1), 20).unref(); });
