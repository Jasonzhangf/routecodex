import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  CordisHostDaemonClient,
  CordisHostDaemonError,
} from '../src/daemon.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const child = path.join(here, 'resources/daemon-child.mjs');

async function tempState(name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `rccv4-cordis-daemon-${name}-`));
}

async function startChild(stateDirectory, socketPath, graphHash = 'graph-a') {
  const processChild = spawn(process.execPath, [child, stateDirectory, socketPath, graphHash], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    processChild.once('spawn', resolve);
    processChild.once('error', reject);
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fs.access(socketPath);
      return processChild;
    } catch {
      if (processChild.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  const error = await new Promise((resolve) => {
    processChild.stderr.once('data', (data) => resolve(data.toString()));
    processChild.once('exit', (code) => resolve(`exit ${code}`));
  });
  throw new Error(`daemon child exited before ready: ${error}`);
}

async function stopChild(processChild) {
  if (processChild.exitCode !== null) return;
  processChild.kill('SIGTERM');
  await new Promise((resolve) => processChild.once('exit', resolve));
}

test('daemon startup performs version/capability handshake and exposes typed snapshot', async (t) => {
  const stateDirectory = await tempState('handshake');
  const socketPath = path.join(stateDirectory, 'cordis.sock');
  const processChild = await startChild(stateDirectory, socketPath);
  t.after(async () => {
    await stopChild(processChild);
    await fs.rm(stateDirectory, { recursive: true, force: true });
  });

  const client = await CordisHostDaemonClient.connect({ socketPath });
  assert.equal(client.snapshot().generation, 1);
  assert.deepEqual(client.snapshot().capabilities, ['snapshot', 'heartbeat', 'reconcile', 'shutdown']);
  assert.equal(client.snapshot().graphHash, 'graph-a');
  assert.equal((await client.querySnapshot()).protocolVersion, 1);
  await client.close();
});

test('heartbeat, reconnect, generation and graph reconciliation fail closed', async (t) => {
  const stateDirectory = await tempState('reconcile');
  const socketPath = path.join(stateDirectory, 'cordis.sock');
  let processChild = await startChild(stateDirectory, socketPath, 'graph-b');
  t.after(async () => {
    await stopChild(processChild);
    await fs.rm(stateDirectory, { recursive: true, force: true });
  });

  const client = await CordisHostDaemonClient.connect({ socketPath, graphHash: 'graph-b' });
  assert.equal((await client.heartbeat()).generation, 1);
  assert.equal((await client.reconcile({ generation: 1, graphHash: 'graph-b' })).reconciled, true);
  await client.close();

  await stopChild(processChild);
  processChild = await startChild(stateDirectory, socketPath, 'graph-b');
  const reconnected = await CordisHostDaemonClient.connect({ socketPath, graphHash: 'graph-b' });
  await assert.rejects(
    reconnected.reconcile({ generation: 1, graphHash: 'graph-b' }),
    (error) => error instanceof CordisHostDaemonError && error.code === 'generation_mismatch',
  );
  assert.equal(reconnected.snapshot().generation, 2);
  await assert.rejects(
    CordisHostDaemonClient.connect({ socketPath, graphHash: 'graph-wrong' }),
    (error) => error instanceof CordisHostDaemonError && error.code === 'graph_hash_mismatch',
  );
  await reconnected.close();
});

test('daemon refuses a second owner for an existing socket/state', async (t) => {
  const stateDirectory = await tempState('exclusive');
  const socketPath = path.join(stateDirectory, 'cordis.sock');
  const processChild = await startChild(stateDirectory, socketPath);
  t.after(async () => {
    await stopChild(processChild);
    await fs.rm(stateDirectory, { recursive: true, force: true });
  });
  const duplicate = spawn(process.execPath, [child, stateDirectory, socketPath, 'graph-a'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderr = new Promise((resolve) => duplicate.stderr.once('data', (data) => resolve(data.toString())));
  const exit = new Promise((resolve) => duplicate.once('exit', (code) => resolve(code)));
  assert.equal(await exit, 1);
  assert.match(await stderr, /already exists|already running/);
});
