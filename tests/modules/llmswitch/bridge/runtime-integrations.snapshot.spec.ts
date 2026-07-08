import { beforeEach, describe, expect, test, jest } from '@jest/globals';

describe('llmswitch bridge runtime-integrations snapshot hooks', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('writeSnapshotViaHooks forwards payload to native snapshot hooks', async () => {
    const writer = jest.fn();
    jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/native-exports.js', () => ({
      writeSnapshotViaHooksNative: writer,
      shouldRecordSnapshotsNative: jest.fn(() => true),
      getRouterHotpathJsonBindingSync: jest.fn(() => ({})),
    }));

    const mod = await import('../../../../src/modules/llmswitch/bridge/runtime-integrations.js');
    await mod.writeSnapshotViaHooks({
      endpoint: '/v1/responses',
      stage: 'provider-request',
      requestId: 'req_snapshot_1',
      data: { ok: true }
    });

    expect(writer).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: '/v1/responses',
        stage: 'provider-request',
        requestId: 'req_snapshot_1',
        data: { ok: true }
      })
    );
  });

  test('RED: writeSnapshotViaHooks forwards providerKey and groupRequestId so --snap requests do not stay anonymous pending forever', async () => {
    const writer = jest.fn();
    jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/native-exports.js', () => ({
      writeSnapshotViaHooksNative: writer,
      shouldRecordSnapshotsNative: jest.fn(() => true),
      getRouterHotpathJsonBindingSync: jest.fn(() => ({})),
    }));

    const mod = await import('../../../../src/modules/llmswitch/bridge/runtime-integrations.js');
    await mod.writeSnapshotViaHooks({
      endpoint: '/v1/responses',
      stage: 'provider-response',
      requestId: 'req_snapshot_pending_finalize_1',
      providerKey: 'openai.key4.gpt-5.3-codex',
      groupRequestId: 'openai-responses-openai.key4-gpt-5.3-codex-20260522T160620130-221799-483',
      data: { ok: true }
    });

    expect(writer).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: '/v1/responses',
        stage: 'provider-response',
        requestId: 'req_snapshot_pending_finalize_1',
        providerKey: 'openai.key4.gpt-5.3-codex',
        groupRequestId: 'openai-responses-openai.key4-gpt-5.3-codex-20260522T160620130-221799-483',
        data: { ok: true }
      })
    );
  });
});
