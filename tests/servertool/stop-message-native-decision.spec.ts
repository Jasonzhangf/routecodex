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
    stop_message_followup_policy: undefined,
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

  test('stop_message followup flow with not eligible uses normal stop eligibility skip', () => {
    const ctx: StopMessageDecisionContext = {
      ...buildMinimalDecisionContext({ stopEligible: false, finishReasons: ['stop'] }),
      followup_flow_id: 'stop_message_flow',
      stop_message_followup_policy: 'preserve_eligibility',
    };
    const decision = decideStopMessageActionWithNative(ctx);
    expect(decision.action).toBe('skip');
    expect(decision.skip_reason).toBe('skip_not_stop_finish_reason');
  });

  test('non-stop_message followup flow skips as generic followup hop', () => {
    const ctx: StopMessageDecisionContext = {
      ...buildMinimalDecisionContext({ stopEligible: true, finishReasons: ['stop'] }),
      followup_flow_id: 'apply_patch_flow',
      stop_message_followup_policy: 'disable',
    };
    const decision = decideStopMessageActionWithNative(ctx);
    expect(decision.action).toBe('skip');
    expect(decision.skip_reason).toContain('servertool_followup');
  });
});
