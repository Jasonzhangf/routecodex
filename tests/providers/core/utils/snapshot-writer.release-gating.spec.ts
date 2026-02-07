import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  __resetProviderSnapshotErrorBufferForTests,
  writeClientSnapshot,
  writeProviderRetrySnapshot,
  writeRepairFeedbackSnapshot
} from '../../../../src/providers/core/utils/snapshot-writer.js';
import { runtimeFlags, setRuntimeFlag } from '../../../../src/runtime/runtime-flags.js';

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
      setRuntimeFlag('snapshotsEnabled', previousSnapshotFlag);
      if (previousSnapshotDir === undefined) {
        delete process.env.ROUTECODEX_SNAPSHOT_DIR;
      } else {
        process.env.ROUTECODEX_SNAPSHOT_DIR = previousSnapshotDir;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
