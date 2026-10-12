import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  captureRuntimeIdentity,
  diagnoseExactBind,
  diagnoseListenerSet,
  generateRccConfig,
  sendHttp,
  startRcc,
  stopRcc,
} from './lifecycle.mjs';

test('generateRccConfig writes isolated V3 config with task-owned provider references', async () => {
  const workRoot = mkdtempSync(join(tmpdir(), 'lifecycle-config-test-'));
  const [mockPort, rccPort] = await distinctFreePorts();
  const first = await generateRccConfig({ mockPort, rccPort, providerProtocol: 'openai_chat', workRoot });
  const second = await generateRccConfig({ mockPort, rccPort, providerProtocol: 'openai_chat', workRoot });
  let exhaustion = null;
  try {
    exhaustion = await generateRccConfig({
      mockPort,
      rccPort,
      providerProtocol: 'openai_chat',
      workRoot,
      runtimeSetup: {
        provider_id: 'mock-openai_chat',
        model: 'mock.unavailable-model',
        direct_pin: false,
        candidate_ids: ['mock-openai_chat/mock.unavailable-model'],
        all_candidates_fail: true,
      },
    });
    assert.notEqual(first.root, second.root);
    assert.notEqual(first.path, second.path);
    assert.equal(first.server_id, 'loopback');
    assert.equal(first.provider_protocol, 'openai_chat');
    assert.match(first.text, /^version = 3$/m);
    assert.match(first.text, new RegExp(`port = ${rccPort}`));
    assert.match(first.text, /bind = "127\.0\.0\.1"/);
    assert.match(first.text, /use = "mock-openai_chat\/mock\.chat-model"/);
    assert.notEqual(first.admin_port, 8777);
    assert.equal(first.env.ROUTECODEX_V3_ADMIN_BIND, first.admin_bind);
    assert.deepEqual(
      first.listeners.map((listener) => listener.role),
      ['primary', 'admin_webui'],
    );
    assert.equal(first.listeners[0].port, rccPort);
    assert.equal(first.listeners[1].port, first.admin_port);

    const providerText = readFileSync(first.provider_path, 'utf8');
    assert.match(providerText, /version = "2\.0\.0"/);
    assert.match(providerText, new RegExp(`baseURL = "http://127\\.0\\.0\\.1:${mockPort}/v1"`));
    assert.match(providerText, /defaultModel = "chat-model"/);
    assert.match(providerText, /\[provider\.models\."mock\.chat-model"\]/);
    assert.match(providerText, /wireName = "chat-model"/);
    assert.match(providerText, /apiKey = "fake-loopback-token"/);
    assert.doesNotMatch(providerText, /https?:\/\/(?!127\.0\.0\.1)/);
    assert.equal((providerText.match(/fake-loopback-token/g) ?? []).length, 1);
  } finally {
    first.cleanup();
    second.cleanup();
    exhaustion?.cleanup();
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test('generateRccConfig authors the runtime candidate as a real provider model', async () => {
  const setup = {
    provider_id: 'mock-openai_chat',
    model: 'mock.unavailable-model',
    direct_pin: false,
    candidate_ids: ['mock-openai_chat/mock.unavailable-model'],
    all_candidates_fail: true,
  };
  const generated = await generateRccConfig({
    mockPort: 12345,
    rccPort: 12346,
    providerProtocol: 'openai_chat',
    workRoot: '/tmp/lifecycle-setup-inspect',
    runtimeSetup: setup,
  });
  try {
    assert.deepEqual(generated.runtime_setup, setup);
    assert.deepEqual(generated.candidate_ids, ['mock-openai_chat/mock.unavailable-model']);
    assert.match(generated.text, /use = "mock-openai_chat\/mock\.unavailable-model"/);
    assert.match(generated.provider_text, /\[provider\.models\."mock\.unavailable-model"\]/);
    assert.match(generated.provider_text, /wireName = "chat-model"/);
  } finally {
    generated.cleanup();
  }
});

test('generateRccConfig writes a supported execution policy and receipts the written mode', async () => {
  for (const mode of ['direct', 'relay']) {
    const generated = await generateRccConfig({
      mockPort: 12345, rccPort: 12346, providerProtocol: 'openai_chat', mode,
      workRoot: tmpdir(),
    });
    try {
      const actual = readFileSync(generated.path, 'utf8');
      assert.match(actual, /\[servers\.loopback\.execution\]/);
      assert.match(actual, new RegExp(`allowed_modes = \\["${mode}"\\]`));
      assert.equal(generated.mode, mode);
      assert.equal(generated.mode_receipt.field, 'servers.loopback.execution.allowed_modes');
      assert.deepEqual(generated.mode_receipt.allowed_modes, [mode]);
      assert.match(generated.mode_receipt.config_sha256, /^[a-f0-9]{64}$/);
    } finally {
      generated.cleanup();
    }
  }
});

test('captureRuntimeIdentity records the real child version and binary hash', () => {
  const identity = captureRuntimeIdentity(process.execPath);
  assert.equal(identity.path, resolve(process.execPath));
  assert.equal(identity.exit_code, 0);
  assert.equal(identity.signal, null);
  assert.match(identity.version, /^v\d+/);
  assert.match(identity.sha256, /^[a-f0-9]{64}$/);
  assert.ok(identity.size > 0);
});

test('sendHttp preserves status, headers, raw bytes, and complete-response state', async () => {
  const payload = Buffer.from([0x00, 0xff, 0x01]);
  const server = createServer((request, response) => {
    response.writeHead(201, { 'content-type': 'application/octet-stream', 'x-test-header': 'present' });
    response.end(payload);
  });
  await listen(server);
  try {
    const result = await sendHttp(`http://127.0.0.1:${server.address().port}/raw`, { timeoutMs: 1000 });
    assert.equal(result.status, 201);
    assert.equal(result.headers['x-test-header'], 'present');
    assert.deepEqual(result.bodyBytes, payload);
    assert.equal(result.bodyBytesBase64, payload.toString('base64'));
    assert.equal(result.response_ended, true);
    assert.equal(result.complete, true);
    assert.equal(result.closed, false);
    assert.equal(result.error, null);
  } finally {
    await closeServer(server);
  }
});

test('sendHttp distinguishes empty close, incomplete response, and timeout', async () => {
  const emptyClose = trackedTcpServer((socket) => socket.end());
  await listen(emptyClose.server);
  const incomplete = trackedTcpServer((socket) => {
    socket.once('data', () => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nabc');
      socket.end();
    });
  });
  await listen(incomplete.server);
  const hanging = trackedTcpServer(() => {});
  await listen(hanging.server);
  try {
    const closed = await sendHttp(`http://127.0.0.1:${emptyClose.server.address().port}/closed`, { timeoutMs: 500 });
    assert.equal(closed.status, null);
    assert.equal(closed.bodyBytes.length, 0);
    assert.equal(closed.closed, true);
    assert.equal(closed.complete, null);
    assert.ok(closed.error);
    assert.ok(closed.error_detail?.code);

    const partial = await sendHttp(`http://127.0.0.1:${incomplete.server.address().port}/partial`, { timeoutMs: 500 });
    assert.equal(partial.status, 200);
    assert.equal(partial.bodyText, 'abc');
    assert.equal(partial.complete, false);
    assert.equal(partial.closed, true);
    assert.equal(partial.aborted, true);
    assert.ok(partial.error || partial.error_detail);

    const timedOut = await sendHttp(`http://127.0.0.1:${hanging.server.address().port}/timeout`, { timeoutMs: 50 });
    assert.equal(timedOut.status, null);
    assert.equal(timedOut.closed, true);
    assert.equal(timedOut.error_detail?.code, 'ETIMEDOUT');
    assert.ok(timedOut.elapsed_ms >= 40);
  } finally {
    destroyTrackedSockets(emptyClose);
    destroyTrackedSockets(incomplete);
    destroyTrackedSockets(hanging);
    await closeServer(emptyClose.server);
    await closeServer(incomplete.server);
    await closeServer(hanging.server);
  }
});

test('diagnoseExactBind reports the original bind error without changing ports', async () => {
  const [port, fakeAdminPort] = await distinctFreePorts(2);
  const available = await diagnoseExactBind('127.0.0.1', port);
  assert.equal(available.bound, true);
  assert.equal(available.released, true);
  assert.equal(available.error, null);

  const owner = createTcpServer();
  await listen(owner, port);
  try {
    const occupied = await diagnoseExactBind('127.0.0.1', port);
    assert.equal(occupied.bound, false);
    assert.equal(occupied.released, true);
    assert.equal(occupied.error?.code, 'EADDRINUSE');
  } finally {
    await closeServer(owner);
  }
});

test('generateRccConfig overrides an inherited 8777 admin bind with a task-owned port', async () => {
  const previous = process.env.ROUTECODEX_V3_ADMIN_BIND;
  process.env.ROUTECODEX_V3_ADMIN_BIND = '127.0.0.1:8777';
  const workRoot = mkdtempSync(join(tmpdir(), 'lifecycle-admin-inherit-test-'));
  const [mockPort, rccPort] = await distinctFreePorts();
  let generated = null;
  try {
    generated = await generateRccConfig({ mockPort, rccPort, providerProtocol: 'openai_chat', workRoot });
    assert.equal(generated.inherited_admin_bind, '127.0.0.1:8777');
    assert.notEqual(generated.admin_bind, '127.0.0.1:8777');
    assert.notEqual(generated.admin_port, 8777);
    assert.equal(generated.env.ROUTECODEX_V3_ADMIN_BIND, generated.admin_bind);
    assert.notEqual(generated.admin_port, rccPort);
    assert.notEqual(generated.admin_port, mockPort);
    assert.equal(
      generated.listeners.find((listener) => listener.role === 'admin_webui').port,
      generated.admin_port,
    );
  } finally {
    generated?.cleanup();
    rmSync(workRoot, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ROUTECODEX_V3_ADMIN_BIND;
    else process.env.ROUTECODEX_V3_ADMIN_BIND = previous;
  }
});

test('diagnoseListenerSet checks every declared address in order and preserves errno', async () => {
  const [freePrimary, occupiedAdmin] = await distinctFreePorts();
  const owner = createTcpServer();
  await listen(owner, occupiedAdmin);
  try {
    const result = await diagnoseListenerSet([
      { role: 'primary', host: '127.0.0.1', port: freePrimary },
      { role: 'admin_webui', host: '127.0.0.1', port: occupiedAdmin },
    ]);
    assert.equal(result.addresses.length, 2);
    assert.equal(result.addresses[0].role, 'primary');
    assert.equal(result.addresses[0].bound, true);
    assert.equal(result.addresses[0].error, null);
    assert.equal(result.addresses[1].role, 'admin_webui');
    assert.equal(result.addresses[1].bound, false);
    assert.equal(result.addresses[1].error?.code, 'EADDRINUSE');
    assert.equal(result.addresses[1].error?.errno, -48);
    assert.equal(result.all_bound, false);
    assert.equal(result.first_failure.role, 'admin_webui');
  } finally {
    await closeServer(owner);
  }
});

test('diagnoseListenerSet reports a fully free declared set as bound and released', async () => {
  const [primary, admin] = await distinctFreePorts();
  const result = await diagnoseListenerSet([
    { role: 'primary', host: '127.0.0.1', port: primary },
    { role: 'admin_webui', host: '127.0.0.1', port: admin },
  ]);
  assert.equal(result.all_bound, true);
  assert.equal(result.all_released, true);
  assert.equal(result.first_failure, null);
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

test('generateRccConfig authors two same-tier providers with distinct fake identities', async () => {
  const workRoot = mkdtempSync(join(tmpdir(), 'lifecycle-multi-provider-test-'));
  const [mockPort, rccPort] = await distinctFreePorts();
  const runtimeSetup = {
    provider_id: 'mock-chat-a',
    model: 'mock.chat-model',
    wire_model: 'chat-model',
    candidate_ids: ['mock-chat-a/mock.chat-model', 'mock-chat-b/mock.chat-model'],
  };
  const generated = await generateRccConfig({
    mockPort,
    rccPort,
    providerProtocol: 'openai_chat',
    workRoot,
    runtimeSetup,
  });
  try {
    // Red control: the old generator rejected any setup with more than one
    // candidate. A multi-candidate setup must now author both providers.
    assert.deepEqual(
      generated.candidate_ids,
      ['mock-chat-a/mock.chat-model', 'mock-chat-b/mock.chat-model'],
    );
    assert.equal(generated.provider_files.length, 2);
    assert.deepEqual(
      generated.provider_files.map((file) => file.provider_id),
      ['mock-chat-a', 'mock-chat-b'],
    );
    for (const file of generated.provider_files) {
      assert.equal(file.model, 'mock.chat-model');
      assert.equal(file.wire_model, 'chat-model');
      assert.equal(readFileSync(file.path, 'utf8'), file.text);
      assert.match(file.text, /\[provider\.models\."mock\.chat-model"\]/);
      assert.match(file.text, /wireName = "chat-model"/);
      assert.match(file.text, new RegExp(`baseURL = "http://127\\.0\\.0\\.1:${mockPort}/v1"`));
      assert.doesNotMatch(file.text, /https?:\/\/(?!127\.0\.0\.1)/);
    }
    const [a, b] = generated.provider_files;
    assert.match(a.text, /apiKey = "fake-loopback-token-mock-chat-a"/);
    assert.match(b.text, /apiKey = "fake-loopback-token-mock-chat-b"/);
    // Red control: two candidates must not share one token.
    assert.notEqual(
      a.text.match(/apiKey = "([^"]+)"/)[1],
      b.text.match(/apiKey = "([^"]+)"/)[1],
    );
    // Red control: both candidates stay in one default pool tier.
    assert.match(
      generated.text,
      /tiers = \[\[\n {2}\{ use = "mock-chat-a\/mock\.chat-model" \},\n {2}\{ use = "mock-chat-b\/mock\.chat-model" \}\n\]\]/,
    );
    assert.equal((generated.text.match(/\{ use = /g) ?? []).length, 2);
    // Candidate identity receipt names both declared identities independently.
    assert.equal(generated.candidate_identity_receipts.validated, true);
    assert.equal(generated.candidate_identity_receipts.protocol, 'openai_chat');
    assert.equal(generated.candidate_identity_receipts.wire_model, 'chat-model');
    assert.equal(generated.candidate_identity_receipts.tier_count, 1);
    assert.deepEqual(
      generated.candidate_identity_receipts.candidates.map((candidate) => candidate.authorization),
      ['Bearer fake-loopback-token-mock-chat-a', 'Bearer fake-loopback-token-mock-chat-b'],
    );
    // Legacy single-caller keys still point at the primary authored provider.
    assert.equal(generated.provider_path, a.path);
    assert.equal(generated.provider_text, a.text);
    assert.equal(generated.provider_dir, a.path.replace(/\/config\.v2\.toml$/, ''));
    assert.equal(generated.provider_id, 'mock-chat-a');
  } finally {
    generated.cleanup();
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test('generateRccConfig rejects a multi-candidate model that leaves the declared model', async () => {
  await assert.rejects(
    generateRccConfig({
      mockPort: 12345,
      rccPort: 12346,
      providerProtocol: 'openai_chat',
      workRoot: tmpdir(),
      runtimeSetup: {
        provider_id: 'mock-chat-a',
        model: 'mock.chat-model',
        wire_model: 'chat-model',
        candidate_ids: ['mock-chat-a/mock.chat-model', 'mock-chat-b/mock.other-model'],
      },
    }),
    /must match declared model/,
  );
});

test('generateRccConfig rejects the same provider twice instead of collapsing to one', async () => {
  await assert.rejects(
    generateRccConfig({
      mockPort: 12345,
      rccPort: 12346,
      providerProtocol: 'openai_chat',
      workRoot: tmpdir(),
      runtimeSetup: {
        provider_id: 'mock-chat-a',
        model: 'mock.chat-model',
        wire_model: 'chat-model',
        candidate_ids: ['mock-chat-a/mock.chat-model', 'mock-chat-a/mock.chat-model'],
      },
    }),
    /duplicate provider/,
  );
});

test('generateRccConfig keeps the exhaustion model key distinct from its wire name', async () => {
  const workRoot = mkdtempSync(join(tmpdir(), 'lifecycle-exhaustion-model-test-'));
  const generated = await generateRccConfig({
    mockPort: 12345,
    rccPort: 12346,
    providerProtocol: 'openai_chat',
    workRoot,
    runtimeSetup: {
      provider_id: 'mock-openai_chat',
      model: 'mock.unavailable-model',
      wire_model: 'unavailable-model',
      candidate_ids: ['mock-openai_chat/mock.unavailable-model'],
      all_candidates_fail: true,
    },
  });
  try {
    // Red control: the model key is not the wire name.
    assert.equal(generated.model, 'mock.unavailable-model');
    assert.equal(generated.wire_model, 'unavailable-model');
    assert.match(generated.provider_text, /\[provider\.models\."mock\.unavailable-model"\]/);
    assert.doesNotMatch(generated.provider_text, /\[provider\.models\."unavailable-model"\]/);
    assert.match(generated.provider_text, /wireName = "unavailable-model"/);
    assert.match(generated.provider_text, /apiKey = "fake-loopback-token"/);
    assert.match(generated.text, /use = "mock-openai_chat\/mock\.unavailable-model"/);
    assert.equal(generated.provider_files.length, 1);
  } finally {
    generated.cleanup();
    rmSync(workRoot, { recursive: true, force: true });
  }
});

function writeStub(source) {
  const root = mkdtempSync(join(tmpdir(), 'lifecycle-stub-'));
  const path = join(root, 'stub.mjs');
  writeFileSync(path, `#!/usr/bin/env node\n${source}`);
  chmodSync(path, 0o755);
  return {
    path,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function trackedTcpServer(handler) {
  const sockets = new Set();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    handler(socket);
  });
  return { server, sockets };
}

function destroyTrackedSockets(tracked) {
  for (const socket of tracked.sockets) socket.destroy();
}

async function freePort() {
  const server = createTcpServer();
  await listen(server);
  const { port } = server.address();
  await closeServer(server);
  return port;
}

async function distinctFreePorts(count = 2) {
  const ports = [];
  while (ports.length < count) {
    const candidate = await freePort();
    if (!ports.includes(candidate)) ports.push(candidate);
  }
  return ports;
}

function listen(server, port = 0, host = '127.0.0.1') {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, resolveListen);
  });
}

function closeServer(server) {
  return new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(() => resolveClose());
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}
