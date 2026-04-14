import { jest } from '@jest/globals';

const writeSnapshotViaHooksMock = jest.fn(async () => undefined);

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge.js', () => ({
  writeSnapshotViaHooks: writeSnapshotViaHooksMock
}));

describe('provider snapshot writer queue', () => {
  let previousSnapshotFlag = false;
  const previousMaxItems = process.env.ROUTECODEX_PROVIDER_SNAPSHOT_QUEUE_MAX_ITEMS;
  const previousBudget = process.env.ROUTECODEX_PROVIDER_SNAPSHOT_QUEUE_MEMORY_BUDGET_BYTES;

  beforeEach(() => {
    jest.resetModules();
    process.env.ROUTECODEX_PROVIDER_SNAPSHOT_QUEUE_MAX_ITEMS = '2';
    process.env.ROUTECODEX_PROVIDER_SNAPSHOT_QUEUE_MEMORY_BUDGET_BYTES = '1048576';
    writeSnapshotViaHooksMock.mockReset();
  });

  afterEach(async () => {
    const snapshotWriter = await import('../../../../src/providers/core/utils/snapshot-writer.js');
    snapshotWriter.__resetProviderSnapshotErrorBufferForTests();
    snapshotWriter.__resetProviderSnapshotQueueForTests();
    const runtimeFlagsModule = await import('../../../../src/runtime/runtime-flags.js');
    runtimeFlagsModule.setRuntimeFlag('snapshotsEnabled', previousSnapshotFlag);
    if (previousMaxItems === undefined) {
      delete process.env.ROUTECODEX_PROVIDER_SNAPSHOT_QUEUE_MAX_ITEMS;
    } else {
      process.env.ROUTECODEX_PROVIDER_SNAPSHOT_QUEUE_MAX_ITEMS = previousMaxItems;
    }
    if (previousBudget === undefined) {
      delete process.env.ROUTECODEX_PROVIDER_SNAPSHOT_QUEUE_MEMORY_BUDGET_BYTES;
    } else {
      process.env.ROUTECODEX_PROVIDER_SNAPSHOT_QUEUE_MEMORY_BUDGET_BYTES = previousBudget;
    }
  });

  it('drops oldest pending snapshot tasks when the queue is full', async () => {
    const runtimeFlagsModule = await import('../../../../src/runtime/runtime-flags.js');
    previousSnapshotFlag = runtimeFlagsModule.runtimeFlags.snapshotsEnabled;
    runtimeFlagsModule.setRuntimeFlag('snapshotsEnabled', true);
    const {
      __flushProviderSnapshotQueueForTests,
      __resetProviderSnapshotErrorBufferForTests,
      __resetProviderSnapshotQueueForTests,
      writeProviderSnapshot
    } = await import('../../../../src/providers/core/utils/snapshot-writer.js');
    __resetProviderSnapshotErrorBufferForTests();
    __resetProviderSnapshotQueueForTests();

    await writeProviderSnapshot({
      phase: 'provider-request',
      requestId: 'req_queue_1',
      clientRequestId: 'req_queue_1',
      providerKey: 'qwen.1.qwen3.6-plus',
      entryEndpoint: '/v1/responses',
      data: { seq: 1 }
    });
    await writeProviderSnapshot({
      phase: 'provider-request',
      requestId: 'req_queue_2',
      clientRequestId: 'req_queue_2',
      providerKey: 'qwen.1.qwen3.6-plus',
      entryEndpoint: '/v1/responses',
      data: { seq: 2 }
    });
    await writeProviderSnapshot({
      phase: 'provider-request',
      requestId: 'req_queue_3',
      clientRequestId: 'req_queue_3',
      providerKey: 'qwen.1.qwen3.6-plus',
      entryEndpoint: '/v1/responses',
      data: { seq: 3 }
    });
    await writeProviderSnapshot({
      phase: 'provider-request',
      requestId: 'req_queue_4',
      clientRequestId: 'req_queue_4',
      providerKey: 'qwen.1.qwen3.6-plus',
      entryEndpoint: '/v1/responses',
      data: { seq: 4 }
    });

    await __flushProviderSnapshotQueueForTests();

    expect(writeSnapshotViaHooksMock).toHaveBeenCalledTimes(2);
    expect(writeSnapshotViaHooksMock.mock.calls.map((call) => call[0]?.requestId)).toEqual([
      'req_queue_3',
      'req_queue_4'
    ]);
  });
});
