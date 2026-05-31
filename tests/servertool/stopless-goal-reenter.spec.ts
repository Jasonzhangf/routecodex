import { describe, expect, jest, test } from '@jest/globals';
import {
  applyClientInjectOnlyMetadata,
  resolveFollowupExecutionMode
} from '../../sharedmodule/llmswitch-core/src/servertool/followup-runtime-block.js';
import { resolveFollowupFlowDecision } from '../../sharedmodule/llmswitch-core/src/servertool/followup-flow-policy.js';
import { shouldShortCircuitRequiresActionFollowup } from '../../sharedmodule/llmswitch-core/src/servertool/finalize-followup-block.js';
import { runClientInjectOnlyFollowup } from '../../sharedmodule/llmswitch-core/src/servertool/client-inject-followup-block.js';

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

  test('stop_message_flow uses standard servertool reenter path for plain stop_message followup', () => {
    const decision = resolveFollowupFlowDecision('stop_message_flow');
    const metadata = {} as any;
    const mode = resolveFollowupExecutionMode({
      flowId: 'stop_message_flow',
      decision,
      metadata,
      readClientInjectOnly: () => false,
    });
    expect(mode).toBe('reenter');
  });

  test('stop_message_flow execution mode remains reenter with explicit reenter decision', () => {
    const metadata = {} as any;
    const mode = resolveFollowupExecutionMode({
      flowId: 'stop_message_flow',
      decision: {
        flowId: 'stop_message_flow',
        outcomeMode: 'reenter',
        noFollowup: false,
        autoLimit: false,
        flowOnlyLoopLimit: false,
        clientInjectOnly: false,
        clearStateOnFollowupFailure: false,
        seedLoopPayload: false,
        retryEmptyFollowupOnce: false,
        ignoreRequiresActionFollowup: false
      },
      metadata,
      readClientInjectOnly: () => false,
    });
    expect(mode).toBe('reenter');
  });

  test('client inject metadata forcing is not applied for reenter stop_message_flow decision', () => {
    const metadata = {} as any;
    const result = applyClientInjectOnlyMetadata({
      flowId: 'stop_message_flow',
      decision: {
        flowId: 'stop_message_flow',
        outcomeMode: 'reenter',
        noFollowup: false,
        autoLimit: false,
        flowOnlyLoopLimit: false,
        clientInjectOnly: false,
        clearStateOnFollowupFailure: false,
        seedLoopPayload: false,
        retryEmptyFollowupOnce: false,
        ignoreRequiresActionFollowup: false
      },
      metadata,
      defaultText: '继续执行',
      readClientInjectOnly: () => false,
      normalizeClientInjectText: (value) => String(value ?? '').trim()
    });
    expect(result).toEqual({ forced: false });
    expect(metadata.clientInjectOnly).toBeUndefined();
    expect(metadata.clientInjectText).toBeUndefined();
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

  test('followup failure cleanup must follow explicit policy instead of hardcoded stop_message_flow special-case', async () => {
    const disableStopMessageAfterFailedFollowup = jest.fn();
    await expect(
      runClientInjectOnlyFollowup({
        adapterContext: {} as any,
        requestId: 'req-cleanup-policy',
        flowId: 'stop_message_flow',
        followupEntryEndpoint: '/v1/chat/completions',
        followupRequestId: 'req-cleanup-policy:followup',
        followupPayloadRaw: null,
        metadata: {} as any,
        followupTimeoutMs: 1_000,
        isStopMessageFlow: true,
        clearStateOnFollowupFailure: false,
        shouldInjectStopLoopWarning: false,
        stopLoopWarnThreshold: 5,
        loopState: null,
        finalChatResponse: { id: 'chat', object: 'chat.completion', choices: [] } as any,
        execution: { flowId: 'stop_message_flow' } as any,
        clientInjectDispatch: async () => ({ ok: false, reason: 'inject_failed' }),
        coerceFollowupPayloadStream: (payload) => payload,
        appendStopMessageLoopWarning: () => {},
        createClientDisconnectWatcher: () => ({
          promise: new Promise<never>(() => {}),
          cancel: () => {}
        }),
        withTimeout: async (promise) => promise,
        createServerToolTimeoutError: () => new Error('timeout'),
        isServerToolClientDisconnectedError: () => false,
        isAdapterClientDisconnected: () => false,
        decorateFinalChatWithServerToolContext: (chat) => chat,
        disableStopMessageAfterFailedFollowup,
        stopMessageReservation: null,
        onLogProgress: () => {}
      })
    ).rejects.toThrow('client injection failed');

    expect(disableStopMessageAfterFailedFollowup).not.toHaveBeenCalled();
  });

  test('client inject dispatcher missing still clears state only through explicit cleanup policy', async () => {
    const disableStopMessageAfterFailedFollowup = jest.fn();
    await expect(
      runClientInjectOnlyFollowup({
        adapterContext: {} as any,
        requestId: 'req-cleanup-policy-missing-dispatch',
        flowId: 'stop_message_flow',
        followupEntryEndpoint: '/v1/chat/completions',
        followupRequestId: 'req-cleanup-policy-missing-dispatch:followup',
        followupPayloadRaw: null,
        metadata: {} as any,
        followupTimeoutMs: 1_000,
        isStopMessageFlow: true,
        clearStateOnFollowupFailure: true,
        shouldInjectStopLoopWarning: false,
        stopLoopWarnThreshold: 5,
        loopState: null,
        finalChatResponse: { id: 'chat', object: 'chat.completion', choices: [] } as any,
        execution: { flowId: 'stop_message_flow' } as any,
        coerceFollowupPayloadStream: (payload) => payload,
        appendStopMessageLoopWarning: () => {},
        createClientDisconnectWatcher: () => ({
          promise: new Promise<never>(() => {}),
          cancel: () => {}
        }),
        withTimeout: async (promise) => promise,
        createServerToolTimeoutError: () => new Error('timeout'),
        isServerToolClientDisconnectedError: () => false,
        isAdapterClientDisconnected: () => false,
        decorateFinalChatWithServerToolContext: (chat) => chat,
        disableStopMessageAfterFailedFollowup,
        stopMessageReservation: null,
        onLogProgress: () => {}
      } as any)
    ).rejects.toThrow('client inject dispatcher unavailable');

    expect(disableStopMessageAfterFailedFollowup).toHaveBeenCalledTimes(1);
  });
});
