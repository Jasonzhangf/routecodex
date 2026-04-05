import { jest } from '@jest/globals';

const writeSnapshotViaHooksWithNativeMock = jest.fn();
const shouldRecordSnapshotsWithNativeMock = jest.fn(() => true);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-snapshot-hooks.js',
  () => ({
    shouldRecordSnapshotsWithNative: shouldRecordSnapshotsWithNativeMock,
    writeSnapshotViaHooksWithNative: writeSnapshotViaHooksWithNativeMock
  })
);

describe('snapshot-utils memory guard', () => {
  const originalMaxBytes = process.env.ROUTECODEX_SNAPSHOT_PAYLOAD_MAX_BYTES;
  const originalQueueMaxItems = process.env.ROUTECODEX_SNAPSHOT_QUEUE_MAX_ITEMS;

  afterEach(() => {
    writeSnapshotViaHooksWithNativeMock.mockReset();
    shouldRecordSnapshotsWithNativeMock.mockReset();
    shouldRecordSnapshotsWithNativeMock.mockReturnValue(true);
    if (originalMaxBytes === undefined) {
      delete process.env.ROUTECODEX_SNAPSHOT_PAYLOAD_MAX_BYTES;
    } else {
      process.env.ROUTECODEX_SNAPSHOT_PAYLOAD_MAX_BYTES = originalMaxBytes;
    }
    if (originalQueueMaxItems === undefined) {
      delete process.env.ROUTECODEX_SNAPSHOT_QUEUE_MAX_ITEMS;
    } else {
      process.env.ROUTECODEX_SNAPSHOT_QUEUE_MAX_ITEMS = originalQueueMaxItems;
    }
  });

  it('truncates oversized snapshot payload before enqueue/write', async () => {
    process.env.ROUTECODEX_SNAPSHOT_PAYLOAD_MAX_BYTES = '2048';
    const { createSnapshotWriter } = await import('../../sharedmodule/llmswitch-core/src/conversion/snapshot-utils.js');
    const writer = createSnapshotWriter({
      requestId: 'req_snapshot_guard_1',
      endpoint: '/v1/openai'
    });
    expect(writer).toBeTruthy();

    writer?.('req_inbound_stage2_semantic_map', {
      huge: 'x'.repeat(20000),
      nested: {
        arr: Array.from({ length: 64 }, (_, i) => ({ i, content: `chunk-${i}` }))
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(writeSnapshotViaHooksWithNativeMock).toHaveBeenCalledTimes(1);
    const payload = writeSnapshotViaHooksWithNativeMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toBeTruthy();
    const data = payload?.data as Record<string, unknown>;
    expect(data.__snapshot_truncated).toBe(true);
    expect(data.stage).toBe('req_inbound_stage2_semantic_map');
    expect(typeof data.maxBytes).toBe('number');
    expect(typeof data.estimatedBytes).toBe('number');
    expect(data.summary).toBeTruthy();
  });

  it('keeps only the newest N pending snapshot tasks in queue', async () => {
    process.env.ROUTECODEX_SNAPSHOT_QUEUE_MAX_ITEMS = '10';
    const { createSnapshotWriter } = await import('../../sharedmodule/llmswitch-core/src/conversion/snapshot-utils.js');
    const writer = createSnapshotWriter({
      requestId: 'req_snapshot_guard_2',
      endpoint: '/v1/openai'
    });
    expect(writer).toBeTruthy();

    for (let i = 0; i < 40; i += 1) {
      writer?.(`stage_${i}`, { i, payload: `x${i}` });
    }
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(writeSnapshotViaHooksWithNativeMock.mock.calls.length).toBeLessThanOrEqual(10);
    const stages = writeSnapshotViaHooksWithNativeMock.mock.calls
      .map((call) => String((call?.[0] as Record<string, unknown>)?.stage ?? ''))
      .filter(Boolean);
    expect(stages).toContain('stage_39');
    expect(stages).not.toContain('stage_0');
  });
});
