/**
* Phase Server-E runtime live verification.
* Exercises the real NAPI help bridge end-to-end.
*/

import {
  describeServerContractsWithNative,
  describeServerModuleHelpWithNative
} from '../../sharedmodule/llmswitch-core/dist/native/router-hotpath/native-hub-vr-node-contracts.js';

describe('server module help live NAPI verification (Phase Server-E)', () => {
  it('lists exactly 5 server modules with contract version 2026-06-03.server-module-help.v1', () => {
    const all = describeServerContractsWithNative();
    expect(all).toMatchObject({
      contractVersion: '2026-06-03.server-module-help.v1',
    });
    const ids = (all.modules ?? []).map((m: { moduleId: string }) => m.moduleId);
    expect(ids).toEqual([
      'server.req_adapter',
      'server.direct_passthrough',
      'server.response_projection',
      'server.error_projection',
      'server.error_action_queue',
    ]);
  });

  it('each module forbids 7 internal carriers (metadata/metaCarrier/runtimeMetadata/errorCarrier/classifiedError/__rt/snapshot)', () => {
    const all = describeServerContractsWithNative();
    const expected = ['metadata', 'metaCarrier', 'runtimeMetadata', 'errorCarrier', 'classifiedError', '__rt', 'snapshot'];
    for (const m of (all.modules ?? []) as Array<{ moduleId: string; forbiddenCarriers: string[] }>) {
      expect(m.forbiddenCarriers).toEqual(expected);
    }
  });

  it('describeServerModuleHelpWithNative returns a single module envelope', () => {
    const one = describeServerModuleHelpWithNative('server.direct_passthrough');
    expect(one).toMatchObject({
      contractVersion: '2026-06-03.server-module-help.v1',
      module: { moduleId: 'server.direct_passthrough' },
    });
  });

  it('describes the unified error action queue policy', () => {
    const one = describeServerModuleHelpWithNative('server.error_action_queue');
    expect(one).toMatchObject({
      contractVersion: '2026-06-03.server-module-help.v1',
      module: {
        moduleId: 'server.error_action_queue',
        ownerBuilder: 'describeErrorActionQueueContract',
        effects: expect.arrayContaining([
          'record_error_action_backoff',
          'blocking_wait_1s_3s_5s_cycle',
        ]),
      },
    });
    expect(String(one.module?.help ?? '')).toContain('1s -> 3s -> 5s -> repeat');
  });
});
