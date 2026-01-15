import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { attachProviderSseSnapshotStream } from '../../../../src/providers/core/utils/snapshot-writer.js';
import { runtimeFlags, setRuntimeFlag } from '../../../../src/runtime/runtime-flags.js';

describe('attachProviderSseSnapshotStream', () => {
  it('propagates upstream stream errors to consumers', async () => {
    const prevSnapshots = runtimeFlags.snapshotsEnabled;
    setRuntimeFlag('snapshotsEnabled', false);

    try {
      const upstream = new PassThrough();
      const tee = attachProviderSseSnapshotStream(upstream, { requestId: 'req_test' });

      const errorPromise = once(tee, 'error') as Promise<[Error]>;
      upstream.destroy(new Error('boom'));

      const [error] = await errorPromise;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('boom');
    } finally {
      setRuntimeFlag('snapshotsEnabled', prevSnapshots);
    }
  });
});

