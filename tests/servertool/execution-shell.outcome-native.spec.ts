import { describe, expect, test } from '@jest/globals';
import { planServertoolOutcomeWithNative } from 'rcc-llmswitch-core/native/servertool-wrapper';

describe('execution-shell native outcome contract', () => {
  test('native outcome plan returns execution contract without followup payload', () => {
    const outcome = planServertoolOutcomeWithNative({
      toolCalls: [{ id: 'call_1', name: 'sample_client_tool', arguments: '{}' }],
      executedToolCalls: [
        {
          id: 'call_1',
          name: 'sample_client_tool',
          arguments: '{}',
          executionMode: 'client_inject_only',
          stripAfterExecute: true
        }
      ],
      executedFlowIds: ['sample_done'],
      lastExecutionFlowId: 'sample_done'
    });

    expect(outcome.outcomeMode).toBe('servertool_only');
    expect(outcome.flowId).toBe('sample_done');
    expect(outcome.requiresPendingInjection).toBe(false);
    expect((outcome as any).followupStrategy).toBeUndefined();
    expect((outcome as any).useGenericFollowup).toBeUndefined();
    expect((outcome as any).resolvedFollowup).toBeUndefined();
  });
});
