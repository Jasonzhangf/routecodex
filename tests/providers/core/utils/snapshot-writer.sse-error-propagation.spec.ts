import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { runtimeFlags, setRuntimeFlag } from '../../../../src/runtime/runtime-flags.js';
import { MetadataCenter } from '../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';
import {
  __resetSnapshotLocalDiskGateForTests,
  allowSnapshotLocalDiskWrite
} from '../../../../src/utils/snapshot-local-disk-gate.js';

jest.mock('../../../../src/modules/llmswitch/bridge.js', () => ({
  writeSnapshotViaHooks: async () => undefined
}));

describe('attachProviderSseSnapshotStream', () => {
  const originalSnapshotDir = process.env.ROUTECODEX_SNAPSHOT_DIR;
  const originalCompatSnapshotDir = process.env.RCC_SNAPSHOT_DIR;

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
    __resetSnapshotLocalDiskGateForTests();
  });

  it('returns original upstream stream and preserves upstream errors', async () => {
    const prevSnapshots = runtimeFlags.snapshotsEnabled;
    setRuntimeFlag('snapshotsEnabled', false);

    try {
      const { attachProviderSseSnapshotStream } = await import('../../../../src/providers/core/utils/snapshot-writer.js');
      const upstream = new PassThrough();
      const observed = attachProviderSseSnapshotStream(upstream, { requestId: 'req_test', entryPort: 4444 });

      expect(observed).toBe(upstream);

      const errorPromise = once(observed, 'error') as Promise<[Error]>;
      upstream.destroy(new Error('boom'));

      const [error] = await errorPromise;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('boom');
    } finally {
      setRuntimeFlag('snapshotsEnabled', prevSnapshots);
    }
  });

  it('writes provider-response under MetadataCenter entryPort on response.sse.client_close', async () => {
    const prevSnapshots = runtimeFlags.snapshotsEnabled;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-provider-sse-client-close-'));
    process.env.ROUTECODEX_SNAPSHOT_DIR = tempDir;
    process.env.RCC_SNAPSHOT_DIR = tempDir;
    setRuntimeFlag('snapshotsEnabled', true);

    try {
      const { attachProviderSseSnapshotStream, __flushProviderSnapshotQueueForTests } = await import('../../../../src/providers/core/utils/snapshot-writer.js');
      const requestId = 'req_sse_client_close_entry_port';
      const metadata = {};
      MetadataCenter.attach(metadata).writeRequestTruth(
        'portScope',
        '4444',
        {
          module: 'tests/providers/core/utils/snapshot-writer.sse-error-propagation.spec.ts',
          symbol: 'writes provider-response under MetadataCenter entryPort on response.sse.client_close',
          stage: 'test'
        }
      );
      allowSnapshotLocalDiskWrite(requestId);

      const upstream = new PassThrough();
      attachProviderSseSnapshotStream(upstream, {
        requestId,
        entryEndpoint: '/v1/responses',
        clientRequestId: requestId,
        providerKey: 'mock.provider',
        metadata
      });
      upstream.write('data: {"type":"response.output_text.delta","delta":"hi"}\n\n');
      upstream.emit('close');
      await __flushProviderSnapshotQueueForTests();

      const raw = await fs.readFile(
        path.join(tempDir, 'openai-responses', 'ports', '4444', requestId, 'provider-response.json'),
        'utf-8'
      );
      const parsed = JSON.parse(raw) as { meta?: Record<string, unknown>; body?: Record<string, unknown> };
      expect(parsed.meta?.entryPort).toBe(4444);
      expect(parsed.meta?.matchedPort).toBe(4444);
      expect(parsed.body).toMatchObject({
        mode: 'sse',
        captureBytes: expect.any(Number)
      });
    } finally {
      setRuntimeFlag('snapshotsEnabled', prevSnapshots);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
