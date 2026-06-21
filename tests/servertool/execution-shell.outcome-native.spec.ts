import { describe, expect, test } from '@jest/globals';
import { planServertoolOutcomeWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';

describe('execution-shell native outcome contract', () => {
  test('native outcome plan resolves generic followup payload when last execution followup is absent', () => {
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
      lastExecutionFlowId: 'sample_done',
      hasLastExecutionFollowup: false
    });

    expect(outcome.outcomeMode).toBe('servertool_only');
    expect(outcome.followupStrategy).toBe('generic_tool_outputs');
    expect(outcome.useGenericFollowup).toBe(true);
    expect(outcome.resolvedFollowup).toEqual({
      requestIdSuffix: ':servertool_followup',
      injection: {
        ops: [
          { op: 'append_assistant_message', required: true },
          { op: 'append_tool_messages_from_tool_outputs', required: true }
        ]
      }
    });
  });
});
