import { describe, expect, test } from '@jest/globals';

import {
  materializeFollowupPayload,
  resolveFollowupExecutionMode,
  resolveFollowupPayloadSource
} from '../../src/servertool/followup-runtime-block.js';

describe('servertool followup runtime block', () => {
  test('uses native skip outcome mode directly', () => {
    expect(
      resolveFollowupExecutionMode({
        flowId: 'reasoning_stop_finalize_flow',
        metadata: {},
        readClientInjectOnly: () => false
      })
    ).toBe('skip');
  });

  test('uses native client inject outcome mode directly', () => {
    expect(
      resolveFollowupExecutionMode({
        flowId: 'clock_hold_flow',
        metadata: {},
        readClientInjectOnly: () => false
      })
    ).toBe('client_inject_only');
  });

  test('keeps explicit metadata client inject override authoritative at dispatch time', () => {
    expect(
      resolveFollowupExecutionMode({
        flowId: 'continue_execution_flow',
        metadata: { clientInjectOnly: true },
        readClientInjectOnly: (metadata) => metadata.clientInjectOnly === true
      })
    ).toBe('client_inject_only');
  });

  test('defaults normal followup flows to reenter', () => {
    expect(
      resolveFollowupExecutionMode({
        flowId: 'continue_execution_flow',
        metadata: {},
        readClientInjectOnly: () => false
      })
    ).toBe('reenter');
  });

  test('classifies payload source from followup plan shape', () => {
    expect(resolveFollowupPayloadSource({ payload: { ok: true } })).toBe('payload');
    expect(resolveFollowupPayloadSource({ injection: { ops: [] } })).toBe('injection');
    expect(resolveFollowupPayloadSource({ metadata: { clientInjectOnly: true } })).toBe('none');
  });

  test('materializes injection payload through a single helper', () => {
    expect(
      materializeFollowupPayload({
        followupPlan: { injection: { ops: [{ op: 'append_user_text', text: '继续执行' }] } },
        buildInjectionPayload: () => ({ messages: [{ role: 'user', content: '继续执行' }] })
      })
    ).toEqual({
      source: 'injection',
      payload: { messages: [{ role: 'user', content: '继续执行' }] }
    });
  });
});
