import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';

const writeSnapshotViaHooksMock = jest.fn(async () => undefined);

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
  writeSnapshotViaHooks: writeSnapshotViaHooksMock
}));

describe('server snapshot writer payload guard', () => {
  const originalGlobalSnapshotFlag = (globalThis as { rccSnapshotsEnabled?: boolean }).rccSnapshotsEnabled;
  const originalSnapshotDir = process.env.ROUTECODEX_SNAPSHOT_DIR;
  const originalMaxBytes = process.env.ROUTECODEX_SNAPSHOT_PAYLOAD_MAX_BYTES;
  const originalKeepRecent = process.env.ROUTECODEX_SNAPSHOT_KEEP_RECENT_FILES;
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-snap-guard-'));
    process.env.ROUTECODEX_SNAPSHOT_DIR = tempDir;
    process.env.ROUTECODEX_SNAPSHOT_PAYLOAD_MAX_BYTES = '2048';
    process.env.ROUTECODEX_SNAPSHOT_KEEP_RECENT_FILES = '10';
    (globalThis as { rccSnapshotsEnabled?: boolean }).rccSnapshotsEnabled = true;
    writeSnapshotViaHooksMock.mockReset();
  });

  afterEach(async () => {
    if (originalSnapshotDir === undefined) {
      delete process.env.ROUTECODEX_SNAPSHOT_DIR;
    } else {
      process.env.ROUTECODEX_SNAPSHOT_DIR = originalSnapshotDir;
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
    if (originalGlobalSnapshotFlag === undefined) {
      delete (globalThis as { rccSnapshotsEnabled?: boolean }).rccSnapshotsEnabled;
    } else {
      (globalThis as { rccSnapshotsEnabled?: boolean }).rccSnapshotsEnabled = originalGlobalSnapshotFlag;
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('truncates oversized snapshot payload for hook and local disk write', async () => {
    const { writeServerSnapshot } = await import('../../../src/utils/snapshot-writer.js');

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

    expect(writeSnapshotViaHooksMock).toHaveBeenCalledTimes(1);
    const hookPayload = writeSnapshotViaHooksMock.mock.calls[0]?.[1] as Record<string, unknown>;
    const hookData = hookPayload?.data as Record<string, unknown>;
    expect(hookData.__snapshot_truncated).toBe(true);

    const snapshotDir = path.join(
      tempDir,
      'openai-chat',
      'tabglm.key1.glm-5-turbo',
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
      'tabglm.key1.glm-5-turbo',
      'req_server_snapshot_guard_2'
    );
    const files = await fs.readdir(snapshotDir);
    const payloadFiles = files.filter((name) => name.endsWith('.json') && name !== '__runtime.json');
    expect(payloadFiles.length).toBeLessThanOrEqual(10);
  });
});
