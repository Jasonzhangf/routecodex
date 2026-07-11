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
  '../../src/modules/llmswitch/bridge/native-exports.js',
  () => ({
    shouldRecordSnapshotsNative: () => true,
    writeSnapshotViaHooksNative: writeSnapshotViaHooksWithNativeMock,
    getRouterHotpathJsonBindingSync: () => ({
      normalizeSnapshotStagePayloadJson: (_stage: string, payloadJson: string) => payloadJson,
      buildSnapshotRecorderWriteOptionsJson: (inputJson: string) => JSON.stringify(
        buildSnapshotRecorderWriteOptionsWithNativeMock(JSON.parse(inputJson) as Record<string, unknown>),
      ),
    }),
    classifyEmptyResponseSignalNative: () => null,
    detectToolExecutionFailuresNative: () => [],
    classifyRuntimeErrorSignalNative: () => null,
    shouldLogClientToolErrorToConsoleNative: () => false,
    shouldLogRuntimeErrorSignalToConsoleNative: () => false,
    shouldWriteClientToolErrorsampleNative: () => true,
    resetSnapshotRecorderErrorsampleStateNative: () => undefined,
    shouldInspectRuntimeErrorFastNative: () => false,
    shouldInspectToolFailuresNative: () => false,
    resolveRequestTailSummaryNative: () => null,
    summarizeClientToolObservationNative: () => ({
      topLevelKeys: [],
      failureCount: 0,
      toolMessageCount: 0,
      failures: [],
      toolMessages: [],
    }),
  })
);

const { createSnapshotRecorder } = await import(
  '../../src/modules/llmswitch/bridge/snapshot-recorder.js'
);

describe('snapshot recorder native write option plan', () => {
  it('delegates entry protocol, entry port, group request, and runtime metadata projection to native', async () => {
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

    const recorder = await createSnapshotRecorder(context, '/v1/messages');
    recorder.record('req_inbound', { ok: true });

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
