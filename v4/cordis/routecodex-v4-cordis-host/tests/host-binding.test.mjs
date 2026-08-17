import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  computeNodePluginPlanHash,
  CordisBoundNodeHost,
  CordisHostError,
  createNodePlugin,
  RustNodeContainerPort,
} from '../src/index.mjs';

const v4Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const binaryPath = path.join(v4Root, 'target/debug/routecodex-v4-node-container-host');

function observerEntry(order = 900) {
  return {
    plugin_id: 'v4.test.observe',
    version: '0.1.0',
    kind: 'observer',
    effect: 'diagnostic_only',
    phase: 'observation',
    order,
    reads: [],
    writes: [],
  };
}

function plan(entries = [observerEntry()]) {
  const value = {
    node_id: 'V4HubReqChatProcess04Governed',
    position: 4,
    role_id: 'request_chat_process',
    chain: 'request',
    entries,
    selection_groups: [],
    hash: '',
  };
  value.hash = computeNodePluginPlanHash(value);
  return value;
}

function plugin(entry = observerEntry(), events = []) {
  return createNodePlugin(
    entry.plugin_id,
    (ctx) => {
      events.push('active');
      ctx.effect(() => () => events.push('disposed'));
    },
    undefined,
    entry,
  );
}

test('real Cordis host drives the Rust NodeContainer lifecycle', async (t) => {
  const port = new RustNodeContainerPort({ binaryPath });
  t.after(() => port.close());
  const events = [];
  const nodePlan = plan();
  const host = new CordisBoundNodeHost({
    port,
    plan: nodePlan,
    nodeId: nodePlan.node_id,
    descriptor: { roleId: nodePlan.role_id },
  });

  await host.mount([plugin(nodePlan.entries[0], events)]);
  const release = await host.beginExecution();
  assert.equal((await port.request('status')).in_flight, 1);
  await assert.rejects(
    host.drain(),
    (error) => error instanceof CordisHostError && error.code === 'in_flight',
  );
  assert.equal((await port.request('status')).state, 'accepting');

  await Promise.all([release(), release()]);
  assert.equal((await port.request('status')).in_flight, 0);
  assert.deepEqual(await host.drain(), {
    nodeId: nodePlan.node_id,
    state: 'draining',
    inFlight: 0,
  });
  await host.dispose();
  assert.equal((await port.request('status')).state, 'disposed');
  assert.deepEqual(events, ['active', 'disposed']);
});

test('accepting-state disposal rejects before either lifecycle owner is mutated', async (t) => {
  const port = new RustNodeContainerPort({ binaryPath });
  t.after(() => port.close());
  const events = [];
  const nodePlan = plan();
  const host = new CordisBoundNodeHost({
    port,
    plan: nodePlan,
    nodeId: nodePlan.node_id,
    descriptor: { roleId: nodePlan.role_id },
  });

  await host.mount([plugin(nodePlan.entries[0], events)]);
  await assert.rejects(
    host.dispose(),
    (error) => error instanceof CordisHostError && error.code === 'invalid_state',
  );
  assert.equal(host.disposed, false);
  assert.equal((await port.request('status')).state, 'accepting');
  assert.deepEqual(events, ['active']);

  await host.drain();
  await host.dispose();
  assert.equal(host.disposed, true);
  assert.equal((await port.request('status')).state, 'disposed');
  assert.deepEqual(events, ['active', 'disposed']);
});

test('Cordis graph/plan drift is rejected before Rust publish', async (t) => {
  const port = new RustNodeContainerPort({ binaryPath });
  t.after(() => port.close());
  const nodePlan = plan();
  const host = new CordisBoundNodeHost({
    port,
    plan: nodePlan,
    nodeId: nodePlan.node_id,
    descriptor: { roleId: nodePlan.role_id },
  });

  await assert.rejects(
    host.mount([plugin(observerEntry(901))]),
    (error) => error instanceof CordisHostError && error.code === 'graph_hash_mismatch',
  );
  await assert.rejects(
    port.request('status'),
    (error) => error instanceof CordisHostError && error.code === 'host_lifecycle',
  );
});

test('Cordis mount failure fails and disposes the Rust candidate', async (t) => {
  const port = new RustNodeContainerPort({ binaryPath });
  t.after(() => port.close());
  const entry = observerEntry();
  const nodePlan = plan([entry]);
  const host = new CordisBoundNodeHost({
    port,
    plan: nodePlan,
    nodeId: nodePlan.node_id,
    descriptor: { roleId: nodePlan.role_id },
  });
  const failing = createNodePlugin(
    entry.plugin_id,
    Object.assign(() => {}, { inject: ['missingService'] }),
    undefined,
    entry,
  );

  await assert.rejects(
    host.mount([failing]),
    (error) => error instanceof CordisHostError && error.code === 'plugin_not_active',
  );
  assert.equal((await port.request('status')).state, 'disposed');
  assert.equal(host.disposed, true);
});

test('Rust binding spawn failure rejects pending lifecycle requests', async () => {
  const port = new RustNodeContainerPort({ binaryPath: `${binaryPath}.missing` });
  await assert.rejects(
    port.request('status'),
    (error) => error instanceof CordisHostError && error.code === 'binding_spawn',
  );
  await port.close();
});
