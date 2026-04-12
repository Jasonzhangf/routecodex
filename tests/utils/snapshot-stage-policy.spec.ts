import { describe, expect, it } from '@jest/globals';

import {
  getDefaultSnapshotStageSelector,
  shouldCaptureSnapshotStage,
  stageSelectorNeedsHubSnapshots
} from '../../src/utils/snapshot-stage-policy.js';

describe('snapshot-stage-policy', () => {
  it('uses provider+request default when selector is empty', () => {
    const prev = process.env.ROUTECODEX_SNAPSHOT_STAGES;
    delete process.env.ROUTECODEX_SNAPSHOT_STAGES;
    try {
      expect(getDefaultSnapshotStageSelector()).toBe('provider-request,provider-response');
      expect(shouldCaptureSnapshotStage('client-request')).toBe(false);
      expect(shouldCaptureSnapshotStage('provider-request')).toBe(true);
      expect(shouldCaptureSnapshotStage('provider-response')).toBe(true);
      expect(shouldCaptureSnapshotStage('provider-error')).toBe(false);
      expect(shouldCaptureSnapshotStage('provider-request.retry')).toBe(false);
      expect(shouldCaptureSnapshotStage('chat_process.req.stage2.semantic_map')).toBe(false);
      expect(shouldCaptureSnapshotStage('client-response')).toBe(false);
    } finally {
      if (prev === undefined) {
        delete process.env.ROUTECODEX_SNAPSHOT_STAGES;
      } else {
        process.env.ROUTECODEX_SNAPSHOT_STAGES = prev;
      }
    }
  });

  it('supports wildcard prefix and detects hub-stage requirement', () => {
    const prev = process.env.ROUTECODEX_SNAPSHOT_STAGES;
    process.env.ROUTECODEX_SNAPSHOT_STAGES = 'provider-*,chat_process.req.*';
    try {
      expect(shouldCaptureSnapshotStage('provider-body-debug')).toBe(true);
      expect(shouldCaptureSnapshotStage('chat_process.req.stage2.semantic_map')).toBe(true);
      expect(stageSelectorNeedsHubSnapshots('provider-*,chat_process.req.*')).toBe(true);
      expect(stageSelectorNeedsHubSnapshots('client-request,provider-request')).toBe(false);
    } finally {
      if (prev === undefined) {
        delete process.env.ROUTECODEX_SNAPSHOT_STAGES;
      } else {
        process.env.ROUTECODEX_SNAPSHOT_STAGES = prev;
      }
    }
  });
});
