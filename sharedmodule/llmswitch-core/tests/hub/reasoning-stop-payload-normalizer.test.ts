import { describe, expect, test } from '@jest/globals';

import { normalizeReasoningStopPayload } from '../../src/servertool/handlers/reasoning-stop-payload-normalizer.js';

describe('normalizeReasoningStopPayload', () => {
  test('accepts completed analysis stop when ssot_assessment arrives as parameter tuple', () => {
    const result = normalizeReasoningStopPayload({
      task_goal: '审计 provider 相关代码',
      is_completed: true,
      stop_reason: 'plan_mode',
      completion_evidence: '五个区域已全部核查',
      ssot_assessment: {
        parameter: [
          'analysis_only',
          '这是只读审计任务，交付物已完整提供，因此 analysis_only + rationale 足以构成唯一真源说明。'
        ]
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.payload.completed).toBe(true);
    expect(result.payload.stopReason).toBe('plan_mode');
    expect(result.payload.ssotAssessment).toEqual({
      workType: 'analysis_only',
      rationale: '这是只读审计任务，交付物已完整提供，因此 analysis_only + rationale 足以构成唯一真源说明。'
    });
  });
});
