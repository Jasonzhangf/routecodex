import { describe, expect, test } from '@jest/globals';

import {
  resolveFollowupFlowDecision,
} from '../../src/servertool/backend-route-flow-policy.js';
import {
  shouldUseServertoolGoldProgressHighlightWithNative
} from '../../src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';

describe('servertool followup flow policy', () => {
  test('reads stop_message runtime plan from skeleton config', () => {
    const decision = resolveFollowupFlowDecision('stop_message_flow');
    expect(decision.flowId).toBe('stop_message_flow');
    expect(decision.outcomeMode).toBe('reenter');
    expect(decision.seedLoopPayload).toBe(true);
  });

  test('normalizes flow id inside Rust runtime plan', () => {
    const decision = resolveFollowupFlowDecision('  stop_message_flow  ');
    expect(decision.flowId).toBe('stop_message_flow');
    expect(decision.seedLoopPayload).toBe(true);
  });

  test('unknown flow uses the Rust default runtime plan', () => {
    const decision = resolveFollowupFlowDecision('unknown_flow');
    expect(decision.flowId).toBe('unknown_flow');
    expect(decision.outcomeMode).toBe('reenter');
    expect(decision.noFollowup).toBe(false);
  });

  test('stop_message_flow does not ignore requires_action followups', () => {
    expect(resolveFollowupFlowDecision('stop_message_flow').ignoreRequiresActionFollowup).toBe(false);
  });

  test('reads context decoration mode from skeleton config', () => {
    expect(resolveFollowupFlowDecision('continue_execution_flow').contextDecorationMode).toBe('continue_execution_summary');
    expect(resolveFollowupFlowDecision('web_search_flow').contextDecorationMode).toBe('web_search_summary');
  });

  test('reads gold highlight flow ids from skeleton config', () => {
    expect(shouldUseServertoolGoldProgressHighlightWithNative({ flowId: 'continue_execution_flow' })).toBe(true);
  });
});
