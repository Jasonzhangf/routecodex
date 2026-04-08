import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  __resetProviderSnapshotErrorBufferForTests,
  writeProviderRetrySnapshot,
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

function normalizeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_');
}

describe('provider snapshot 429 suppression', () => {
  it('purges existing provider snapshot artifacts when a 429 provider stage arrives', async () => {
    const previousSnapshotFlag = runtimeFlags.snapshotsEnabled;
    const previousSnapshotDir = process.env.ROUTECODEX_SNAPSHOT_DIR;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-snapshot-429-purge-'));

    process.env.ROUTECODEX_SNAPSHOT_DIR = tempDir;
    setRuntimeFlag('snapshotsEnabled', true);
    __resetProviderSnapshotErrorBufferForTests();

    try {
      const requestId = 'req_429_purge';
      const providerKey = 'qwen.1.qwen3.6-plus';
      const folder = 'openai-responses';
      const providerDir = path.join(tempDir, folder, normalizeToken(providerKey), requestId);
      const legacyDir = path.join(tempDir, folder, requestId);

      await fs.mkdir(providerDir, { recursive: true });
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.writeFile(path.join(providerDir, 'provider-response.json'), '{"ok":true}', 'utf-8');
      await fs.writeFile(path.join(legacyDir, 'provider-error.json'), '{"ok":false}', 'utf-8');

      const before = await listFilesRecursively(tempDir);
      expect(before.length).toBeGreaterThan(0);

      await writeProviderSnapshot({
        phase: 'provider-error',
        requestId,
        clientRequestId: requestId,
        providerKey,
        entryEndpoint: '/v1/responses',
        data: {
          statusCode: 429,
          code: 'HTTP_429',
          error: { message: 'Too many requests' }
        }
      });

      const after = await listFilesRecursively(tempDir);
      expect(after).toHaveLength(0);
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

  it('suppresses provider retry snapshots for 429 payloads', async () => {
    const previousSnapshotFlag = runtimeFlags.snapshotsEnabled;
    const previousSnapshotDir = process.env.ROUTECODEX_SNAPSHOT_DIR;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-snapshot-429-retry-'));

    process.env.ROUTECODEX_SNAPSHOT_DIR = tempDir;
    setRuntimeFlag('snapshotsEnabled', true);
    __resetProviderSnapshotErrorBufferForTests();

    try {
      await writeProviderRetrySnapshot({
        type: 'response',
        requestId: 'req_429_retry',
        clientRequestId: 'req_429_retry',
        providerKey: 'qwen.1.qwen3.6-plus',
        entryEndpoint: '/v1/responses',
        data: {
          error: {
            status: 429,
            code: 'HTTP_429',
            message: 'rate limited'
          }
        }
      });

      const files = await listFilesRecursively(tempDir);
      expect(files).toHaveLength(0);
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
