import { describe, expect, it, jest } from '@jest/globals';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const buildSnapshotRecorderWriteOptionsWithNativeMock = jest.fn((input: Record<string, unknown>) => ({
  endpoint: input.endpoint,
  stage: input.stage,
  requestId: input.requestId,
  data: input.data,
  verbosity: 'verbose',
  providerKey: input.providerKey,
  entryProtocol: 'anthropic-messages',
  entryPort: 5555,
  groupRequestId: 'client_req_1',
  runtimeMetadata: { runtime: 'meta' },
}));
const writeSnapshotViaHooksWithNativeMock = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-snapshot-hooks.js',
  () => ({
    shouldRecordSnapshotsWithNative: () => true,
    normalizeSnapshotStagePayloadWithNative: (_stage: string, payload: unknown) => payload,
    buildSnapshotRecorderWriteOptionsWithNative: buildSnapshotRecorderWriteOptionsWithNativeMock,
    writeSnapshotViaHooksWithNative: writeSnapshotViaHooksWithNativeMock,
  })
);

const { createSnapshotRecorder } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/snapshot-recorder.js'
);

describe('snapshot recorder native write option plan', () => {
  it('delegates entry protocol, entry port, group request, and runtime metadata projection to native', () => {
    const context: Record<string, unknown> = {
      requestId: 'req_snapshot_recorder',
      providerId: 'provider.key1',
      clientRequestId: 'client_req_1',
      metadata: { runtime: 'meta' },
    };
    const center = MetadataCenter.attach(context);
    center.writeRequestTruth(
      'portScope',
      '5555',
      {
        module: 'tests/sharedmodule/snapshot-recorder-native-plan.spec.ts',
        symbol: 'delegates snapshot recorder plan to native',
        stage: 'test',
      },
      'test port scope'
    );

    createSnapshotRecorder(context as never, '/v1/messages').record('req_inbound', { ok: true });

    expect(buildSnapshotRecorderWriteOptionsWithNativeMock).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/v1/messages',
      stage: 'req_inbound',
      requestId: 'req_snapshot_recorder',
      providerKey: 'provider.key1',
      context: expect.objectContaining({
        clientRequestId: 'client_req_1',
      }),
      metadataCenterSnapshot: expect.objectContaining({
        requestTruth: expect.objectContaining({
          portScope: '5555',
        }),
      }),
    }));
    expect(writeSnapshotViaHooksWithNativeMock).toHaveBeenCalledWith(expect.objectContaining({
      entryProtocol: 'anthropic-messages',
      entryPort: 5555,
      groupRequestId: 'client_req_1',
      runtimeMetadata: { runtime: 'meta' },
    }));
  });
});
