import { describe, expect, test } from '@jest/globals';
import {
  planServertoolOutcomeWithNative,
  planServertoolToolCallDispatchWithNative
} from 'rcc-llmswitch-core/native/servertool-wrapper';
import { buildServertoolDispatchPlanInputWithNative } from 'rcc-llmswitch-core/native/servertool-wrapper';
import { buildServertoolOutcomePlanInputWithNative } from 'rcc-llmswitch-core/native/servertool-wrapper';

const CLI_OWNED_TOOL_NAME = 'web_search';

describe('server-side-tools native dispatch planner', () => {
  test('builds dispatch-plan input through Rust owner instead of TS registered-handler synthesis', () => {
    const input = buildServertoolDispatchPlanInputWithNative({
      toolCalls: [{ id: 'call_1', name: CLI_OWNED_TOOL_NAME, arguments: '{}' }],
      disableToolCallHandlers: false
    });

    expect(input.registeredToolCallHandlers).toEqual([]);
    expect(input.toolCalls).toEqual([{ id: 'call_1', name: CLI_OWNED_TOOL_NAME, arguments: '{}' }]);
  });

  test('does not dispatch CLI-owned tools from the server-side skeleton registry', () => {
    const input = buildServertoolDispatchPlanInputWithNative({
      toolCalls: [{ id: 'call_1', name: CLI_OWNED_TOOL_NAME, arguments: '{}' }],
      disableToolCallHandlers: false
    });

    expect(input.registeredToolCallHandlers).toEqual([]);

    const plan = planServertoolToolCallDispatchWithNative(input);
    expect(plan.executableToolCalls).toHaveLength(0);
    expect(plan.skippedToolCalls).toContainEqual(expect.objectContaining({
      id: 'call_1',
      name: CLI_OWNED_TOOL_NAME,
      reason: 'no_registered_tool_call_handler'
    }));
  });

  test('include/exclude filters do not restore removed server-side handlers', () => {
    const included = planServertoolToolCallDispatchWithNative(
      buildServertoolDispatchPlanInputWithNative({
        toolCalls: [{ id: 'call_1', name: CLI_OWNED_TOOL_NAME, arguments: '{}' }],
        disableToolCallHandlers: false,
        includeToolCallHandlerNames: [CLI_OWNED_TOOL_NAME]
      })
    );
    expect(included.executableToolCalls).toHaveLength(0);
    expect(included.skippedToolCalls).toContainEqual(expect.objectContaining({
      id: 'call_1',
      name: CLI_OWNED_TOOL_NAME,
      reason: 'no_registered_tool_call_handler'
    }));

    const excluded = planServertoolToolCallDispatchWithNative(
      buildServertoolDispatchPlanInputWithNative({
        toolCalls: [{ id: 'call_1', name: CLI_OWNED_TOOL_NAME, arguments: '{}' }],
        disableToolCallHandlers: false,
        excludeToolCallHandlerNames: [CLI_OWNED_TOOL_NAME]
      })
    );
    expect(excluded.executableToolCalls).toHaveLength(0);
  });

  test('disables all tool_call handlers without mutating tool list', () => {
    const plan = planServertoolToolCallDispatchWithNative(
      buildServertoolDispatchPlanInputWithNative({
        toolCalls: [{ id: 'call_1', name: CLI_OWNED_TOOL_NAME, arguments: '{}' }],
        disableToolCallHandlers: true
      })
    );

    expect(plan.executableToolCalls).toHaveLength(0);
    expect(plan.skippedToolCalls).toHaveLength(1);
    expect(plan.skippedToolCalls[0]).toMatchObject({
      id: 'call_1',
      name: CLI_OWNED_TOOL_NAME,
      reason: 'tool_call_handlers_disabled'
    });
  });

  test('returns skeleton-driven mixed outcome contract for executed subset', () => {
    const executionState = {
      executedToolCalls: [
        {
          toolCall: {
            id: 'call_dispatch_1',
            name: CLI_OWNED_TOOL_NAME,
            arguments: '{}',
            executionMode: 'guarded',
            stripAfterExecute: true
          },
          execution: {
            flowId: `${CLI_OWNED_TOOL_NAME}_ok`
          }
        }
      ],
      executedIds: ['call_dispatch_1'],
      executedFlowIds: [`${CLI_OWNED_TOOL_NAME}_ok`],
      lastExecution: {
        flowId: `${CLI_OWNED_TOOL_NAME}_ok`
      }
    };

    const outcome = planServertoolOutcomeWithNative(
      buildServertoolOutcomePlanInputWithNative({
        toolCalls: [
          { id: 'call_dispatch_1', name: CLI_OWNED_TOOL_NAME, arguments: '{}' },
          { id: 'call_dispatch_2', name: 'client_side_tool', arguments: '{}' }
        ],
        executionState
      })
    );

    expect(outcome).toMatchObject({
      outcomeMode: 'mixed_client_tools',
      requiresPendingInjection: true,
      primaryExecutionMode: 'guarded',
      flowId: 'servertool_mixed'
    });
    expect(outcome.remainingToolCallIds).toEqual(['call_dispatch_2']);
    expect((outcome as any).followupStrategy).toBeUndefined();
    expect((outcome as any).pendingSessionId).toBeUndefined();
    expect((outcome as any).pendingInjectionMessageKinds).toBeUndefined();
  });
});
