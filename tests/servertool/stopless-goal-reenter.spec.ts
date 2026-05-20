import { describe, expect, test } from '@jest/globals';
import { resolveFollowupExecutionMode } from '../../sharedmodule/llmswitch-core/src/servertool/followup-runtime-block.js';
import { resolveFollowupFlowDecision } from '../../sharedmodule/llmswitch-core/src/servertool/followup-flow-policy.js';
import { shouldShortCircuitRequiresActionFollowup } from '../../sharedmodule/llmswitch-core/src/servertool/finalize-followup-block.js';

describe('stopless re-enter path (no tmux inject)', () => {
  test('stopless_goal_continue returns reenter execution mode regardless of skeleton config', () => {
    // Simulate a followup request with clientInjectSource = 'servertool.stopless_goal_continue'
    const metadata = { clientInjectSource: 'servertool.stopless_goal_continue' } as any;
    const mode = resolveFollowupExecutionMode({
      flowId: undefined,
      metadata,
      readClientInjectOnly: () => false,
    });
    // Must NOT go through client_inject_only (tmux) — must use re-enter path
    expect(mode).toBe('reenter');
  });

  test('stop_message_flow defaults to client inject for plain stop_message followup', () => {
    const decision = resolveFollowupFlowDecision('stop_message_flow');
    const metadata = { clientInjectSource: 'servertool.stop_message' } as any;
    const mode = resolveFollowupExecutionMode({
      flowId: 'stop_message_flow',
      decision,
      metadata,
      readClientInjectOnly: () => false,
    });
    expect(mode).toBe('client_inject_only');
  });

  test('stop_message_flow followup is not short-circuited on requires_action', () => {
    const decision = resolveFollowupFlowDecision('stop_message_flow');
    const shouldShortCircuit = shouldShortCircuitRequiresActionFollowup({
      flowId: 'stop_message_flow',
      decision,
      followupBody: {
        status: 'requires_action',
        required_action: {
          submit_tool_outputs: {
            tool_calls: []
          }
        }
      } as any,
      hasRequiresActionShape: () => true
    });
    expect(shouldShortCircuit).toBe(false);
  });

  test('continue_execution_flow returns reenter (no tmux inject)', () => {
    const decision = resolveFollowupFlowDecision('continue_execution_flow');
    const metadata = {} as any;
    const mode = resolveFollowupExecutionMode({
      flowId: 'continue_execution_flow',
      decision,
      metadata,
      readClientInjectOnly: () => false,
    });
    expect(mode).toBe('reenter');
  });
});
