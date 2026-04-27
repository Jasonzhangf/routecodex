import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  __resetProviderSnapshotErrorBufferForTests,
  writeProviderSnapshot,
  writeClientSnapshot,
  writeProviderRetrySnapshot,
  writeRepairFeedbackSnapshot
} from '../../../../src/providers/core/utils/snapshot-writer.js';
import { runtimeFlags, setRuntimeFlag } from '../../../../src/runtime/runtime-flags.js';
import {
  __resetSnapshotLocalDiskGateForTests,
  allowSnapshotLocalDiskWrite
} from '../../../../src/utils/snapshot-local-disk-gate.js';

describe('snapshot writer release gating', () => {
  it('skips retry/client/repair snapshots when runtime snapshots are disabled', async () => {
    const previousSnapshotFlag = runtimeFlags.snapshotsEnabled;
    const previousSnapshotDir = process.env.ROUTECODEX_SNAPSHOT_DIR;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-snapshot-gating-'));

    process.env.ROUTECODEX_SNAPSHOT_DIR = tempDir;
    setRuntimeFlag('snapshotsEnabled', false);
    __resetProviderSnapshotErrorBufferForTests();

    try {
      await writeProviderRetrySnapshot({
        type: 'request',
        requestId: 'req-release-gating',
        data: { ok: true },
        entryEndpoint: '/v1/responses'
      });
      await writeRepairFeedbackSnapshot({
        requestId: 'req-release-gating',
        feedback: { repaired: true },
        entryEndpoint: '/v1/responses'
      });
      await writeClientSnapshot({
        entryEndpoint: '/v1/responses',
        requestId: 'req-release-gating',
        body: { input: 'hello' },
        metadata: { stream: false }
      });

      const entries = await fs.readdir(tempDir);
      expect(entries).toHaveLength(0);
    } finally {
      __resetProviderSnapshotErrorBufferForTests();
      __resetSnapshotLocalDiskGateForTests();
      setRuntimeFlag('snapshotsEnabled', previousSnapshotFlag);
      if (previousSnapshotDir === undefined) {
        delete process.env.ROUTECODEX_SNAPSHOT_DIR;
      } else {
        process.env.ROUTECODEX_SNAPSHOT_DIR = previousSnapshotDir;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('forces provider request/response local mirror on contract failure even when runtime snapshots are disabled', async () => {
    const previousSnapshotFlag = runtimeFlags.snapshotsEnabled;
    const previousSnapshotDir = process.env.ROUTECODEX_SNAPSHOT_DIR;
    const previousCompatSnapshotDir = process.env.RCC_SNAPSHOT_DIR;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-snapshot-force-local-'));

    process.env.ROUTECODEX_SNAPSHOT_DIR = tempDir;
    process.env.RCC_SNAPSHOT_DIR = tempDir;
    setRuntimeFlag('snapshotsEnabled', false);
    __resetProviderSnapshotErrorBufferForTests();
    __resetSnapshotLocalDiskGateForTests();

    try {
      const requestId = 'req-empty-assistant-contract';
      allowSnapshotLocalDiskWrite(requestId);

      await writeProviderSnapshot({
        phase: 'provider-request',
        requestId,
        clientRequestId: requestId,
        entryEndpoint: '/v1/responses',
        providerKey: 'mimo.key1.mimo-v2.5-pro',
        data: { input: [{ role: 'user', content: 'hello' }] },
        forceLocalDiskWriteWhenDisabled: true
      });
      await writeProviderSnapshot({
        phase: 'provider-response',
        requestId,
        clientRequestId: requestId,
        entryEndpoint: '/v1/responses',
        providerKey: 'mimo.key1.mimo-v2.5-pro',
        data: { status: 'completed', output_text: '' },
        forceLocalDiskWriteWhenDisabled: true
      });

      const requestPath = path.join(
        tempDir,
        'openai-responses',
        'mimo.key1.mimo-v2.5-pro',
        requestId,
        'provider-request.json'
      );
      const responsePath = path.join(
        tempDir,
        'openai-responses',
        'mimo.key1.mimo-v2.5-pro',
        requestId,
        'provider-response.json'
      );

      await expect(fs.readFile(requestPath, 'utf-8')).resolves.toContain('"stage": "provider-request"');
      await expect(fs.readFile(responsePath, 'utf-8')).resolves.toContain('"stage": "provider-response"');
    } finally {
      __resetProviderSnapshotErrorBufferForTests();
      __resetSnapshotLocalDiskGateForTests();
      setRuntimeFlag('snapshotsEnabled', previousSnapshotFlag);
      if (previousSnapshotDir === undefined) {
        delete process.env.ROUTECODEX_SNAPSHOT_DIR;
      } else {
        process.env.ROUTECODEX_SNAPSHOT_DIR = previousSnapshotDir;
      }
      if (previousCompatSnapshotDir === undefined) {
        delete process.env.RCC_SNAPSHOT_DIR;
      } else {
        process.env.RCC_SNAPSHOT_DIR = previousCompatSnapshotDir;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
