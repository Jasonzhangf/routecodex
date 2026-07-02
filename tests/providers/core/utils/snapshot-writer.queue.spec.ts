import { jest } from '@jest/globals';

const writeUnifiedSnapshotMock = jest.fn(async () => undefined);

jest.unstable_mockModule('../../../../src/debug/snapshot/writer.js', () => ({
  writeUnifiedSnapshot: writeUnifiedSnapshotMock,
  createSnapshotWriter: () => ({ write: writeUnifiedSnapshotMock }),
  isSnapshotsEnabled: () => true,
}));

describe('provider snapshot writer queue', () => {
  let previousSnapshotFlag = false;
  const previousMaxItems = process.env.ROUTECODEX_PROVIDER_SNAPSHOT_QUEUE_MAX_ITEMS;
  const previousBudget = process.env.ROUTECODEX_PROVIDER_SNAPSHOT_QUEUE_MEMORY_BUDGET_BYTES;
  const previousSnapshotStages = process.env.ROUTECODEX_SNAPSHOT_STAGES;
  const previousSnapshotPayloadMaxBytes = process.env.ROUTECODEX_SNAPSHOT_PAYLOAD_MAX_BYTES;

  beforeEach(() => {
    jest.resetModules();
    process.env.ROUTECODEX_PROVIDER_SNAPSHOT_QUEUE_MAX_ITEMS = '2';
    process.env.ROUTECODEX_PROVIDER_SNAPSHOT_QUEUE_MEMORY_BUDGET_BYTES = '1048576';
    writeUnifiedSnapshotMock.mockReset();
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
    if (previousSnapshotStages === undefined) {
      delete process.env.ROUTECODEX_SNAPSHOT_STAGES;
    } else {
      process.env.ROUTECODEX_SNAPSHOT_STAGES = previousSnapshotStages;
    }
    if (previousSnapshotPayloadMaxBytes === undefined) {
      delete process.env.ROUTECODEX_SNAPSHOT_PAYLOAD_MAX_BYTES;
    } else {
      process.env.ROUTECODEX_SNAPSHOT_PAYLOAD_MAX_BYTES = previousSnapshotPayloadMaxBytes;
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
      phase: 'provider-response',
      requestId: 'req_queue_1',
      clientRequestId: 'req_queue_1',
      providerKey: 'qwen.1.qwen3.6-plus',
      entryEndpoint: '/v1/responses',
      entryPort: 5555,
      data: { seq: 1 }
    });
    await writeProviderSnapshot({
      phase: 'provider-response',
      requestId: 'req_queue_2',
      clientRequestId: 'req_queue_2',
      providerKey: 'qwen.1.qwen3.6-plus',
      entryEndpoint: '/v1/responses',
      entryPort: 5555,
      data: { seq: 2 }
    });
    await writeProviderSnapshot({
      phase: 'provider-response',
      requestId: 'req_queue_3',
      clientRequestId: 'req_queue_3',
      providerKey: 'qwen.1.qwen3.6-plus',
      entryEndpoint: '/v1/responses',
      entryPort: 5555,
      data: { seq: 3 }
    });
    await writeProviderSnapshot({
      phase: 'provider-response',
      requestId: 'req_queue_4',
      clientRequestId: 'req_queue_4',
      providerKey: 'qwen.1.qwen3.6-plus',
      entryEndpoint: '/v1/responses',
      entryPort: 5555,
      data: { seq: 4 }
    });

    await __flushProviderSnapshotQueueForTests();

    expect(writeUnifiedSnapshotMock).toHaveBeenCalledTimes(2);
    expect(writeUnifiedSnapshotMock.mock.calls.map((call) => call[0]?.requestId)).toEqual([
      'req_queue_3',
      'req_queue_4'
    ]);
  });

  it('preserves oversized provider-request payload snapshots for explicit replay capture', async () => {
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
    process.env.ROUTECODEX_SNAPSHOT_PAYLOAD_MAX_BYTES = '1024';

    process.env.ROUTECODEX_SNAPSHOT_STAGES = 'provider-request';

    await writeProviderSnapshot({
      phase: 'provider-request',
      requestId: 'req_queue_summary_1',
      clientRequestId: 'req_queue_summary_1',
      providerKey: 'crs.key2.gpt-5.3-codex',
      entryEndpoint: '/v1/responses',
      entryPort: 5555,
      data: {
        model: 'gpt-5.3-codex',
        previous_response_id: 'resp_prev_turn',
        instructions: 'You are Codex. '.repeat(80),
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: '继续' }]
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: '先配置好路由器如何用 ssh 访问' }]
          }
        ],
        tools: Array.from({ length: 32 }, (_, idx) => ({
          type: 'function',
          name: `tool_${idx}`,
          description: 'd'.repeat(256)
        }))
      }
    });

    await __flushProviderSnapshotQueueForTests();

    expect(writeUnifiedSnapshotMock).toHaveBeenCalledTimes(1);
    const payload = writeUnifiedSnapshotMock.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(payload?.__snapshot_truncated).toBeUndefined();
    expect(payload).toMatchObject({
      meta: {
        stage: 'provider-request'
      },
      body: {
        model: 'gpt-5.3-codex',
        previous_response_id: 'resp_prev_turn'
      }
    });
    expect(((payload.body as Record<string, unknown>)?.instructions as string).length).toBeGreaterThan(1000);
    expect(Array.isArray((payload.body as Record<string, unknown>)?.tools)).toBe(true);
  });

  it('preserves full oversized provider-response payload for replayable protocol samples', async () => {
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
    process.env.ROUTECODEX_SNAPSHOT_PAYLOAD_MAX_BYTES = '1024';

    await writeProviderSnapshot({
      phase: 'provider-response',
      requestId: 'req_queue_full_response_1',
      clientRequestId: 'req_queue_full_response_1',
      providerKey: 'crs.key2.gpt-5.3-codex',
      entryEndpoint: '/v1/responses',
      entryPort: 5555,
      data: {
        mode: 'sse',
        raw: 'z'.repeat(20000),
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'OK' }]
          }
        ]
      }
    });

    await __flushProviderSnapshotQueueForTests();

    const payload = writeUnifiedSnapshotMock.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(payload?.__snapshot_truncated).toBeUndefined();
    expect(payload).toMatchObject({
      meta: {
        stage: 'provider-response'
      },
      body: {
        mode: 'sse',
        output: [
          {
            type: 'message',
            role: 'assistant'
          }
        ]
      }
    });
    expect(typeof (payload.body as Record<string, unknown>)?.raw).toBe('string');
    expect(((payload.body as Record<string, unknown>)?.raw as string).length).toBeGreaterThan(10000);
  });
});
