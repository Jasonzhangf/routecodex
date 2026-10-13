import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  captureRuntimeIdentity,
  generateRccConfig,
  startRcc,
  stopRcc,
} from './lifecycle.mjs';

import {
  closeServer,
  distinctFreePorts,
  freePort,
  listen,
  writeStub,
} from './lifecycle-test-support.mjs';

test('captureRuntimeIdentity records the real child version and binary hash', () => {
  const identity = captureRuntimeIdentity(process.execPath);
  assert.equal(identity.path, resolve(process.execPath));
  assert.equal(identity.exit_code, 0);
  assert.equal(identity.signal, null);
  assert.match(identity.version, /^v\d+/);
  assert.match(identity.sha256, /^[a-f0-9]{64}$/);
  assert.ok(identity.size > 0);
});

test('startRcc and stopRcc use the owned child, then wait for exit and socket closure', async () => {
  const stub = writeStub(`
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const configPath = args[args.indexOf('--config') + 1];
const text = readFileSync(configPath, 'utf8');
const port = Number(text.match(/^port = (\\d+)$/m)[1]);
const adminPort = Number((process.env.ROUTECODEX_V3_ADMIN_BIND ?? '').split(':').pop());
const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      status: 'ok',
      version: 3,
      build_version: 'test-stub',
      manifest_version: 1,
      server_id: 'loopback',
      bind: '127.0.0.1',
      port,
    }));
    return;
  }
  response.writeHead(404);
  response.end();
});
server.on('error', (error) => {
  console.error(error.code);
  process.exit(2);
});
server.listen(port, '127.0.0.1');
const adminServer = createServer();
adminServer.listen(adminPort, '127.0.0.1', () => console.error('admin-ready'));
let stopping = false;
process.on('SIGTERM', () => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => {
    server.close(() => {
      adminServer.closeAllConnections?.();
      adminServer.close(() => process.exit(0));
    });
  }, 75);
});
`);
  const workRoot = mkdtempSync(join(tmpdir(), 'lifecycle-start-test-'));
  const [mockPort, rccPort] = await distinctFreePorts();
  const generated = await generateRccConfig({ mockPort, rccPort, providerProtocol: 'openai_chat', workRoot });
  const report = {};
  let handle = null;
  try {
    handle = await startRcc(stub.path, generated, rccPort, report, { startupTimeoutMs: 3000 });
    assert.equal(handle.ready, true);
    assert.equal(handle.running, true);
    assert.equal(handle.identity.server_id, 'loopback');
    assert.equal(handle.admin_bind, generated.admin_bind);
    assert.deepEqual(
      handle.listeners.map((listener) => listener.role),
      ['primary', 'admin_webui'],
    );
    const cleanup = await stopRcc(handle, report, { shutdownTimeoutMs: 2000, socketCloseTimeoutMs: 2000 });
    assert.equal(cleanup.complete, true);
    assert.equal(cleanup.process_exit_observed, true);
    assert.equal(cleanup.exit_code, 0);
    assert.equal(cleanup.signal, null);
    assert.equal(cleanup.socket_closed, true);
    assert.equal(cleanup.all_listeners_closed, true);
    assert.deepEqual(
      cleanup.listener_closures.map((entry) => [entry.role, entry.closed]),
      [['primary', true], ['admin_webui', true]],
    );
    assert.equal(cleanup.listener_closures[1].port, generated.admin_port);
    assert.equal(handle.running, false);
    assert.equal(handle.ready, false);
    assert.ok(cleanup.elapsed_ms >= 50);
  } finally {
    if (handle && handle.running) await stopRcc(handle, report, { shutdownTimeoutMs: 500, socketCloseTimeoutMs: 500 });
    generated.cleanup();
    stub.cleanup();
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test('failed startup records the real child exit and never claims ready', async () => {
  const stub = writeStub(`
console.log('stub started then failed');
process.exit(17);
`);
  const workRoot = mkdtempSync(join(tmpdir(), 'lifecycle-fail-test-'));
  const [mockPort, rccPort] = await distinctFreePorts();
  const [adminPort] = await distinctFreePorts();
  const generated = await generateRccConfig({ mockPort, rccPort, adminPort, providerProtocol: 'responses', workRoot });
  const report = {};
  try {
    const handle = await startRcc(stub.path, generated, rccPort, report, { startupTimeoutMs: 1000 });
    assert.equal(handle.ready, false);
    assert.equal(handle.running, false);
    assert.equal(handle.state, 'infra_failure');
    assert.equal(handle.exit_receipt.exit_code, 17);
    assert.equal(report.status, 'runner_startup_failed');
    assert.equal(report.infra_failure.code, 'process_exited_before_ready');
    assert.equal(report.startup.exit.exit_code, 17);
    assert.equal(report.startup.running, false);
    assert.equal(report.cleanup.exit_code, 17);
    assert.equal(report.cleanup.process_exit_observed, true);
    assert.equal(report.cleanup.complete, true);
    assert.match(report.startup.stdout_tail, /stub started then failed/);
  } finally {
    generated.cleanup();
    stub.cleanup();
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test('fake health 200 without RCC identity is rejected and remains an owned cleanup failure', async () => {
  const [port, fakeAdminPort] = await distinctFreePorts(2);
  const fake = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', version: 3 }));
  });
  await listen(fake, port);
  const stub = writeStub(`
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const configPath = args[args.indexOf('--config') + 1];
const text = readFileSync(configPath, 'utf8');
const port = Number(text.match(/^port = (\\d+)$/m)[1]);
const server = createServer();
server.on('error', (error) => {
  console.error(error.code);
  setTimeout(() => process.exit(2), 500);
});
server.listen(port, '127.0.0.1');
`);
  const workRoot = mkdtempSync(join(tmpdir(), 'lifecycle-fake-health-test-'));
  const mockPort = await freePort();
  const generated = await generateRccConfig({
    mockPort,
    rccPort: port,
    providerProtocol: 'anthropic',
    workRoot,
    adminPort: fakeAdminPort,
  });
  const report = {};
  try {
    const handle = await startRcc(stub.path, generated, port, report, {
      // Node retries EADDRINUSE before emitting error; the stub then waits
      // another 500ms to let the fake health identity be observed.
      startupTimeoutMs: 3000,
      failedStartupSocketCloseTimeoutMs: 100,
    });
    assert.equal(handle.ready, false);
    assert.equal(report.infra_failure.code, 'process_exited_before_ready');
    assert.equal(report.startup.last_health.status, 200);
    assert.equal(report.startup.last_failure.code, 'health_server_id_mismatch');
    assert.equal(report.cleanup.socket_closed, false);
    assert.equal(report.cleanup.complete, false);
    assert.match(report.cleanup.failures.join('\n'), /owned listener did not close/);
  } finally {
    await closeServer(fake);
    generated.cleanup();
    stub.cleanup();
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test('stopRcc force-kills only its owned non-terminating child and records that fact', async () => {
  const stub = writeStub(`
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const configPath = args[args.indexOf('--config') + 1];
const text = readFileSync(configPath, 'utf8');
const port = Number(text.match(/^port = (\\d+)$/m)[1]);
const adminPort = Number((process.env.ROUTECODEX_V3_ADMIN_BIND ?? '').split(':').pop());
const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      status: 'ok',
      version: 3,
      build_version: 'test-stub',
      manifest_version: 1,
      server_id: 'loopback',
      bind: '127.0.0.1',
      port,
    }));
    return;
  }
  response.writeHead(404);
  response.end();
});
server.on('error', (error) => {
  console.error(error.code);
  process.exit(2);
});
server.listen(port, '127.0.0.1');
const adminServer = createServer();
adminServer.listen(adminPort, '127.0.0.1');
process.on('SIGTERM', () => {});
`);
  const workRoot = mkdtempSync(join(tmpdir(), 'lifecycle-kill-test-'));
  const [mockPort, rccPort] = await distinctFreePorts();
  const generated = await generateRccConfig({ mockPort, rccPort, providerProtocol: 'gemini', workRoot });
  const report = {};
  try {
    const handle = await startRcc(stub.path, generated, rccPort, report, { startupTimeoutMs: 3000 });
    assert.equal(handle.ready, true);
    const cleanup = await stopRcc(handle, report, { shutdownTimeoutMs: 100, socketCloseTimeoutMs: 2000 });
    assert.equal(cleanup.force_killed, true);
    assert.equal(cleanup.process_exit_observed, true);
    assert.equal(cleanup.signal, 'SIGKILL');
    assert.equal(cleanup.socket_closed, true);
    assert.equal(cleanup.complete, true);
  } finally {
    generated.cleanup();
    stub.cleanup();
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test('stopRcc records a still-open declared admin listener instead of claiming full cleanup', async () => {
  const stub = writeStub(`
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const configPath = args[args.indexOf('--config') + 1];
const text = readFileSync(configPath, 'utf8');
const port = Number(text.match(/^port = (\\d+)$/m)[1]);
const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      status: 'ok',
      version: 3,
      build_version: 'test-stub',
      manifest_version: 1,
      server_id: 'loopback',
      bind: '127.0.0.1',
      port,
    }));
    return;
  }
  response.writeHead(404);
  response.end();
});
server.on('error', (error) => {
  console.error(error.code);
  process.exit(2);
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
  const workRoot = mkdtempSync(join(tmpdir(), 'lifecycle-admin-open-test-'));
  const [mockPort, rccPort, foreignAdminPort] = await distinctFreePorts(3);
  const foreignAdmin = createTcpServer();
  await listen(foreignAdmin, foreignAdminPort);
  const generated = await generateRccConfig({
    mockPort,
    rccPort,
    providerProtocol: 'openai_chat',
    workRoot,
    adminPort: foreignAdminPort,
  });
  const report = {};
  try {
    assert.equal(generated.admin_port, foreignAdminPort);
    const handle = await startRcc(stub.path, generated, rccPort, report, { startupTimeoutMs: 3000 });
    assert.equal(handle.ready, true);
    const cleanup = await stopRcc(handle, report, { shutdownTimeoutMs: 2000, socketCloseTimeoutMs: 300 });
    assert.equal(cleanup.socket_closed, true);
    assert.equal(cleanup.all_listeners_closed, false);
    assert.equal(cleanup.complete, false);
    assert.deepEqual(
      cleanup.listener_closures.map((entry) => [entry.role, entry.closed]),
      [['primary', true], ['admin_webui', false]],
    );
    assert.match(cleanup.failures.join('\n'), /admin_webui 127\.0\.0\.1:/);
  } finally {
    await closeServer(foreignAdmin);
    generated.cleanup();
    stub.cleanup();
    rmSync(workRoot, { recursive: true, force: true });
  }
});
