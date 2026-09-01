import test from 'node:test';
import assert from 'node:assert/strict';
import { CordisBoundNodeHost } from '../src/index.mjs';

test('typed node service is acquired only when ready and released on dispose', async () => {
  const host = new CordisBoundNodeHost({
    nodeId: 'node-a',
    services: ['nodeControl', 'nodeInformation', 'nodeDiagnostics'],
    descriptor: { nodeId: 'node-a', planHash: 'plan-a' },
  });
  assert.throws(() => host.acquireService('nodeControl'), /ready|mounted|active/);
  await host.dispose();
  assert.throws(() => host.acquireService('nodeControl'), /disposed|stale|released/);
});
