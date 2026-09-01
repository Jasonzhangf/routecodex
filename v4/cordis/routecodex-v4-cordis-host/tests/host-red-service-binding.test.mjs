import test from 'node:test';
import assert from 'node:assert/strict';
import { CordisBoundNodeHost } from '../src/index.mjs';

test('typed node services require readiness and release on dispose', async () => {
  const host = new CordisBoundNodeHost({
    nodeId: 'node-a',
    services: ['nodeControl', 'nodeInformation', 'nodeDiagnostics'],
    descriptor: { nodeId: 'node-a', planHash: 'plan-a' },
  });
  await host.mount();
  assert.ok(host.acquireService('nodeControl'));
  await host.dispose();
  assert.throws(() => host.acquireService('nodeControl'), /disposed|stale|released/);
});
