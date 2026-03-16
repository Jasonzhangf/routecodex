import { jest } from '@jest/globals';

const importCoreDistMock = jest.fn();

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/module-loader.js', () => ({
  importCoreDist: importCoreDistMock
}));

describe('llmswitch bridge runtime-integrations snapshot hooks', () => {
  beforeEach(() => {
    importCoreDistMock.mockReset();
  });

  test('writeSnapshotViaHooks loads conversion/snapshot-utils and forwards payload', async () => {
    const writer = jest.fn();
    importCoreDistMock.mockResolvedValue({
      writeSnapshotViaHooks: writer
    });

    const mod = await import('../../../../src/modules/llmswitch/bridge/runtime-integrations.js');
    await mod.writeSnapshotViaHooks({
      endpoint: '/v1/responses',
      stage: 'provider-request',
      requestId: 'req_snapshot_1',
      data: { ok: true }
    });

    expect(importCoreDistMock).toHaveBeenCalledWith('conversion/snapshot-utils');
    expect(writer).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: '/v1/responses',
        stage: 'provider-request',
        requestId: 'req_snapshot_1',
        data: { ok: true }
      })
    );
  });
});
