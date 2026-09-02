import test from 'node:test';
import assert from 'node:assert/strict';
import { CordisNodeHost, CordisHostError, createNodePlugin } from '../src/index.mjs';

test('typed node services require readiness and release on dispose', async () => {
  const host = new CordisNodeHost({
    nodeId: 'node-a',
    services: ['nodeControl', 'nodeInformation', 'nodeDiagnostics'],
    descriptor: { nodeId: 'node-a', planHash: 'plan-a' },
  });
  await host.mount([]);
  assert.ok(host.acquireService('nodeControl'));
  await host.dispose();
  assert.throws(() => host.acquireService('nodeControl'), /disposed|stale|released/);
});

test('disposal attempts every fiber and fails with an aggregate after partial failure', async () => {
  const events = [];
  const plugin = (id) => createNodePlugin(id, (ctx) => {
    ctx.effect(() => () => events.push(`${id}:disposed`));
    events.push(`${id}:active`);
  });
  const host = new CordisNodeHost({
    nodeId: 'node-a',
    services: ['nodeControl', 'nodeInformation', 'nodeDiagnostics'],
    descriptor: { nodeId: 'node-a', planHash: 'plan-a' },
  });
  await host.mount([plugin('node-control'), plugin('node-diagnostics')]);
  const token = host.acquireService('nodeControl');
  host.fibers[0].fiber.dispose = async () => {
    throw new Error('dispose boom');
  };

  await assert.rejects(
    host.dispose(),
    (error) => (
      error instanceof CordisHostError
      && error.code === 'dispose_failure'
      && error.failure?.resource_id === 'v4.cordis.plugin_fibers'
      && error.failure?.operation === 'dispose'
      && error.message.includes('node-control')
      && error.failure?.failures?.length === 1
    ),
  );
  assert.equal(host.disposed, true);
  assert.deepEqual(host.fibers, []);
  assert.deepEqual(events, ['node-control:active', 'node-diagnostics:active', 'node-diagnostics:disposed']);
  assert.equal(token.isValid(), false);
  assert.throws(() => host.acquireService('nodeControl'), /disposed|stale|released/);
});

test('disposal keeps attempting after the first-disposed fiber rejects and aggregates all failures', async () => {
  const events = [];
  const plugin = (id) => createNodePlugin(id, (ctx) => {
    ctx.effect(() => () => events.push(`${id}:disposed`));
    events.push(`${id}:active`);
  });
  const host = new CordisNodeHost({
    nodeId: 'node-b',
    services: ['nodeControl', 'nodeDiagnostics'],
    descriptor: { nodeId: 'node-b', planHash: 'plan-b' },
  });
  await host.mount([plugin('first'), plugin('second'), plugin('third')]);
  host.fibers[1].fiber.dispose = async () => {
    throw new Error('middle boom');
  };

  await assert.rejects(
    host.dispose(),
    (error) => (
      error instanceof CordisHostError
      && error.code === 'dispose_failure'
      && error.failure?.failures?.length === 1
      && error.failure.failures[0].plugin_id === 'second'
    ),
  );
  assert.equal(host.disposed, true);
  assert.deepEqual(events, [
    'first:active',
    'second:active',
    'third:active',
    'third:disposed',
    'first:disposed',
  ]);
});
