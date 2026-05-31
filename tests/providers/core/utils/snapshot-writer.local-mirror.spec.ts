import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { setRuntimeFlag, runtimeFlags } from '../../../../src/runtime/runtime-flags.js';
import {
  __resetSnapshotLocalDiskGateForTests,
  allowSnapshotLocalDiskWrite
} from '../../../../src/utils/snapshot-local-disk-gate.js';

const writeSnapshotViaHooksMock = jest.fn(async () => undefined);

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge.js', () => ({
  writeSnapshotViaHooks: writeSnapshotViaHooksMock
}));

describe('provider snapshot writer local mirror', () => {
  const originalSnapshotDir = process.env.ROUTECODEX_SNAPSHOT_DIR;
  const originalCompatSnapshotDir = process.env.RCC_SNAPSHOT_DIR;
  const originalSnapshotsEnabled = runtimeFlags.snapshotsEnabled;
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-provider-snapshot-'));
    process.env.ROUTECODEX_SNAPSHOT_DIR = tempDir;
    process.env.RCC_SNAPSHOT_DIR = tempDir;
    setRuntimeFlag('snapshotsEnabled', true);
    writeSnapshotViaHooksMock.mockReset();
    __resetSnapshotLocalDiskGateForTests();
  });

  afterEach(async () => {
    if (originalSnapshotDir === undefined) {
      delete process.env.ROUTECODEX_SNAPSHOT_DIR;
    } else {
      process.env.ROUTECODEX_SNAPSHOT_DIR = originalSnapshotDir;
    }
    if (originalCompatSnapshotDir === undefined) {
      delete process.env.RCC_SNAPSHOT_DIR;
    } else {
      process.env.RCC_SNAPSHOT_DIR = originalCompatSnapshotDir;
    }
    setRuntimeFlag('snapshotsEnabled', originalSnapshotsEnabled);
    __resetSnapshotLocalDiskGateForTests();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('materializes provider-response.json locally even when hook succeeds without writing files', async () => {
    const { writeProviderSnapshot } = await import('../../../../src/providers/core/utils/snapshot-writer.js');
    const { __flushProviderSnapshotQueueForTests } = await import('../../../../src/providers/core/utils/snapshot-writer.js');
    const requestId = 'req_provider_snapshot_local_mirror';
    const providerKey = 'ali-coding-plan.key1.glm-5';

    allowSnapshotLocalDiskWrite(requestId);

    await writeProviderSnapshot({
      phase: 'provider-response',
      requestId,
      clientRequestId: requestId,
      entryEndpoint: '/v1/responses',
      providerKey,
      metadata: { matchedPort: 5555, routingPolicyGroup: 'gateway_priority_5555' },
      data: {
        mode: 'sse',
        captureSse: true,
        transport: 'upstream-stream'
      }
    });
    await __flushProviderSnapshotQueueForTests();

    const filePath = path.join(
      tempDir,
      'openai-responses',
      providerKey,
      requestId,
      'provider-response.json'
    );
    const runtimePath = path.join(
      tempDir,
      'openai-responses',
      providerKey,
      requestId,
      '__runtime.json'
    );
    const raw = await fs.readFile(filePath, 'utf-8');
    const runtimeRaw = await fs.readFile(runtimePath, 'utf-8');
    const parsed = JSON.parse(raw) as { meta?: Record<string, unknown>; body?: Record<string, unknown> };
    const runtimeParsed = JSON.parse(runtimeRaw) as Record<string, unknown>;

    expect(writeSnapshotViaHooksMock).toHaveBeenCalledTimes(1);
    expect(writeSnapshotViaHooksMock).toHaveBeenCalledWith(expect.objectContaining({ entryPort: 5555 }));
    expect(parsed.meta?.stage).toBe('provider-response');
    expect(parsed.meta?.entryPort).toBe(5555);
    expect(parsed.meta?.matchedPort).toBe(5555);
    expect(parsed.body).toMatchObject({
      mode: 'sse',
      captureSse: true,
      transport: 'upstream-stream'
    });
    expect(runtimeParsed.requestId).toBe(requestId);
    expect(runtimeParsed.groupRequestId).toBe(requestId);
    expect(runtimeParsed.providerKey).toBe(providerKey);
    expect(runtimeParsed.entryPort).toBe(5555);
    expect(runtimeParsed.matchedPort).toBe(5555);
  });
});
