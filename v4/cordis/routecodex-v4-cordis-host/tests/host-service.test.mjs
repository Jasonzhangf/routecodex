import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeNodePluginPlanHash,
  CordisBoundNodeHost,
  CordisHostError,
  CordisNodeHost,
  createNodePlugin,
} from '../src/index.mjs';

test('node host declares typed node services as Cordis Context isolates', () => {
  const host = new CordisNodeHost({
    nodeId: 'service-node',
    descriptor: { roleId: 'request_chat_process' },
  });
  assert.equal(host.serviceBindings().includes('nodeControl'), true);
  assert.equal(host.serviceBindings().includes('nodeInformation'), true);
  assert.equal(host.serviceBindings().includes('nodeDiagnostics'), true);
});

test('bound host exposes service bindings without exposing payload fields', async () => {
  const planValue = {
    node_id: 'service-bound',
    role_id: 'request_chat_process',
    chain: 'request',
    position: 4,
    entries: [],
    selection_groups: [],
    hash: '',
  };
  const plan = { ...planValue, hash: computeNodePluginPlanHash(planValue) };
  const port = {
    declare: async () => ({ ok: true }),
    contextCreated: async () => ({ ok: true }),
    pluginsMounted: async () => ({ ok: true }),
    publish: async () => ({ ok: true }),
    fail: async () => ({ ok: true }),
    status: async () => ({ state: 'draining' }),
    dispose: async () => ({ ok: true }),
  };
  const host = new CordisBoundNodeHost({
    port,
    plan,
    nodeId: 'service-bound',
    descriptor: { roleId: 'request_chat_process' },
  });
  assert.deepEqual(host.serviceBindings(), [
    'nodeControl',
    'nodeInformation',
    'nodeDiagnostics',
  ]);
});

test('plugin injecting undeclared service fails before mount', async () => {
  const planValue = {
    node_id: 'missing-service-bound',
    role_id: 'request_chat_process',
    chain: 'request',
    position: 4,
    entries: [],
    selection_groups: [],
    hash: '',
  };
  const plan = { ...planValue, hash: computeNodePluginPlanHash(planValue) };
  const host = new CordisBoundNodeHost({
    port: {
      declare: async () => ({ ok: true }),
      contextCreated: async () => ({ ok: true }),
      pluginsMounted: async () => ({ ok: true }),
      publish: async () => ({ ok: true }),
      fail: async () => ({ ok: true }),
      status: async () => ({ state: 'draining' }),
      dispose: async () => ({ ok: true }),
    },
    plan,
    nodeId: 'missing-service',
    descriptor: { roleId: 'request_chat_process' },
  });
  const plugin = createNodePlugin(
    'missing',
    Object.assign(() => {}, { inject: ['missingService'] }),
  );
  await assert.rejects(
    host.mount([plugin]),
    (error) => error instanceof CordisHostError && error.code === 'service_not_declared',
  );
});

test('typed services remain metadata-only and are not payload fields', () => {
  const host = new CordisNodeHost({
    nodeId: 'service-plane',
    descriptor: { roleId: 'request_chat_process' },
  });
  const serviceNames = host.serviceBindings ? host.serviceBindings() : host.services;
  for (const name of serviceNames) {
    assert.equal(name.includes('payload'), false);
    assert.equal(name.toLowerCase().includes('control'), name === 'nodeControl');
  }
});

test('declared typed node services are not rejected by the typed-service check', async () => {
  const planValue = {
    node_id: 'declared-service-bound',
    role_id: 'request_chat_process',
    chain: 'request',
    position: 4,
    entries: [],
    selection_groups: [],
    hash: '',
  };
  const plan = { ...planValue, hash: computeNodePluginPlanHash(planValue) };
  const host = new CordisBoundNodeHost({
    port: {
      declare: async () => ({ ok: true }),
      contextCreated: async () => ({ ok: true }),
      pluginsMounted: async () => ({ ok: true }),
      publish: async () => ({ ok: true }),
      fail: async () => ({ ok: true }),
      status: async () => ({ state: 'draining' }),
      dispose: async () => ({ ok: true }),
    },
    plan,
    nodeId: 'declared-service',
    descriptor: { roleId: 'request_chat_process' },
  });
  const plugin = createNodePlugin(
    'declared-service-plugin',
    Object.assign(() => {}, {
      inject: ['nodeControl', 'nodeInformation', 'nodeDiagnostics'],
    }),
    undefined,
    planValue,
  );
  await assert.rejects(
    host.mount([plugin]),
    (error) => (
      error instanceof CordisHostError
      && error.code !== 'service_not_declared'
    ),
  );
});
