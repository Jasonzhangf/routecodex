import { describe, expect, test } from '@jest/globals';
import { evaluateStopSchemaGateWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-stop-message-auto-semantics.js';

describe('stop schema lifecycle contract', () => {
  test('missing schema enters followup contract and counts loop-guard budget', () => {
    const gate = evaluateStopSchemaGateWithNative({
      assistantText: '我想停一下，但还没给结构化 schema。',
      used: 0,
      maxRepeats: 3,
    });
    expect(gate.action).toBe('followup');
    expect(gate.reason_code).toBe('stop_schema_missing');
    expect(gate.count_budget).toBe(true);
    expect(gate.followup_text).toContain('stop schema');
    expect(gate.followup_text).toContain('exec_command');
  });

  test('reasoningStop arguments allow terminal stop', () => {
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
    expect(gate.parsed).toMatchObject({
      stopreason: 0,
      reason: '任务完成',
      learned: 'summary ready',
    });
  });

  test('simple_question true allows natural stop without stopreason', () => {
    const gate = evaluateStopSchemaGateWithNative({
      assistantText: '',
      reasoningStopArguments: '{"simple_question":true}',
      used: 0,
      maxRepeats: 3,
    });
    expect(gate.action).toBe('allow_stop');
    expect(gate.reason_code).toBe('stop_schema_simple_question');
    expect(gate.count_budget).toBe(false);
    expect(gate.missing_fields).toEqual([]);
    expect(gate.parsed).toMatchObject({
      simple_question: true,
    });
  });

  test('simple_question true overrides other stop schema fields', () => {
    const gate = evaluateStopSchemaGateWithNative({
      assistantText: '',
      reasoningStopArguments: '{"simple_question":true,"stopreason":"unknown"}',
      used: 0,
      maxRepeats: 3,
    });
    expect(gate.action).toBe('allow_stop');
    expect(gate.reason_code).toBe('stop_schema_simple_question');
    expect(gate.missing_fields).toEqual([]);
  });

  test('simple_question false still requires stopreason', () => {
    const gate = evaluateStopSchemaGateWithNative({
      assistantText: '',
      reasoningStopArguments: '{"simple_question":false}',
      used: 0,
      maxRepeats: 3,
    });
    expect(gate.action).toBe('followup');
    expect(gate.reason_code).toBe('stop_schema_stopreason_missing_or_non_numeric');
    expect(gate.missing_fields).toContain('stopreason');
  });

  test('fenced non-terminal schema follows up with schema-aware guidance', () => {
    const gate = evaluateStopSchemaGateWithNative({
      assistantText:
        '<rcc_stop_schema>{"stopreason":2,"reason":"未完成","has_evidence":1,"evidence":"partial logs","issue_cause":"need more verification","excluded_factors":"syntax fixed","diagnostic_order":"read->run","done_steps":"checked logs","next_step":"rerun failing command","next_suggested_path":"","needs_user_input":false,"learned":""}</rcc_stop_schema>',
      used: 0,
      maxRepeats: 3,
    });
    expect(gate.action).toBe('followup');
    expect(gate.reason_code).toBe('stop_schema_continue_next_step');
    expect(gate.count_budget).toBe(false);
    expect(gate.parsed).toMatchObject({
      stopreason: 2,
      next_step: 'rerun failing command',
    });
    expect(gate.followup_text).toContain('rerun failing command');
  });

  test('json code fence stop schema is harvested as the same stop contract', () => {
    const gate = evaluateStopSchemaGateWithNative({
      assistantText:
        '继续执行。\n```json\n{"stopreason":2,"reason":"未完成","has_evidence":1,"evidence":"partial logs","issue_cause":"need more verification","excluded_factors":"syntax fixed","diagnostic_order":"read->run","done_steps":"checked logs","next_step":"rerun failing command","next_suggested_path":"","needs_user_input":false,"learned":""}\n```',
      used: 0,
      maxRepeats: 3,
    });
    expect(gate.action).toBe('followup');
    expect(gate.reason_code).toBe('stop_schema_continue_next_step');
    expect(gate.parsed).toMatchObject({
      stopreason: 2,
      next_step: 'rerun failing command',
    });
  });

  test('fence invalid json returns invalid_json guidance', () => {
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

  test('bare json without fence is treated as missing schema', () => {
    const gate = evaluateStopSchemaGateWithNative({
      assistantText:
        '{"stopreason":0,"reason":"任务完成","has_evidence":1,"evidence":"live probe ok","issue_cause":"none","excluded_factors":"none","diagnostic_order":"check->verify","done_steps":"done","next_step":"","next_suggested_path":"","needs_user_input":false,"learned":"summary ready"}',
      used: 0,
      maxRepeats: 3,
    });
    expect(gate.action).toBe('followup');
    expect(gate.reason_code).toBe('stop_schema_missing');
  });
});
