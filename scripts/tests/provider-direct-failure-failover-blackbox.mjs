#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

function setEnv(name, value) {
  const old = process.env[name];
  process.env[name] = value;
  return () => { if (old === undefined) delete process.env[name]; else process.env[name] = old; };
}
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address.port !== 'number') throw new Error('listen failed');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}
async function close(server) { if (server) await new Promise((resolve) => server.close(() => resolve())); }
function okBody(text) {
  return { id: `resp_${text}`, object: 'response', status: 'completed', model: 'gpt-5.3-codex', output: [{ id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
}
async function upstream({ status, body, onHit }) {
  const app = express(); app.use(express.json({ limit: '2mb' }));
  app.post('/v1/responses', (_req, res) => { onHit?.(); res.status(status).json(body); });
  app.post('/responses', (_req, res) => { onHit?.(); res.status(status).json(body); });
  app.get('/v1/models', (_req, res) => res.json({ data: [{ id: 'gpt-5.3-codex' }] }));
  return listen(http.createServer(app));
}
function config(primaryUrl, backupUrl) {
  return { version: '1.0.0', httpserver: { host: '127.0.0.1', port: 5555, ports: [{ port: 5555, host: '127.0.0.1', mode: 'router', routingPolicyGroup: 'gateway_priority_5555', sameProtocolBehavior: 'direct' }] }, virtualrouter: { routingPolicyGroups: { gateway_priority_5555: { routing: { thinking: [{ id: 'thinking', priority: 100, mode: 'priority', targets: ['primary.gpt-5.3-codex', 'backup.gpt-5.3-codex'] }], default: [{ id: 'default', priority: 10, mode: 'priority', targets: ['primary.gpt-5.3-codex', 'backup.gpt-5.3-codex'] }] } } }, providers: { primary: { id: 'primary', type: 'responses', endpoint: primaryUrl, checkHealth: false, auth: { type: 'apikey', apiKey: 'x'.repeat(24) }, models: { 'gpt-5.3-codex': {} } }, backup: { id: 'backup', type: 'responses', endpoint: backupUrl, checkHealth: false, auth: { type: 'apikey', apiKey: 'y'.repeat(24) }, models: { 'gpt-5.3-codex': {} } } }, quota: { apikeyDailyResetTime: '00:00' } } };
}
async function writeProviders(userConfig) {
  const root = path.join(process.env.RCC_HOME || path.join(process.env.HOME, '.rcc'), 'provider');
  await fs.mkdir(root, { recursive: true });
  for (const [id, provider] of Object.entries(userConfig.virtualrouter.providers)) {
    const dir = path.join(root, id); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'config.v2.json'), JSON.stringify({ version: '2.0.0', providerId: id, provider }, null, 2));
  }
}
async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-direct-failover-'));
  const home = path.join(tmp, 'home'); const sessionDir = path.join(tmp, 'sessions');
  await fs.mkdir(home, { recursive: true }); await fs.mkdir(sessionDir, { recursive: true });
  const restores = [setEnv('HOME', home), setEnv('RCC_HOME', path.join(home, '.rcc')), setEnv('ROUTECODEX_SESSION_DIR', sessionDir), setEnv('ROUTECODEX_SNAPSHOT', '0'), setEnv('ROUTECODEX_SERVERTOOL_ENABLED', '0'), setEnv('ROUTECODEX_HTTP_RESPONSES_TIMEOUT_MS', '15000'), setEnv('ROUTECODEX_MAX_PROVIDER_ATTEMPTS', '3'), setEnv('RCC_RECOVERABLE_BACKOFF_BASE_MS', '10'), setEnv('ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS', '10')];
  const servers = [];
  try {
    const traffic = await import('../../dist/server/runtime/http-server/provider-traffic-governor.js'); traffic.resetSharedProviderTrafficGovernorForTests?.();
    const { RouteCodexHttpServer } = await import('../../dist/server/runtime/http-server/index.js');
    const { handleResponses } = await import('../../dist/server/handlers/responses-handler.js');
    let primaryHits = 0; let backupHits = 0;
    const primary = await upstream({ status: 503, body: { error: { message: 'unavailable', code: 'HTTP_503' } }, onHit: () => { primaryHits += 1; } }); servers.push(primary.server);
    const backup = await upstream({ status: 200, body: okBody('ok-from-direct-backup'), onHit: () => { backupHits += 1; } }); servers.push(backup.server);
    const userConfig = config(primary.baseUrl, backup.baseUrl); await writeProviders(userConfig);
    const runtimeConfig = JSON.parse(JSON.stringify(userConfig)); delete runtimeConfig.virtualrouter.providers;
    const routeCodex = new RouteCodexHttpServer({ server: { host: '127.0.0.1', port: 5555 }, pipeline: {}, logging: { level: 'error', enableConsole: false }, providers: {} });
    routeCodex.managerDaemon = { getModule: (id) => id === 'quota' ? ({ registerProviderStaticConfig: () => {}, getQuotaView: () => (providerKey) => ({ providerKey, inPool: true, priorityTier: 100 }), getQuotaViewReadOnly: () => (providerKey) => ({ providerKey, inPool: true, priorityTier: 100 }) }) : undefined };
    await routeCodex.initializeWithUserConfig(runtimeConfig); servers.push({ close: (cb) => { routeCodex.disposeProviders().then(() => cb?.()).catch(() => cb?.()); } });
    const app = express(); app.use(express.json({ limit: '2mb' }));
    app.post('/v1/responses', (req, res) => handleResponses(req, res, { executePipeline: (input) => routeCodex.executePortAwarePipeline(5555, input), errorHandling: routeCodex.errorHandling }));
    const harness = await listen(http.createServer(app)); servers.push(harness.server);
    const res = await fetch(`${harness.baseUrl}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.3-codex', input: [{ role: 'user', content: [{ type: 'input_text', text: 'direct failover blackbox' }] }], stream: false }) });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    assert.match(text, /ok-from-direct-backup/);
    assert.equal(primaryHits, 3, 'direct mode should retry primary exactly three times');
    assert.equal(backupHits, 1, 'direct mode should reroute to backup in the same request');
    console.log(JSON.stringify({ ok: true, primaryHits, backupHits }, null, 2));
  } finally {
    for (const s of servers.reverse()) await close(s).catch(() => {});
    for (const r of restores.reverse()) r();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
main().then(() => {
  setTimeout(() => process.exit(0), 20).unref();
}).catch((e) => {
  console.error(e);
  setTimeout(() => process.exit(1), 20).unref();
});
