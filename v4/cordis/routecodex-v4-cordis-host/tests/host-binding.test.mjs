import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
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
const unsolicitedResponseBinary = path.join(
  v4Root,
  'cordis/routecodex-v4-cordis-host/tests/resources/unsolicited-response-host.mjs',
);

function withTimeout(promise, milliseconds = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('lifecycle request did not settle')),
      milliseconds,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function sendRawLifecycleRequest(request) {
  const child = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = readline.createInterface({ input: child.stdout });
  const response = new Promise((resolve, reject) => {
    child.once('error', reject);
    lines.once('line', (line) => resolve(JSON.parse(line)));
  });
  child.stdin.end(`${JSON.stringify(request)}\n`);
  return response;
}

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

function semanticEntry(pluginId = 'v4.test.echo', order = 300) {
  return {
    plugin_id: pluginId,
    version: '0.1.0',
    kind: 'operator',
    effect: 'semantic',
    phase: 'semantic',
    order,
    reads: ['v4.request.normal_payload'],
    writes: ['v4.request.normal_payload'],
  };
}

function controlEntry(order = 100) {
  return {
    plugin_id: 'v4.test.control',
    version: '0.1.0',
    kind: 'control',
    effect: 'control_only',
    phase: 'control',
    order,
    reads: ['v4.control.metadata_center'],
    writes: ['v4.control.metadata_center'],
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
  assert.equal((await port.status()).in_flight, 1);
  await assert.rejects(
    host.drain(),
    (error) => (
      error instanceof CordisHostError
      && error.code === 'in_flight'
      && error.failure?.resource_id === 'v4.node_container.lifecycle_failure'
      && error.failure?.operation === 'drain'
      && error.failure?.node_id === nodePlan.node_id
    ),
  );
  assert.equal((await port.status()).state, 'accepting');

  await Promise.all([release(), release()]);
  assert.equal((await port.status()).in_flight, 0);
  assert.deepEqual(await host.drain(), {
    nodeId: nodePlan.node_id,
    state: 'draining',
    inFlight: 0,
  });
  await host.dispose();
  assert.equal((await port.status()).state, 'disposed');
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
  assert.equal((await port.status()).state, 'accepting');
  assert.deepEqual(events, ['active']);

  await host.drain();
  await host.dispose();
  assert.equal(host.disposed, true);
  assert.equal((await port.status()).state, 'disposed');
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
    port.status(),
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
    // Keep the graph declaration valid, then fail during Cordis activation
    // because this host intentionally does not provide nodeExecution.
    Object.assign(() => {}, { inject: ['nodeExecution'] }),
    undefined,
    entry,
  );

  await assert.rejects(
    host.mount([failing]),
    (error) => error instanceof CordisHostError && error.code === 'plugin_not_active',
  );
  assert.equal((await port.status()).state, 'disposed');
  assert.equal(host.disposed, true);
});

test('Rust binding spawn failure rejects pending lifecycle requests', async () => {
  const port = new RustNodeContainerPort({ binaryPath: `${binaryPath}.missing` });
  await assert.rejects(
    port.status(),
    (error) => error instanceof CordisHostError && error.code === 'binding_spawn',
  );
  await port.close();
});

test('unsolicited lifecycle response rejects pending requests and closes the port', async (t) => {
  const port = new RustNodeContainerPort({
    binaryPath: process.execPath,
    binaryArgs: [unsolicitedResponseBinary],
  });
  t.after(() => port.close());
  await assert.rejects(
    withTimeout(port.status()),
    (error) => error instanceof CordisHostError && error.code === 'binding_protocol',
  );
  await assert.rejects(
    port.status(),
    (error) => error instanceof CordisHostError && error.code === 'binding_protocol',
  );
});

test('undeclared lifecycle response fields reject pending requests and close the port', async (t) => {
  const port = new RustNodeContainerPort({
    binaryPath: process.execPath,
    binaryArgs: [unsolicitedResponseBinary, 'unknown-field'],
  });
  t.after(() => port.close());
  await assert.rejects(
    withTimeout(port.status()),
    (error) => error instanceof CordisHostError && error.code === 'binding_protocol',
  );
  await assert.rejects(
    port.status(),
    (error) => error instanceof CordisHostError && error.code === 'binding_protocol',
  );
});

test('JS lifecycle decoder rejects malformed lifecycle failure facts', async (t) => {
  const port = new RustNodeContainerPort({
    binaryPath: process.execPath,
    binaryArgs: [unsolicitedResponseBinary, 'malformed-failure'],
  });
  t.after(() => port.close());
  await assert.rejects(
    withTimeout(port.status()),
    (error) => error instanceof CordisHostError && error.code === 'binding_protocol',
  );
});

test('JS lifecycle decoder rejects failure facts outside the NodeContainer resource', async (t) => {
  const port = new RustNodeContainerPort({
    binaryPath: process.execPath,
    binaryArgs: [unsolicitedResponseBinary, 'wrong-failure-resource'],
  });
  t.after(() => port.close());
  await assert.rejects(
    withTimeout(port.status()),
    (error) => error instanceof CordisHostError && error.code === 'binding_protocol',
  );
});

test('Rust lifecycle decoder rejects undeclared metadata and business fields', async () => {
  const metadata = await sendRawLifecycleRequest({
    op: 'status',
    request_id: 'raw-metadata',
    metadata: { route: 'forbidden' },
  });
  assert.equal(metadata.ok, false);
  assert.equal(metadata.request_id, 'raw-metadata');
  assert.deepEqual(metadata.failure, {
    resource_id: 'v4.node_container.lifecycle_failure',
    request_id: 'raw-metadata',
    operation: 'protocol_decode',
    code: 'protocol_error',
    message: metadata.failure.message,
  });

  const businessPayload = await sendRawLifecycleRequest({
    op: 'status',
    request_id: 'raw-business-payload',
    messages: [{ role: 'user', content: 'forbidden' }],
  });
  assert.equal(businessPayload.ok, false);
  assert.equal(businessPayload.request_id, 'raw-business-payload');
  assert.equal(businessPayload.failure.code, 'protocol_error');
  assert.equal(businessPayload.failure.operation, 'protocol_decode');

  const nestedPlan = plan();
  nestedPlan.metadata = { route: 'forbidden' };
  const nestedMetadata = await sendRawLifecycleRequest({
    op: 'declare',
    request_id: 'raw-nested-metadata',
    node_id: nestedPlan.node_id,
    plan: nestedPlan,
    bindings: {
      graph_hash: nestedPlan.hash,
      manifest_hash: nestedPlan.hash,
      loaded_plan_hash: nestedPlan.hash,
    },
  });
  assert.equal(nestedMetadata.ok, false);
  assert.equal(nestedMetadata.request_id, 'raw-nested-metadata');
  assert.equal(nestedMetadata.failure.code, 'protocol_error');
  assert.equal(nestedMetadata.failure.operation, 'protocol_decode');
});

test('JS lifecycle encoder rejects fields not declared by the operation', async (t) => {
  const port = new RustNodeContainerPort({ binaryPath });
  t.after(() => port.close());
  assert.throws(
    () => port.status({ metadata: { route: 'forbidden' } }),
    (error) => error instanceof CordisHostError && error.code === 'binding_protocol',
  );
});

test('real Cordis fibers drive ordered Rust NodePluginPlan execution', async (t) => {
  const port = new RustNodeContainerPort({ binaryPath });
  t.after(() => port.close());
  const entries = [semanticEntry(), observerEntry()];
  const nodePlan = plan(entries);
  const events = [];
  const host = new CordisBoundNodeHost({
    port,
    plan: nodePlan,
    nodeId: nodePlan.node_id,
    descriptor: { roleId: nodePlan.role_id },
  });

  await host.mount(entries.map((entry) => plugin(entry, events)));
  const output = await host.executeNode(nodePlan.hash, {
    data: { steps: [] },
    control: {},
    information: {},
  });
  assert.deepEqual(output.data, { steps: ['v4.test.echo'] });
  assert.deepEqual(output.control, {});
  assert.equal(output.diagnostics.filter(({ kind }) => kind === 'node.observed').length, 1);
  assert.equal(output.diagnostics.filter(({ kind }) => kind === 'plugin.executed').length, 1);
  assert.equal(host.fibers.length, 2);
  assert.deepEqual(events, ['active', 'active']);

  await host.drain();
  await host.dispose();
  assert.deepEqual(events, ['active', 'active', 'disposed', 'disposed']);
});

test('protocol decode failure retains its typed lifecycle failure code', async (t) => {
  const port = new RustNodeContainerPort({ binaryPath });
  t.after(() => port.close());
  const entries = [controlEntry()];
  const nodePlan = plan(entries);
  const host = new CordisBoundNodeHost({
    port,
    plan: nodePlan,
    nodeId: nodePlan.node_id,
    descriptor: { roleId: nodePlan.role_id },
  });

  await host.mount(entries.map((entry) => plugin(entry)));
  await assert.rejects(
    host.executeNode(nodePlan.hash, {
      data: {},
      control: 'not-a-control-carrier',
      information: {},
    }),
    (error) => (
      error instanceof CordisHostError
      && error.code === 'protocol_error'
      && error.failure?.resource_id === 'v4.node_container.lifecycle_failure'
      && error.failure?.operation === 'protocol_decode'
    ),
  );

  await host.drain();
  await host.dispose();
});

test('execution plan hash mismatch fails before Rust handles run', async (t) => {
  const port = new RustNodeContainerPort({ binaryPath });
  t.after(() => port.close());
  const nodePlan = plan([semanticEntry()]);
  const host = new CordisBoundNodeHost({
    port,
    plan: nodePlan,
    nodeId: nodePlan.node_id,
    descriptor: { roleId: nodePlan.role_id },
  });

  await host.mount([plugin(nodePlan.entries[0])]);
  await assert.rejects(
    host.executeNode(`sha256:${'0'.repeat(64)}`, {
      data: { steps: [] },
      control: {},
      information: {},
    }),
    (error) => error instanceof CordisHostError && error.code === 'plan_hash_mismatch',
  );
  await assert.rejects(
    port.executeNode(`sha256:${'0'.repeat(64)}`, {
      data: { steps: [] },
      control: {},
      information: {},
    }),
    (error) => (
      error instanceof CordisHostError
      && error.code === 'plan_hash_mismatch'
      && error.failure?.resource_id === 'v4.node_container.execution_failure'
      && error.failure?.operation === 'execute_node'
    ),
  );
  assert.equal((await port.status()).in_flight, 0);

  await host.drain();
  await host.dispose();
});

test('unregistered plugin handle fails fast with typed execution failure', async (t) => {
  const port = new RustNodeContainerPort({ binaryPath });
  t.after(() => port.close());
  const ghost = semanticEntry('v4.test.ghost', 500);
  const nodePlan = plan([ghost]);
  const host = new CordisBoundNodeHost({
    port,
    plan: nodePlan,
    nodeId: nodePlan.node_id,
    descriptor: { roleId: nodePlan.role_id },
  });

  await host.mount([plugin(ghost)]);
  await assert.rejects(
    host.executeNode(nodePlan.hash, {
      data: { steps: [] },
      control: {},
      information: {},
    }),
    (error) => (
      error instanceof CordisHostError
      && error.code === 'unregistered_handle'
      && error.failure?.resource_id === 'v4.node_container.execution_failure'
      && error.failure?.operation === 'execute_node'
    ),
  );

  await host.drain();
  await host.dispose();
});

test('JS and Rust reject undeclared execution fields', async (t) => {
  const port = new RustNodeContainerPort({ binaryPath });
  t.after(() => port.close());
  assert.throws(
    () => port.executeNode(`sha256:${'0'.repeat(64)}`, {
      data: {},
      control: {},
      information: {},
      extra: true,
    }),
    (error) => error instanceof CordisHostError && error.code === 'binding_protocol',
  );

  const response = await sendRawLifecycleRequest({
    op: 'execute_node',
    request_id: 'raw-execution-field',
    plan_hash: `sha256:${'0'.repeat(64)}`,
    input: { data: {}, control: {}, information: {}, extra: true },
  });
  assert.equal(response.ok, false);
  assert.equal(response.failure.resource_id, 'v4.node_container.lifecycle_failure');
  assert.equal(response.failure.operation, 'protocol_decode');
  assert.equal(response.failure.code, 'protocol_error');
});

test('execute after drain rejects invalid_state', async (t) => {
  const port = new RustNodeContainerPort({ binaryPath });
  t.after(() => port.close());
  const nodePlan = plan([semanticEntry()]);
  const host = new CordisBoundNodeHost({
    port,
    plan: nodePlan,
    nodeId: nodePlan.node_id,
    descriptor: { roleId: nodePlan.role_id },
  });

  await host.mount([plugin(nodePlan.entries[0])]);
  await host.drain();
  await assert.rejects(
    host.executeNode(nodePlan.hash, {
      data: { steps: [] },
      control: {},
      information: {},
    }),
    (error) => error instanceof CordisHostError && error.code === 'invalid_state',
  );
  await host.dispose();
});

test('JS execution response decoder rejects malformed output', async (t) => {
  const port = new RustNodeContainerPort({
    binaryPath: process.execPath,
    binaryArgs: [unsolicitedResponseBinary, 'malformed-output'],
  });
  t.after(() => port.close());
  await assert.rejects(
    withTimeout(port.executeNode(`sha256:${'0'.repeat(64)}`, {
      data: {},
      control: {},
      information: {},
    })),
    (error) => error instanceof CordisHostError
      && error.code === 'binding_protocol'
      && error.message === 'diagnostic fact fields must be strings',
  );
});

test('JS execution response decoder rejects missing output', async (t) => {
  const port = new RustNodeContainerPort({
    binaryPath: process.execPath,
    binaryArgs: [unsolicitedResponseBinary, 'missing-output'],
  });
  t.after(() => port.close());
  await assert.rejects(
    withTimeout(port.executeNode(`sha256:${'0'.repeat(64)}`, {
      data: {},
      control: {},
      information: {},
    })),
    (error) => error instanceof CordisHostError && error.code === 'binding_protocol',
  );
});

test('execution failure response rejects top-level node identity', async (t) => {
  const port = new RustNodeContainerPort({
    binaryPath: process.execPath,
    binaryArgs: [unsolicitedResponseBinary, 'execution-top-level-node-id'],
  });
  t.after(() => port.close());
  await assert.rejects(
    withTimeout(port.executeNode(`sha256:${'0'.repeat(64)}`, {
      data: {},
      control: {},
      information: {},
    }), 1_000),
    (error) => error instanceof CordisHostError && error.code === 'binding_protocol',
  );
});

test('lifecycle success response must not carry execution output', async (t) => {
  const port = new RustNodeContainerPort({
    binaryPath: process.execPath,
    binaryArgs: [unsolicitedResponseBinary, 'lifecycle-with-output'],
  });
  t.after(() => port.close());
  await assert.rejects(
    withTimeout(port.status()),
    (error) => error instanceof CordisHostError && error.code === 'binding_protocol',
  );
});
