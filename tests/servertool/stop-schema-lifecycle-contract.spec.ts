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

  test('valid terminal schema allows stop even without prior explicit stop-hook call', () => {
    const gate = evaluateStopSchemaGateWithNative({
      assistantText: '{"stopreason":0,"reason":"任务完成","has_evidence":1,"evidence":"live probe ok","issue_cause":"none","excluded_factors":"none","diagnostic_order":"check->verify","done_steps":"done","next_step":"","next_suggested_path":"","needs_user_input":false,"learned":"summary ready"}',
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

  test('non-terminal schema follows up with schema-aware guidance', () => {
    const gate = evaluateStopSchemaGateWithNative({
      assistantText: '{"stopreason":2,"reason":"未完成","has_evidence":1,"evidence":"partial logs","issue_cause":"need more verification","excluded_factors":"syntax fixed","diagnostic_order":"read->run","done_steps":"checked logs","next_step":"rerun failing command","next_suggested_path":"","needs_user_input":false,"learned":""}',
      used: 0,
      maxRepeats: 3,
    });
    expect(gate.action).toBe('followup');
    expect(gate.reason_code).toBe('stop_schema_continue_next_step');
    expect(gate.count_budget).toBe(true);
    expect(gate.parsed).toMatchObject({
      stopreason: 2,
      next_step: 'rerun failing command',
    });
    expect(gate.followup_text).toContain('rerun failing command');
  });

  test('malformed schema returns parse feedback plus corrective field guidance', () => {
    const gate = evaluateStopSchemaGateWithNative({
      assistantText: '{"stopreason":"oops","reason":"想停","has_evidence":1,"evidence":"log"}',
      used: 0,
      maxRepeats: 3,
    });
    expect(gate.action).toBe('followup');
    expect(gate.reason_code).toBe('stop_schema_stopreason_missing_or_non_numeric');
    expect(gate.count_budget).toBe(true);
    expect(gate.missing_fields).toContain('stopreason');
    expect(gate.parsed).toMatchObject({
      reason: '想停',
      has_evidence: 1,
      evidence: 'log',
    });
    expect(gate.followup_text).toContain('stopreason');
    expect(gate.followup_text).toContain('0/1/2');
  });
});
