import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function writeStub(source) {
  const root = mkdtempSync(join(tmpdir(), 'lifecycle-stub-'));
  const path = join(root, 'stub.mjs');
  writeFileSync(path, `#!/usr/bin/env node\n${source}`);
  chmodSync(path, 0o755);
  return {
    path,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function trackedTcpServer(handler) {
  const sockets = new Set();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    handler(socket);
  });
  return { server, sockets };
}

export function destroyTrackedSockets(tracked) {
  for (const socket of tracked.sockets) socket.destroy();
}

export async function freePort() {
  const server = createTcpServer();
  await listen(server);
  const { port } = server.address();
  await closeServer(server);
  return port;
}

export async function distinctFreePorts(count = 2) {
  const ports = [];
  while (ports.length < count) {
    const candidate = await freePort();
    if (!ports.includes(candidate)) ports.push(candidate);
  }
  return ports;
}

export function listen(server, port = 0, host = '127.0.0.1') {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, resolveListen);
  });
}

export function closeServer(server) {
  return new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(() => resolveClose());
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}
