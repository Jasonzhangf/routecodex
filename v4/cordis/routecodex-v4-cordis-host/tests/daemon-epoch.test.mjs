import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CordisHostDaemonClient,
  CordisHostDaemonError,
  startCordisHostDaemon,
} from '../src/daemon.mjs';

const hash = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const bundle = (candidateId, epochId) => ({
  schema_version: 1,
  candidate_id: candidateId,
  epoch_id: epochId,
  manifest_hash: hash({ candidateId, epochId, kind: 'manifest' }),
  graph_hash: hash({ candidateId, epochId, kind: 'graph' }),
  plugin_artifact_set_hash: hash({ candidateId, epochId, kind: 'plugins' }),
  entrypoints: { request: 'V4HubReqInbound02Standardized' },
  pipelines: { request: ['req'], response: ['resp'], error: ['err'] },
  nodes: [{
    node_id: 'node-1',
    plan_hash: hash({ candidateId, epochId, kind: 'plan' }),
    input_resource: 'input',
    output_resource: 'output',
    allowed_edges: [],
    plugins: [],
  }],
  policies: {},
});
const command = (kind, commandId, payload, extra = {}) => ({
  schema_version: 1,
  kind,
  command_id: commandId,
  generation: 1,
  correlation_id: `corr-${commandId}`,
  payload_hash: hash(payload),
  payload,
  ...extra,
});

async function daemonFixture(t) {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'rccv4-epoch-'));
  const socketPath = path.join(stateDirectory, 'cordis.sock');
  const active = bundle('candidate-1', 'epoch-1');
  const daemon = await startCordisHostDaemon({
    stateDirectory,
    socketPath,
    graphHash: 'graph-a',
    version: 'test',
    initialBundle: active,
  });
  const client = await CordisHostDaemonClient.connect({ socketPath, graphHash: 'graph-a' });
  t.after(async () => {
    await client.close();
    await daemon.shutdown();
    await fs.rm(stateDirectory, { recursive: true, force: true });
  });
  return { client, active };
}

test('formal epoch control runs PrepareEpoch -> CommitEpoch -> QueryActiveEpoch -> DrainEpoch', async (t) => {
  const { client, active } = await daemonFixture(t);
  const candidate = bundle('candidate-2', 'epoch-2');
  const prepared = await client.prepareEpoch(command(
    'PrepareEpoch', 'tx-1', { bundle: candidate },
    { expected_base_hash: active.manifest_hash },
  ));
  assert.equal(prepared.result.state, 'Prepared');
  assert.equal(prepared.kind, 'PrepareEpoch');
  assert.equal((await client.commitEpoch(command('CommitEpoch', 'tx-1', {}))).result.state, 'Committed');
  const queried = await client.queryActiveEpoch(command('QueryActiveEpoch', 'query-1', {}));
  assert.deepEqual(queried.result.active_epoch, candidate);
  assert.equal((await client.drainEpoch(command('DrainEpoch', 'tx-1', {}))).result.state, 'Draining');
});

test('epoch control rejects stale base, payload hash drift, and invalid state', async (t) => {
  const { client, active } = await daemonFixture(t);
  const candidate = bundle('candidate-2', 'epoch-2');
  await assert.rejects(
    client.prepareEpoch(command('PrepareEpoch', 'stale', { bundle: candidate }, {
      expected_base_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    })),
    (error) => error instanceof CordisHostDaemonError && error.code === 'stale_base',
  );
  const invalid = command('PrepareEpoch', 'drift', { bundle: candidate }, { expected_base_hash: active.manifest_hash });
  invalid.payload_hash = hash({ bundle: bundle('other', 'epoch-other') });
  await assert.rejects(
    client.sendEpochControl(invalid),
    (error) => error instanceof CordisHostDaemonError && error.code === 'payload_hash_mismatch',
  );
  await assert.rejects(
    client.commitEpoch(command('CommitEpoch', 'unknown', {})),
    (error) => error instanceof CordisHostDaemonError && error.code === 'unknown_transaction',
  );
});

test('RollbackEpoch restores the previously active immutable bundle', async (t) => {
  const { client, active } = await daemonFixture(t);
  const candidate = bundle('candidate-2', 'epoch-2');
  await client.prepareEpoch(command(
    'PrepareEpoch', 'tx-rollback', { bundle: candidate },
    { expected_base_hash: active.manifest_hash },
  ));
  await client.commitEpoch(command('CommitEpoch', 'tx-rollback', {}));
  const rolledBack = await client.rollbackEpoch(command('RollbackEpoch', 'tx-rollback', {}));
  assert.equal(rolledBack.result.state, 'RolledBack');
  const queried = await client.queryActiveEpoch(command('QueryActiveEpoch', 'query-rollback', {}));
  assert.deepEqual(queried.result.active_epoch, active);
});
