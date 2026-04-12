import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { runtimeFlags, setRuntimeFlag } from '../../../src/runtime/runtime-flags.js';
import {
  __resetSnapshotLocalDiskGateForTests,
  allowSnapshotLocalDiskWrite
} from '../../../src/utils/snapshot-local-disk-gate.js';

const writeSnapshotViaHooksMock = jest.fn(async () => undefined);

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
  writeSnapshotViaHooks: writeSnapshotViaHooksMock
}));

describe('server snapshot writer payload guard', () => {
  const originalGlobalSnapshotFlag = (globalThis as { rccSnapshotsEnabled?: boolean }).rccSnapshotsEnabled;
  const originalSnapshotDir = process.env.ROUTECODEX_SNAPSHOT_DIR;
  const originalSnapshotStages = process.env.ROUTECODEX_SNAPSHOT_STAGES;
  const originalMaxBytes = process.env.ROUTECODEX_SNAPSHOT_PAYLOAD_MAX_BYTES;
  const originalKeepRecent = process.env.ROUTECODEX_SNAPSHOT_KEEP_RECENT_FILES;
  const originalPruneMinWrites = process.env.ROUTECODEX_SNAPSHOT_PRUNE_MIN_WRITES;
  const originalPruneIntervalMs = process.env.ROUTECODEX_SNAPSHOT_PRUNE_INTERVAL_MS;
  const originalKeepRecentRequestDirs = process.env.ROUTECODEX_SNAPSHOT_KEEP_RECENT_REQUEST_DIRS;
  const originalSnapshotFull = process.env.ROUTECODEX_SNAPSHOT_FULL;
  const originalForceDualWrite = process.env.ROUTECODEX_SERVER_SNAPSHOT_FORCE_DUAL_WRITE;
  const originalRuntimeSnapshotsEnabled = runtimeFlags.snapshotsEnabled;
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-snap-guard-'));
    process.env.ROUTECODEX_SNAPSHOT_DIR = tempDir;
    process.env.ROUTECODEX_SNAPSHOT_STAGES = 'llm-switch-request*';
    process.env.ROUTECODEX_SNAPSHOT_PAYLOAD_MAX_BYTES = '2048';
    process.env.ROUTECODEX_SNAPSHOT_KEEP_RECENT_FILES = '10';
    process.env.ROUTECODEX_SNAPSHOT_KEEP_RECENT_REQUEST_DIRS = '50';
    process.env.ROUTECODEX_SNAPSHOT_PRUNE_MIN_WRITES = '1';
    process.env.ROUTECODEX_SNAPSHOT_PRUNE_INTERVAL_MS = '0';
    process.env.ROUTECODEX_SERVER_SNAPSHOT_FORCE_DUAL_WRITE = '1';
    (globalThis as { rccSnapshotsEnabled?: boolean }).rccSnapshotsEnabled = true;
    writeSnapshotViaHooksMock.mockReset();
    __resetSnapshotLocalDiskGateForTests();
  });

  afterEach(async () => {
    if (originalSnapshotDir === undefined) {
      delete process.env.ROUTECODEX_SNAPSHOT_DIR;
    } else {
      process.env.ROUTECODEX_SNAPSHOT_DIR = originalSnapshotDir;
    }
    if (originalSnapshotStages === undefined) {
      delete process.env.ROUTECODEX_SNAPSHOT_STAGES;
    } else {
      process.env.ROUTECODEX_SNAPSHOT_STAGES = originalSnapshotStages;
    }
    if (originalMaxBytes === undefined) {
      delete process.env.ROUTECODEX_SNAPSHOT_PAYLOAD_MAX_BYTES;
    } else {
      process.env.ROUTECODEX_SNAPSHOT_PAYLOAD_MAX_BYTES = originalMaxBytes;
    }
    if (originalKeepRecent === undefined) {
      delete process.env.ROUTECODEX_SNAPSHOT_KEEP_RECENT_FILES;
    } else {
      process.env.ROUTECODEX_SNAPSHOT_KEEP_RECENT_FILES = originalKeepRecent;
    }
    if (originalPruneMinWrites === undefined) {
      delete process.env.ROUTECODEX_SNAPSHOT_PRUNE_MIN_WRITES;
    } else {
      process.env.ROUTECODEX_SNAPSHOT_PRUNE_MIN_WRITES = originalPruneMinWrites;
    }
    if (originalPruneIntervalMs === undefined) {
      delete process.env.ROUTECODEX_SNAPSHOT_PRUNE_INTERVAL_MS;
    } else {
      process.env.ROUTECODEX_SNAPSHOT_PRUNE_INTERVAL_MS = originalPruneIntervalMs;
    }
    if (originalKeepRecentRequestDirs === undefined) {
      delete process.env.ROUTECODEX_SNAPSHOT_KEEP_RECENT_REQUEST_DIRS;
    } else {
      process.env.ROUTECODEX_SNAPSHOT_KEEP_RECENT_REQUEST_DIRS = originalKeepRecentRequestDirs;
    }
    if (originalSnapshotFull === undefined) {
      delete process.env.ROUTECODEX_SNAPSHOT_FULL;
    } else {
      process.env.ROUTECODEX_SNAPSHOT_FULL = originalSnapshotFull;
    }
    if (originalForceDualWrite === undefined) {
      delete process.env.ROUTECODEX_SERVER_SNAPSHOT_FORCE_DUAL_WRITE;
    } else {
      process.env.ROUTECODEX_SERVER_SNAPSHOT_FORCE_DUAL_WRITE = originalForceDualWrite;
    }
    setRuntimeFlag('snapshotsEnabled', originalRuntimeSnapshotsEnabled);
    if (originalGlobalSnapshotFlag === undefined) {
      delete (globalThis as { rccSnapshotsEnabled?: boolean }).rccSnapshotsEnabled;
    } else {
      (globalThis as { rccSnapshotsEnabled?: boolean }).rccSnapshotsEnabled = originalGlobalSnapshotFlag;
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    __resetSnapshotLocalDiskGateForTests();
  });

  it('truncates oversized snapshot payload for hook and local disk write', async () => {
    const { writeServerSnapshot } = await import('../../../src/utils/snapshot-writer.js');
    allowSnapshotLocalDiskWrite('req_server_snapshot_guard_1');

    await writeServerSnapshot({
      phase: 'llm-switch-request',
      requestId: 'req_server_snapshot_guard_1',
      groupRequestId: 'req_server_snapshot_guard_1',
      entryEndpoint: '/v1/openai',
      providerKey: 'tabglm.key1.glm-5-turbo',
      data: {
        huge: 'x'.repeat(20000),
        list: Array.from({ length: 64 }, (_, i) => ({ i, value: `data-${i}` }))
      }
    });

    const snapshotDir = path.join(
      tempDir,
      'openai-chat',
      'req_server_snapshot_guard_1'
    );
    const files = await fs.readdir(snapshotDir);
    const target = files.find((name) => name.startsWith('llm-switch-request_server'));
    expect(target).toBeTruthy();
    const raw = await fs.readFile(path.join(snapshotDir, target as string), 'utf-8');
    const parsed = JSON.parse(raw) as { data?: Record<string, unknown> };
    expect(parsed.data?.__snapshot_truncated).toBe(true);
  });

  it('keeps only the newest 10 local snapshot files in request dir', async () => {
    const { writeServerSnapshot } = await import('../../../src/utils/snapshot-writer.js');
    allowSnapshotLocalDiskWrite('req_server_snapshot_guard_2');
    for (let i = 0; i < 18; i += 1) {
      await writeServerSnapshot({
        phase: `llm-switch-request-${i}`,
        requestId: 'req_server_snapshot_guard_2',
        groupRequestId: 'req_server_snapshot_guard_2',
        entryEndpoint: '/v1/openai',
        providerKey: 'tabglm.key1.glm-5-turbo',
        data: { index: i, text: `payload-${i}` }
      });
    }
    const snapshotDir = path.join(
      tempDir,
      'openai-chat',
      'req_server_snapshot_guard_2'
    );
    let payloadFiles: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const files = await fs.readdir(snapshotDir);
      payloadFiles = files.filter((name) => name.endsWith('.json') && name !== '__runtime.json');
      if (payloadFiles.length <= 10) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(payloadFiles.length).toBeLessThanOrEqual(11);
  });

  it('keeps only the newest request directories in endpoint bucket', async () => {
    const { writeServerSnapshot } = await import('../../../src/utils/snapshot-writer.js');
    process.env.ROUTECODEX_SNAPSHOT_KEEP_RECENT_REQUEST_DIRS = '3';

    for (let i = 0; i < 8; i += 1) {
      const requestId = `req_server_snapshot_dir_guard_${i}`;
      allowSnapshotLocalDiskWrite(requestId);
      await writeServerSnapshot({
        phase: 'llm-switch-request',
        requestId,
        groupRequestId: requestId,
        entryEndpoint: '/v1/openai',
        providerKey: 'tabglm.key1.glm-5-turbo',
        data: { index: i }
      });
    }

    const endpointDir = path.join(tempDir, 'openai-chat');
    const requestDirs = (await fs.readdir(endpointDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('req_server_snapshot_dir_guard_'))
      .map((entry) => entry.name);

    expect(requestDirs.length).toBeLessThanOrEqual(3);
  });

  it('does not enable full payload capture just because snapshots are on', async () => {
    const { writeServerSnapshot } = await import('../../../src/utils/snapshot-writer.js');
    allowSnapshotLocalDiskWrite('req_server_snapshot_guard_3');

    delete process.env.ROUTECODEX_SNAPSHOT_FULL;
    setRuntimeFlag('snapshotsEnabled', true);

    await writeServerSnapshot({
      phase: 'llm-switch-request',
      requestId: 'req_server_snapshot_guard_3',
      groupRequestId: 'req_server_snapshot_guard_3',
      entryEndpoint: '/v1/openai',
      providerKey: 'tabglm.key1.glm-5-turbo',
      data: {
        huge: 'y'.repeat(20000)
      }
    });

    const snapshotDir = path.join(
      tempDir,
      'openai-chat',
      'req_server_snapshot_guard_3'
    );
    const files = await fs.readdir(snapshotDir);
    const target = files.find((name) => name.startsWith('llm-switch-request_server'));
    expect(target).toBeTruthy();
    const raw = await fs.readFile(path.join(snapshotDir, target as string), 'utf-8');
    const parsed = JSON.parse(raw) as { data?: Record<string, unknown> };
    expect(parsed.data?.__snapshot_truncated).toBe(true);
  });

  it('skips local disk snapshot before request send success unlocks the gate', async () => {
    const { writeServerSnapshot } = await import('../../../src/utils/snapshot-writer.js');
    const { writeClientSnapshot } = await import('../../../src/providers/core/utils/snapshot-writer.js');

    await writeServerSnapshot({
      phase: 'llm-switch-request',
      requestId: 'req_server_snapshot_guard_4',
      groupRequestId: 'req_server_snapshot_guard_4',
      entryEndpoint: '/v1/openai',
      providerKey: 'tabglm.key1.glm-5-turbo',
      data: { hello: 'world' }
    });

    await writeClientSnapshot({
      entryEndpoint: '/v1/openai',
      requestId: 'req_server_snapshot_guard_4',
      body: { input: 'hello' },
      metadata: { clientRequestId: 'req_server_snapshot_guard_4', stream: false }
    });

    const snapshotDir = path.join(tempDir, 'openai-chat', 'req_server_snapshot_guard_4');
    await expect(fs.readdir(snapshotDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
