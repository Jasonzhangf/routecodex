import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  __resetProviderSnapshotErrorBufferForTests,
  writeProviderSnapshot
} from '../../../../src/providers/core/utils/snapshot-writer.js';
import { runtimeFlags, setRuntimeFlag } from '../../../../src/runtime/runtime-flags.js';

async function listFilesRecursively(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        out.push(full);
      }
    }
  }
  try {
    await walk(root);
  } catch {
    return [];
  }
  return out;
}

describe('snapshot writer error spill in release mode', () => {
  it('does not write codex snapshots when disabled, and writes provider-error to errorsamples', async () => {
    const previousSnapshotFlag = runtimeFlags.snapshotsEnabled;
    const previousSnapshotDir = process.env.ROUTECODEX_SNAPSHOT_DIR;
    const previousErrorsamplesDir = process.env.ROUTECODEX_ERRORSAMPLES_DIR;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-snapshot-error-spill-'));
    const errorsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-errorsamples-provider-'));

    process.env.ROUTECODEX_SNAPSHOT_DIR = tempDir;
    process.env.ROUTECODEX_ERRORSAMPLES_DIR = errorsDir;
    setRuntimeFlag('snapshotsEnabled', false);
    __resetProviderSnapshotErrorBufferForTests();

    try {
      await writeProviderSnapshot({
        phase: 'provider-request',
        requestId: 'req_err_spill',
        clientRequestId: 'req_err_spill',
        providerKey: 'iflow.2-173.kimi-k2.5',
        entryEndpoint: '/v1/responses',
        data: { step: 'request' }
      });

      expect(await listFilesRecursively(tempDir)).toHaveLength(0);

      await writeProviderSnapshot({
        phase: 'provider-response',
        requestId: 'req_err_spill',
        clientRequestId: 'req_err_spill',
        providerKey: 'iflow.2-173.kimi-k2.5',
        entryEndpoint: '/v1/responses',
        data: { step: 'response' }
      });

      expect(await listFilesRecursively(tempDir)).toHaveLength(0);

      await writeProviderSnapshot({
        phase: 'provider-error',
        requestId: 'req_err_spill',
        clientRequestId: 'req_err_spill',
        providerKey: 'iflow.2-173.kimi-k2.5',
        entryEndpoint: '/v1/responses',
        data: { step: 'error', message: 'boom' }
      });

      const files = await listFilesRecursively(tempDir);
      expect(files).toHaveLength(0);

      const errorSampleFiles = await listFilesRecursively(errorsDir);
      expect(errorSampleFiles.some((file) => file.includes('/provider-error/'))).toBe(true);
    } finally {
      __resetProviderSnapshotErrorBufferForTests();
      setRuntimeFlag('snapshotsEnabled', previousSnapshotFlag);
      if (previousSnapshotDir === undefined) {
        delete process.env.ROUTECODEX_SNAPSHOT_DIR;
      } else {
        process.env.ROUTECODEX_SNAPSHOT_DIR = previousSnapshotDir;
      }
      if (previousErrorsamplesDir === undefined) {
        delete process.env.ROUTECODEX_ERRORSAMPLES_DIR;
      } else {
        process.env.ROUTECODEX_ERRORSAMPLES_DIR = previousErrorsamplesDir;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
      await fs.rm(errorsDir, { recursive: true, force: true });
    }
  });
});
