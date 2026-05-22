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
  const originalSnapshotStages = process.env.ROUTECODEX_SNAPSHOT_STAGES;

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
    if (originalSnapshotStages === undefined) {
      delete process.env.ROUTECODEX_SNAPSHOT_STAGES;
    } else {
      process.env.ROUTECODEX_SNAPSHOT_STAGES = originalSnapshotStages;
    }
  });

  it('drops oversized non-provider snapshot payload before enqueue/write', async () => {
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

    expect(writeSnapshotViaHooksWithNativeMock).not.toHaveBeenCalled();
  });

  it('keeps only the newest N pending snapshot tasks in queue', async () => {
    process.env.ROUTECODEX_SNAPSHOT_QUEUE_MAX_ITEMS = '10';
    process.env.ROUTECODEX_SNAPSHOT_STAGES = 'stage_*';
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

  it('RED: forwards providerKey and groupRequestId into native snapshot hooks so --snap responses can finalize out of __pending__', async () => {
    process.env.ROUTECODEX_SNAPSHOT_STAGES = 'provider-response';
    const { createSnapshotWriter } = await import('../../sharedmodule/llmswitch-core/src/conversion/snapshot-utils.js');
    const writer = createSnapshotWriter({
      requestId: 'req_snapshot_finalize_chain_1',
      endpoint: '/v1/responses',
      providerKey: 'windsurf.ws-pro-4.gpt-5.3-codex',
      groupRequestId: 'openai-responses-windsurf.ws-pro-4-gpt-5.3-codex-20260522T160620130-221799-483'
    });
    expect(writer).toBeTruthy();

    writer?.('provider-response', { ok: true, status: 502 });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(writeSnapshotViaHooksWithNativeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: '/v1/responses',
        stage: 'provider-response',
        requestId: 'req_snapshot_finalize_chain_1',
        providerKey: 'windsurf.ws-pro-4.gpt-5.3-codex',
        groupRequestId: 'openai-responses-windsurf.ws-pro-4-gpt-5.3-codex-20260522T160620130-221799-483',
        verbosity: 'verbose',
        data: { ok: true, status: 502 }
      })
    );
  });

});
