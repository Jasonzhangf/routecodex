import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { jest } from '@jest/globals';
import { runtimeFlags, setRuntimeFlag } from '../../../../src/runtime/runtime-flags.js';

jest.mock('../../../../src/modules/llmswitch/bridge.js', () => ({
  writeSnapshotViaHooks: async () => undefined
}));

describe('attachProviderSseSnapshotStream', () => {
  it('returns original upstream stream and preserves upstream errors', async () => {
    const prevSnapshots = runtimeFlags.snapshotsEnabled;
    setRuntimeFlag('snapshotsEnabled', false);

    try {
      const { attachProviderSseSnapshotStream } = await import('../../../../src/providers/core/utils/snapshot-writer.js');
      const upstream = new PassThrough();
      const observed = attachProviderSseSnapshotStream(upstream, { requestId: 'req_test' });

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
});
