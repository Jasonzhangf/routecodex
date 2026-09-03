import test from 'node:test';
import assert from 'node:assert/strict';
import { CordisNodeHost, createNodePlugin } from '../src/index.mjs';

test('typed node service is acquired only when ready and released on dispose', async () => {
  const host = new CordisNodeHost({
    nodeId: 'node-a',
    services: ['nodeControl', 'nodeInformation', 'nodeDiagnostics'],
    serviceBindings: new Map([
      ['nodeControl', { kind: 'typed-control', nodeId: 'node-a' }],
      ['nodeInformation', { kind: 'typed-information', nodeId: 'node-a' }],
      ['nodeDiagnostics', { kind: 'typed-diagnostics', nodeId: 'node-a' }],
    ]),
    descriptor: { nodeId: 'node-a', planHash: 'plan-a' },
  });
  assert.throws(() => host.acquireService('nodeControl'), /ready|mounted|active/);
  await host.mount([]);
  const token = host.acquireService('nodeControl');
  assert.equal(token.isValid(), true);
  await host.dispose();
  assert.equal(token.isValid(), false);
  assert.throws(() => host.acquireService('nodeControl'), /disposed|stale|released/);
});

test('mounted plugin receives the declared typed node service through Cordis injection', async () => {
  let received;
  const plugin = Object.assign(function plugin(ctx) {
    received = ctx.nodeControl;
  }, { inject: ['nodeControl'] });
  const service = Object.freeze({ kind: 'typed-control', nodeId: 'node-b' });
  const host = new CordisNodeHost({
    nodeId: 'node-b',
    services: ['nodeControl'],
    serviceBindings: new Map([['nodeControl', service]]),
    descriptor: { nodeId: 'node-b', planHash: 'plan-b' },
  });
  await host.mount([createNodePlugin('control-consumer', plugin)]);
  assert.equal(received, service);
  await host.dispose();
});
