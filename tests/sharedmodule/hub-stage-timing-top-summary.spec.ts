import { describe, expect, it } from '@jest/globals';

import {
  clearHubStageTiming,
  measureHubStage,
  peekHubStageTopSummary
} from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing.js';

describe('hub stage timing top summary', () => {
  it('records and exposes top hub stages by elapsed ms', async () => {
    const requestId = 'req_hub_stage_top_summary';
    clearHubStageTiming(requestId);

    await measureHubStage(requestId, 'req_inbound.stage2_semantic_map', async () => {
      await new Promise((resolve) => setTimeout(resolve, 18));
      return true;
    });
    await measureHubStage(requestId, 'req_process.stage2_route_select', async () => {
      await new Promise((resolve) => setTimeout(resolve, 4));
      return true;
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
