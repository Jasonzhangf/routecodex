/**
 * Black-box test: exercises the TS→Rust serialization boundary for stop-message decision.
 *
 * Does NOT mock the native decision — calls real `decideStopMessageActionWithNative`.
 * This catches serde rename mismatch, JSON shape drift, and serialization contract breaks.
 *
 * MUST remain in the CI regression list (ci-jest.mjs).
 */

import { describe, test, expect } from '@jest/globals';
import {
  decideStopMessageActionWithNative,
  evaluateGoalActiveStopLoopGuardWithNative,
  evaluateStopSchemaGateWithNative,
  type StopMessageDecisionContext,
  type StopMessageDecision
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-stop-message-auto-semantics.js';

function buildMinimalDecisionContext(args: {
  stopEligible: boolean;
  finishReasons?: string[];
  persistedDefaultExhausted?: boolean;
  defaultEnabled?: boolean;
  defaultMaxRepeats?: number;
  defaultText?: string;
}): StopMessageDecisionContext {
  return {
    port_stop_message_disabled: false,
    followup_flow_id: undefined,
    stop_eligible: args.stopEligible,
    finish_reasons: args.finishReasons ?? [],
    has_responses_submit_tool_outputs_resume: false,
    persisted_snapshot: undefined,
    runtime_snapshot: undefined,
    persisted_default_exhausted: args.persistedDefaultExhausted ?? false,
    explicit_mode: undefined,
    goal_status: 'idle',
    plan_mode_active: false,
    default_enabled: args.defaultEnabled ?? true,
    default_max_repeats: args.defaultMaxRepeats ?? 3,
    default_text: args.defaultText ?? '继续执行',
    empty_reply_continue_local: false,
    provider_pin: undefined,
  };
}

describe('stop-message native decision (blackbox)', () => {
  test('clean stop with default config → trigger', () => {
    const ctx = buildMinimalDecisionContext({
      stopEligible: true,
      finishReasons: ['stop'],
    });
    const decision: StopMessageDecision = decideStopMessageActionWithNative(ctx);
    expect(decision.action).toBe('trigger');
    expect(decision.followup_text).toBeTruthy();
  });

  test('non-stop finish_reason → skip', () => {
    const ctx = buildMinimalDecisionContext({
      stopEligible: false,
      finishReasons: ['length'],
    });
    expect(decideStopMessageActionWithNative(ctx).action).toBe('skip');
  });

  test('default exhausted → skip', () => {
    const ctx = buildMinimalDecisionContext({
      stopEligible: true,
      finishReasons: ['stop'],
      persistedDefaultExhausted: true,
    });
    expect(decideStopMessageActionWithNative(ctx).action).toBe('skip');
  });

  test('goal active → skip', () => {
    const ctx: StopMessageDecisionContext = {
      ...buildMinimalDecisionContext({ stopEligible: true, finishReasons: ['stop'] }),
      goal_status: 'active',
    };
    expect(decideStopMessageActionWithNative(ctx).action).toBe('skip');
  });

  test.each(['idle', 'paused', 'stopped', 'completed'] as const)(
    'goal status %s does not skip clean stop',
    (goalStatus) => {
      const ctx: StopMessageDecisionContext = {
        ...buildMinimalDecisionContext({ stopEligible: true, finishReasons: ['stop'] }),
        goal_status: goalStatus,
      };
      const decision = decideStopMessageActionWithNative(ctx);
      expect(decision.action).toBe('trigger');
      expect(decision.followup_text).toBeTruthy();
    }
  );

  test('plan mode active → skip', () => {
    const ctx: StopMessageDecisionContext = {
      ...buildMinimalDecisionContext({ stopEligible: true, finishReasons: ['stop'] }),
      plan_mode_active: true,
    };
    const decision = decideStopMessageActionWithNative(ctx);
    expect(decision.action).toBe('skip');
    expect(decision.skip_reason).toBe('skip_plan_mode');
  });

  test('port disabled → skip', () => {
    const ctx: StopMessageDecisionContext = {
      ...buildMinimalDecisionContext({ stopEligible: true, finishReasons: ['stop'] }),
      port_stop_message_disabled: true,
    };
    expect(decideStopMessageActionWithNative(ctx).action).toBe('skip');
  });

  test('persisted snapshot with used=0 → trigger', () => {
    const ctx: StopMessageDecisionContext = {
      ...buildMinimalDecisionContext({ stopEligible: true, finishReasons: ['stop'] }),
      persisted_snapshot: {
        text: '继续执行',
        max_repeats: 3,
        used: 0,
        source: 'persisted',
        stage_mode: 'on',
      },
    };
    expect(decideStopMessageActionWithNative(ctx).action).toBe('trigger');
  });

  test('persisted snapshot used >= max_repeats → skip', () => {
    const ctx: StopMessageDecisionContext = {
      ...buildMinimalDecisionContext({ stopEligible: true, finishReasons: ['stop'] }),
      persisted_snapshot: {
        text: '继续执行',
        max_repeats: 3,
        used: 3,
        source: 'persisted',
        stage_mode: 'on',
      },
    };
    expect(decideStopMessageActionWithNative(ctx).action).toBe('skip');
  });

  test('stage_mode off → skip', () => {
    const ctx: StopMessageDecisionContext = {
      ...buildMinimalDecisionContext({ stopEligible: true, finishReasons: ['stop'] }),
      persisted_snapshot: {
        text: '继续执行',
        max_repeats: 3,
        used: 0,
        source: 'persisted',
        stage_mode: 'off',
      },
    };
    expect(decideStopMessageActionWithNative(ctx).action).toBe('skip');
  });

  test('stop_message followup flow remains eligible for bounded continuation', () => {
    const ctx: StopMessageDecisionContext = {
      ...buildMinimalDecisionContext({ stopEligible: true, finishReasons: ['stop'] }),
      followup_flow_id: 'stop_message_flow',
    };
    const decision = decideStopMessageActionWithNative(ctx);
    expect(decision.action).toBe('trigger');
    expect(decision.skip_reason ?? undefined).toBeUndefined();
  });

  test('non-stop_message followup flow skips as generic followup hop', () => {
    const ctx: StopMessageDecisionContext = {
      ...buildMinimalDecisionContext({ stopEligible: true, finishReasons: ['stop'] }),
      followup_flow_id: 'apply_patch_flow',
    };
    const decision = decideStopMessageActionWithNative(ctx);
    expect(decision.action).toBe('skip');
    expect(decision.skip_reason).toContain('servertool_followup');
  });

  test('stop schema gate counts missing schema as schema error budget', () => {
    const gate = evaluateStopSchemaGateWithNative({
      assistantText: '未完成。继续处理 DNS。',
      used: 0,
      maxRepeats: 3,
    });
    expect(gate.action).toBe('followup');
    expect(gate.reason_code).toBe('stop_schema_missing');
    expect(gate.count_budget).toBe(true);
    expect(gate.followup_text).not.toContain('质询');
    expect(gate.followup_text).toContain('问题原因');
    expect(gate.followup_text).toContain('已排除因素');
    expect(gate.followup_text).toContain('排查顺序');
    expect(gate.followup_text).toContain('issue_cause');
    expect(gate.followup_text).toContain('excluded_factors');
    expect(gate.followup_text).toContain('diagnostic_order');
  });

  test('stop schema gate exhausts repeated missing schema loop', () => {
    const beforeLimit = evaluateStopSchemaGateWithNative({
      assistantText: '还是无法继续，工具被拒绝。',
      used: 2,
      maxRepeats: 3,
    });
    expect(beforeLimit.action).toBe('followup');
    expect(beforeLimit.reason_code).toBe('stop_schema_missing');

    const gate = evaluateStopSchemaGateWithNative({
      assistantText: '还是无法继续，工具被拒绝。',
      used: 3,
      maxRepeats: 3,
    });
    expect(gate.action).toBe('fail_fast');
    expect(gate.reason_code).toBe('stop_schema_budget_exhausted');
    expect(gate.count_budget).toBe(true);
  });

  test('stop schema gate allows blocked string stopreason', () => {
    const gate = evaluateStopSchemaGateWithNative({
      assistantText: '{"stopreason":"blocked","reason":"工具权限被客户端拒绝，无法继续读取文件。","has_evidence":"0","evidence":"","next_step":""}',
      used: 5,
      maxRepeats: 3,
    });
    expect(gate.action).toBe('allow_stop');
    expect(gate.reason_code).toBe('stop_schema_blocked');
    expect(gate.count_budget).toBe(false);
  });

  test('default stopless followup prompt asks for cause exclusions and diagnostic order', () => {
    const decision = decideStopMessageActionWithNative(buildMinimalDecisionContext({
      stopEligible: true,
      finishReasons: ['stop'],
    }));
    expect(decision.action).toBe('trigger');
    expect(decision.followup_text).toContain('当前用户目标是什么');
    expect(decision.followup_text).toContain('建议下一步是什么');
  });

  test('stop schema gate exhausts only invalid schema budget', () => {
    const invalid = evaluateStopSchemaGateWithNative({
      assistantText: '{"stopreason":2,"reason":"未完成","has_evidence":0,"next_step":"运行测试"}',
      used: 5,
      maxRepeats: 3,
    });
    expect(invalid.action).toBe('fail_fast');
    expect(invalid.reason_code).toBe('stop_schema_budget_exhausted');
    expect(invalid.count_budget).toBe(true);

    const valid = evaluateStopSchemaGateWithNative({
      assistantText: '{"stopreason":0,"reason":"测试通过","has_evidence":1,"evidence":"cargo test green","next_step":""}',
      used: 3,
      maxRepeats: 3,
    });
    expect(valid.action).toBe('allow_stop');
    expect(valid.reason_code).toBe('stop_schema_finished');
    expect(valid.count_budget).toBe(false);
  });

  test('goal active repeated text stop loop is detected without enabling stopless', () => {
    const decision = evaluateGoalActiveStopLoopGuardWithNative({
      threshold: 3,
      assistantText: '立刻跑全测试 + 远端验证。',
      capturedRequest: {
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: '<codex_internal_context source="goal">\nContinue working toward the active thread goal.\n<objective>完成测试验证</objective>'
              }
            ]
          },
          { role: 'assistant', content: [{ type: 'output_text', text: '立刻跑全测试 + 远端验证。' }] },
          { role: 'assistant', content: [{ type: 'output_text', text: '立刻跑全测试 + 远端验证。' }] }
        ]
      }
    });

    expect(decision.loopDetected).toBe(true);
    expect(decision.repeatCount).toBe(3);
    expect(decision.reasonCode).toBe('goal_active_repeated_stop');
  });
});
