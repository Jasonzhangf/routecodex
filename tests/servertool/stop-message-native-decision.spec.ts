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
  evaluateStopSchemaGateWithNative,
  type StopMessageDecisionContext,
  type StopMessageDecision
} from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-stop-message-auto-semantics.js';

function buildMinimalDecisionContext(args: {
  stopEligible: boolean;
  persistedDefaultExhausted?: boolean;
  defaultEnabled?: boolean;
  defaultMaxRepeats?: number;
  defaultText?: string;
}): StopMessageDecisionContext {
  return {
    port_stop_message_disabled: false,
    stop_eligible: args.stopEligible,
    has_responses_submit_tool_outputs_resume: false,
    persisted_snapshot: undefined,
    runtime_snapshot: undefined,
    persisted_default_exhausted: args.persistedDefaultExhausted ?? false,
    explicit_mode: undefined,
    plan_mode_active: false,
    default_enabled: args.defaultEnabled ?? true,
    default_max_repeats: args.defaultMaxRepeats ?? 3,
    default_text: args.defaultText ?? '继续执行',
    provider_pin: undefined,
  };
}

describe('stop-message native decision (blackbox)', () => {
  test('clean stop with default config → trigger', () => {
    const ctx = buildMinimalDecisionContext({
      stopEligible: true,
    });
    const decision: StopMessageDecision = decideStopMessageActionWithNative(ctx);
    expect(decision.action).toBe('trigger');
    expect(decision.followup_text).toBeTruthy();
  });

  test('chatprocess stop-gateway ineligible → skip', () => {
    const ctx = buildMinimalDecisionContext({
      stopEligible: false,
    });
    expect(decideStopMessageActionWithNative(ctx).action).toBe('skip');
  });

  test('default exhausted → skip', () => {
    const ctx = buildMinimalDecisionContext({
      stopEligible: true,
      persistedDefaultExhausted: true,
    });
    expect(decideStopMessageActionWithNative(ctx).action).toBe('skip');
  });

  test('plan mode active → skip', () => {
    const ctx: StopMessageDecisionContext = {
      ...buildMinimalDecisionContext({ stopEligible: true }),
      plan_mode_active: true,
    };
    const decision = decideStopMessageActionWithNative(ctx);
    expect(decision.action).toBe('skip');
    expect(decision.skip_reason).toBe('skip_plan_mode');
  });

  test('port disabled → skip', () => {
    const ctx: StopMessageDecisionContext = {
      ...buildMinimalDecisionContext({ stopEligible: true }),
      port_stop_message_disabled: true,
    };
    expect(decideStopMessageActionWithNative(ctx).action).toBe('skip');
  });

  test('persisted snapshot with used=0 → trigger', () => {
    const ctx: StopMessageDecisionContext = {
      ...buildMinimalDecisionContext({ stopEligible: true }),
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
      ...buildMinimalDecisionContext({ stopEligible: true }),
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
      ...buildMinimalDecisionContext({ stopEligible: true }),
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

  test('submit_tool_outputs resume remains eligible for stopless continuation', () => {
    const ctx: StopMessageDecisionContext = {
      ...buildMinimalDecisionContext({ stopEligible: true }),
      has_responses_submit_tool_outputs_resume: true,
      persisted_snapshot: {
        text: '继续执行',
        max_repeats: 3,
        used: 1,
        source: 'persisted',
        stage_mode: 'on',
      },
    };
    const decision = decideStopMessageActionWithNative(ctx);
    expect(decision.action).toBe('trigger');
    expect(decision.skip_reason ?? undefined).toBeUndefined();
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
    expect(gate.followup_text).toContain('继续做下一步');
    expect(gate.followup_text).toContain('Stop schema 校验未通过');
    expect(gate.followup_text).toContain('stopreason');
    expect(gate.followup_text).toContain('reason');
    expect(gate.followup_text).toContain('evidence');
    expect(gate.followup_text).not.toContain('每个字段都要写具体内容');
    expect(gate.missing_fields).toEqual(['stopreason']);
  });

  test('malformed schema returns parse feedback and explicit field guidance', () => {
    const gate = evaluateStopSchemaGateWithNative({
      assistantText: '<rcc_stop_schema>{bad json}</rcc_stop_schema>',
      used: 0,
      maxRepeats: 3,
    });
    expect(gate.action).toBe('followup');
    expect(gate.reason_code).toBe('stop_schema_invalid_json');
    expect(gate.count_budget).toBe(true);
    expect(gate.followup_text).toContain('<rcc_stop_schema>');
  });

  test('unterminated json fence is treated as invalid schema instead of missing schema', () => {
    const gate = evaluateStopSchemaGateWithNative({
      assistantText: '```json\n{"stopreason":2,"reason":"继续"}',
      used: 0,
      maxRepeats: 3,
    });
    expect(gate.action).toBe('followup');
    expect(gate.reason_code).toBe('stop_schema_invalid_json');
    expect(gate.count_budget).toBe(true);
  });

  test('stop schema gate exhausts repeated missing schema loop', () => {
    const first = evaluateStopSchemaGateWithNative({
      assistantText: '还是无法继续，工具被拒绝。',
      used: 0,
      maxRepeats: 3,
    });
    expect(first.action).toBe('followup');
    expect(first.reason_code).toBe('stop_schema_missing');
    expect(first.no_change_count).toBe(1);

    const second = evaluateStopSchemaGateWithNative({
      assistantText: '还是无法继续，工具被拒绝。',
      used: 0,
      maxRepeats: 3,
      prevObservationHash: first.observation_hash,
      prevNoChangeCount: first.no_change_count,
    });
    expect(second.action).toBe('followup');
    expect(second.reason_code).toBe('stop_schema_missing');
    expect(second.no_change_count).toBe(2);

    const gate = evaluateStopSchemaGateWithNative({
      assistantText: '还是无法继续，工具被拒绝。',
      used: 0,
      maxRepeats: 3,
      prevObservationHash: second.observation_hash,
      prevNoChangeCount: second.no_change_count,
    });
    expect(gate.action).toBe('fail_fast');
    expect(gate.reason_code).toBe('stop_schema_budget_exhausted');
    expect(gate.count_budget).toBe(true);
    expect(gate.no_change_count).toBe(3);
  });

  test('stopless budget does not reset when provider switches inside the same term', () => {
    const decision = decideStopMessageActionWithNative({
      ...buildMinimalDecisionContext({
        stopEligible: true,
      }),
      persisted_snapshot: {
        text: '继续执行',
        max_repeats: 3,
        used: 3,
        source: 'persisted',
        stage_mode: 'on',
        provider_key: 'minimax.key1',
      },
      provider_pin: {
        provider_key: 'orangeai.key1',
        model_id: 'glm-5.2',
        routecodex_port_mode: 'tools',
      },
    });
    expect(decision.action).toBe('skip');
    expect(decision.skip_reason).toBe('skip_reached_max_repeats');
  });

  test('stop schema gate allows blocked with reason only', () => {
    const shallow = evaluateStopSchemaGateWithNative({
      assistantText:
        '<rcc_stop_schema>{"stopreason":1,"reason":"工具权限被客户端拒绝，无法继续读取文件。","has_evidence":0,"evidence":"","next_step":""}</rcc_stop_schema>',
      used: 0,
      maxRepeats: 3,
    });
    expect(shallow.action).toBe('allow_stop');
    expect(shallow.reason_code).toBe('stop_schema_blocked');
    expect(shallow.count_budget).toBe(false);
    expect(shallow.missing_fields).toEqual([]);

    const gate = evaluateStopSchemaGateWithNative({
      assistantText:
        '<rcc_stop_schema>{"stopreason":1,"reason":"工具权限被客户端拒绝，无法继续读取文件。","has_evidence":1,"evidence":"exec_command rejected","issue_cause":"客户端拒绝工具权限","excluded_factors":"非模型输出格式问题","diagnostic_order":"工具调用 -> 拒绝日志 -> 阻塞判定","done_steps":"确认工具权限被拒","next_step":"","next_suggested_path":"","needs_user_input":false,"learned":"需要先确认工具权限"}</rcc_stop_schema>',
      used: 5,
      maxRepeats: 3,
    });
    expect(gate.action).toBe('allow_stop');
    expect(gate.reason_code).toBe('stop_schema_blocked');
    expect(gate.count_budget).toBe(false);
  });

  test('valid terminal reasoningStop arguments allow stop without requiring prior explicit hook call', () => {
    const gate = evaluateStopSchemaGateWithNative({
      assistantText: '',
      reasoningStopArguments:
        '{"stopreason":0,"reason":"任务完成","has_evidence":1,"evidence":"live probe ok","issue_cause":"none","excluded_factors":"none","diagnostic_order":"check->verify","done_steps":"done","next_step":"","next_suggested_path":"","needs_user_input":false,"learned":"summary ready"}',
      used: 0,
      maxRepeats: 3,
    });
    expect(gate.action).toBe('allow_stop');
    expect(gate.reason_code).toBe('stop_schema_finished');
    expect(gate.count_budget).toBe(false);
    expect(gate.followup_text ?? undefined).toBeUndefined();
    expect(gate.parsed).toMatchObject({
      stopreason: 0,
      reason: '任务完成',
      learned: 'summary ready',
    });
  });

  test('default stopless followup prompt starts with goal and evidence check', () => {
    const decision = decideStopMessageActionWithNative(buildMinimalDecisionContext({
      stopEligible: true,
    }));
    expect(decision.action).toBe('trigger');
    expect(decision.followup_text).toContain('继续当前用户目标');
    expect(decision.followup_text).toContain('继续做下一步');
    expect(decision.followup_text).toContain('Stop schema 校验未通过');
    expect(decision.followup_text).toContain('evidence');
    expect(decision.followup_text).toContain('stopreason');
  });

  test('last default stopless followup asks for final user-facing summary only', () => {
    const decision = decideStopMessageActionWithNative({
      ...buildMinimalDecisionContext({
        stopEligible: true,
      }),
      persisted_snapshot: {
        text: '继续执行',
        max_repeats: 3,
        used: 2,
        source: 'persisted',
        stage_mode: 'on'
      }
    });
    expect(decision.action).toBe('trigger');
    expect(decision.followup_text).toContain('最终收尾 schema 缺失');
    expect(decision.followup_text).toContain('用户可读 summary');
    expect(decision.followup_text).toContain('不要复述 stopless/校验过程');
    expect(decision.followup_text).not.toContain('继续做下一步');
  });

  test('default snapshot uses heuristic prompt instead of fixed configured text', () => {
    const decision = decideStopMessageActionWithNative({
      ...buildMinimalDecisionContext({
        stopEligible: true,
        defaultText: '继续完成当前用户目标。若仍需操作、检查或验证，必须调用可用工具继续执行；不要只总结。'
      }),
      persisted_snapshot: {
        text: '继续完成当前用户目标。若仍需操作、检查或验证，必须调用可用工具继续执行；不要只总结。',
        max_repeats: 3,
        used: 1,
        source: 'default',
        stage_mode: 'on'
      }
    });
    expect(decision.action).toBe('trigger');
    expect(decision.followup_text).toContain('继续当前用户目标');
    expect(decision.followup_text).toContain('Stop schema 校验未通过');
    expect(decision.followup_text).toContain('issue_cause');
    expect(decision.followup_text).toContain('excluded_factors');
    expect(decision.followup_text).toContain('diagnostic_order');
    expect(decision.followup_text).not.toBe('继续完成当前用户目标。若仍需操作、检查或验证，必须调用可用工具继续执行；不要只总结。');
  });

  test('stop schema gate exhausts only invalid schema budget', () => {
    const invalid1 = evaluateStopSchemaGateWithNative({
      assistantText: '<rcc_stop_schema>{bad json}</rcc_stop_schema>',
      used: 0,
      maxRepeats: 3,
    });
    expect(invalid1.action).toBe('followup');
    const invalid2 = evaluateStopSchemaGateWithNative({
      assistantText: '<rcc_stop_schema>{bad json}</rcc_stop_schema>',
      used: 0,
      maxRepeats: 3,
      prevObservationHash: invalid1.observation_hash,
      prevNoChangeCount: invalid1.no_change_count,
    });
    expect(invalid2.action).toBe('followup');
    const invalid3 = evaluateStopSchemaGateWithNative({
      assistantText: '<rcc_stop_schema>{bad json}</rcc_stop_schema>',
      used: 0,
      maxRepeats: 3,
      prevObservationHash: invalid2.observation_hash,
      prevNoChangeCount: invalid2.no_change_count,
    });
    expect(invalid3.action).toBe('fail_fast');
    expect(invalid3.reason_code).toBe('stop_schema_budget_exhausted');
    expect(invalid3.count_budget).toBe(true);

    const valid = evaluateStopSchemaGateWithNative({
      assistantText:
        '<rcc_stop_schema>{"stopreason":0,"reason":"测试通过","has_evidence":1,"evidence":"cargo test green","issue_cause":"实现满足 contract","excluded_factors":"无关配置未参与","diagnostic_order":"单测 -> gate","done_steps":"补齐 Rust gate","next_step":"","next_suggested_path":"","needs_user_input":false,"learned":"gate green"}</rcc_stop_schema>',
      used: 3,
      maxRepeats: 3,
    });
    expect(valid.action).toBe('allow_stop');
    expect(valid.reason_code).toBe('stop_schema_finished');
    expect(valid.count_budget).toBe(false);
  });

});
