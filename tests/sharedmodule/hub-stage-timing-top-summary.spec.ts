import { describe, expect, it } from '@jest/globals';

import {
  clearHubStageTiming,
  logHubStageTiming,
  peekHubStageTopSummary
} from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing.js';

describe('hub stage timing top summary', () => {
  it('records and exposes top hub stages by elapsed ms', async () => {
    const requestId = 'req_hub_stage_top_summary';
    clearHubStageTiming(requestId);

    logHubStageTiming(requestId, 'req_inbound.stage2_semantic_map', 'completed', {
      elapsedMs: 18
    });
    logHubStageTiming(requestId, 'req_process.stage2_route_select', 'completed', {
      elapsedMs: 4
    });

    const top = peekHubStageTopSummary(requestId, {
      topN: 2,
      minMs: 0
    });
    expect(top).toHaveLength(2);
    expect(top[0].stage).toBe('req_inbound.stage2_semantic_map');
    expect(top[0].totalMs).toBeGreaterThanOrEqual(top[1].totalMs);

    clearHubStageTiming(requestId);
    expect(peekHubStageTopSummary(requestId, { topN: 2, minMs: 0 })).toHaveLength(0);
  });
});
