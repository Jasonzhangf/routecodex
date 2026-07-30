/**
* Phase Server-E runtime live verification.
* Exercises the real NAPI help bridge end-to-end.
*/

import {
  describeServerContractsDirectNative,
  describeServerModuleHelpDirectNative,
} from './helpers/server-module-help-direct-native.js';

describe('server module help live NAPI verification (Phase Server-E)', () => {
  it('lists exactly 5 server modules with contract version 2026-06-03.server-module-help.v1', () => {
    const all = describeServerContractsDirectNative();
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
    const all = describeServerContractsDirectNative();
    const expected = ['metadata', 'metaCarrier', 'runtimeMetadata', 'errorCarrier', 'classifiedError', '__rt', 'snapshot'];
    for (const m of (all.modules ?? []) as Array<{ moduleId: string; forbiddenCarriers: string[] }>) {
      expect(m.forbiddenCarriers).toEqual(expected);
    }
  });

  it('describeServerModuleHelpDirectNative returns a single module envelope', () => {
    const one = describeServerModuleHelpDirectNative('server.direct_passthrough');
    expect(one).toMatchObject({
      contractVersion: '2026-06-03.server-module-help.v1',
      module: { moduleId: 'server.direct_passthrough' },
    });
  });

  it('describes the Rust-owned isolated 1s / sustained 5s provider action gate', () => {
    const one = describeServerModuleHelpDirectNative('server.error_action_queue');
    expect(one).toMatchObject({
      contractVersion: '2026-06-03.server-module-help.v1',
      module: {
        moduleId: 'server.error_action_queue',
        ownerBuilder: 'contract',
        effects: expect.arrayContaining([
          'record_error_action_backoff',
          'blocking_wait_isolated_1s_sustained_5s',
          'single_admission_fifo',
          'action_scope_owned_release',
        ]),
      },
    });
    expect(String(one.module?.help ?? '')).toContain('at least 1000ms');
    expect(String(one.module?.help ?? '')).toContain('at least 5000ms');
  });
});
