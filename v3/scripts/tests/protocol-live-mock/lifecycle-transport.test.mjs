import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { constants as osConstants } from 'node:os';
import test from 'node:test';

import {
  diagnoseExactBind,
  diagnoseListenerSet,
  sendHttp,
} from './lifecycle.mjs';

import {
  closeServer,
  destroyTrackedSockets,
  distinctFreePorts,
  listen,
  trackedTcpServer,
} from './lifecycle-test-support.mjs';

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
    assert.equal(result.addresses[1].error?.errno, -osConstants.errno.EADDRINUSE);
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
