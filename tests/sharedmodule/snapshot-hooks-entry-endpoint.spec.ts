import { jest } from '@jest/globals';

const writeSnapshotViaHooksWithNativeMock = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-snapshot-hooks.js',
  () => ({
    shouldRecordSnapshotsWithNative: () => true,
    writeSnapshotViaHooksWithNative: writeSnapshotViaHooksWithNativeMock
  })
);

describe('snapshot-hooks entryEndpoint folder routing', () => {
  afterEach(() => {
    writeSnapshotViaHooksWithNativeMock.mockReset();
  });

  it('forwards entry protocol and port to native snapshot writer instead of deriving provider folders in TS', async () => {
    const { writeSnapshotViaHooks } = await import('../../sharedmodule/llmswitch-core/src/conversion/snapshot-utils.js');
    await writeSnapshotViaHooks({
      endpoint: '/v1/messages',
      stage: 'provider-request',
      requestId: 'req_1',
      groupRequestId: 'grp_1',
      providerKey: 'anthropic.test',
      entryPort: 5555,
      data: {
        meta: {
          entryEndpoint: '/v1/responses',
          groupRequestId: 'grp_1'
        },
        body: { ok: true }
      }
    });

    expect(writeSnapshotViaHooksWithNativeMock).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/v1/messages',
      stage: 'provider-request',
      requestId: 'req_1',
      groupRequestId: 'grp_1',
      providerKey: 'anthropic.test',
      entryPort: 5555
    }));
  });

  it('forwards runtime metadata so native runtime markers can separate continuation and stopless chains', async () => {
    const { writeSnapshotViaHooks } = await import('../../sharedmodule/llmswitch-core/src/conversion/snapshot-utils.js');
    await writeSnapshotViaHooks({
      endpoint: '/v1/responses',
      stage: 'provider-request',
      requestId: 'req_chain_truth',
      groupRequestId: 'grp_chain_truth',
      entryProtocol: 'openai-responses',
      entryPort: 5555,
      runtimeMetadata: {
        sessionId: 'sess-1',
        conversationId: 'conv-1',
        continuationOwner: 'relay',
        previousResponseId: 'resp_prev_1'
      },
      data: { body: { ok: true } }
    });

    expect(writeSnapshotViaHooksWithNativeMock).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'req_chain_truth',
      groupRequestId: 'grp_chain_truth',
      entryProtocol: 'openai-responses',
      entryPort: 5555,
      runtimeMetadata: expect.objectContaining({
        sessionId: 'sess-1',
        conversationId: 'conv-1',
        continuationOwner: 'relay',
        previousResponseId: 'resp_prev_1'
      })
    }));
  });
});
