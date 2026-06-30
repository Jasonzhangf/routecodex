import { describe, expect, test } from '@jest/globals';
import {
  planServertoolOutcomeWithNative,
  planServertoolToolCallDispatchWithNative
} from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import {
  buildServertoolDispatchPlanInput
} from '../../sharedmodule/llmswitch-core/src/servertool/execution-queue-shell.js';
import { buildServertoolOutcomePlanInput } from '../../sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.js';
import { buildServertoolDispatchPlanInputWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import { listServertoolToolSpecs } from '../../sharedmodule/llmswitch-core/src/servertool/skeleton-config.js';

const EXECUTABLE_TOOL_NAME = 'web_search';

function executableToolSpec(): {
  name: string;
  executionMode: string;
  stripAfterExecute: boolean;
} {
  const spec = listServertoolToolSpecs().find((entry) => entry.name === EXECUTABLE_TOOL_NAME);
  if (!spec) {
    throw new Error(`expected ${EXECUTABLE_TOOL_NAME} in servertool skeleton config`);
  }
  return {
    name: spec.name,
    executionMode: spec.execution.mode,
    stripAfterExecute: spec.execution.stripAfterExecute
  };
}

describe('server-side-tools native dispatch planner', () => {
  test('builds dispatch-plan input through Rust owner instead of TS registered-handler synthesis', () => {
    const spec = executableToolSpec();
    const input = buildServertoolDispatchPlanInputWithNative({
      toolCalls: [{ id: 'call_1', name: spec.name, arguments: '{}' }],
      disableToolCallHandlers: false
    });

    expect(input.registeredToolCallHandlers).toContainEqual({
      name: spec.name,
      trigger: 'tool_call',
      executionMode: spec.executionMode,
      stripAfterExecute: spec.stripAfterExecute
    });
    expect(input.toolCalls).toEqual([{ id: 'call_1', name: spec.name, arguments: '{}' }]);
  });

  test('builds dispatch-plan handler truth from Rust skeleton config', () => {
    const spec = executableToolSpec();
    const input = buildServertoolDispatchPlanInput({
      toolCalls: [{ id: 'call_1', name: spec.name, arguments: '{}' }],
      disableToolCallHandlers: false
    });

    expect(input.registeredToolCallHandlers).toContainEqual({
      name: spec.name,
      trigger: 'tool_call',
      executionMode: spec.executionMode,
      stripAfterExecute: spec.stripAfterExecute
    });

    const plan = planServertoolToolCallDispatchWithNative(input);
    expect(plan.executableToolCalls).toHaveLength(1);
    expect(plan.executableToolCalls[0]).toMatchObject({
      id: 'call_1',
      name: spec.name,
      executionMode: spec.executionMode,
      stripAfterExecute: spec.stripAfterExecute
    });
  });

  test('respects include/exclude filters against skeleton-owned tool specs', () => {
    const spec = executableToolSpec();

    const included = planServertoolToolCallDispatchWithNative(
      buildServertoolDispatchPlanInput({
        toolCalls: [{ id: 'call_1', name: spec.name, arguments: '{}' }],
        disableToolCallHandlers: false,
        includeToolCallHandlerNames: [spec.name]
      })
    );
    expect(included.executableToolCalls).toHaveLength(1);

    const excluded = planServertoolToolCallDispatchWithNative(
      buildServertoolDispatchPlanInput({
        toolCalls: [{ id: 'call_1', name: spec.name, arguments: '{}' }],
        disableToolCallHandlers: false,
        excludeToolCallHandlerNames: [spec.name]
      })
    );
    expect(excluded.executableToolCalls).toHaveLength(0);
  });

  test('disables all tool_call handlers without mutating tool list', () => {
    const spec = executableToolSpec();
    const plan = planServertoolToolCallDispatchWithNative(
      buildServertoolDispatchPlanInput({
        toolCalls: [{ id: 'call_1', name: spec.name, arguments: '{}' }],
        disableToolCallHandlers: true
      })
    );

    expect(plan.executableToolCalls).toHaveLength(0);
    expect(plan.skippedToolCalls).toHaveLength(1);
    expect(plan.skippedToolCalls[0]).toMatchObject({
      id: 'call_1',
      name: spec.name,
      reason: 'tool_call_handlers_disabled'
    });
  });

  test('returns skeleton-driven mixed outcome contract for executed subset', () => {
    const spec = executableToolSpec();
    const executionState = {
      executedToolCalls: [
        {
          toolCall: {
            id: 'call_dispatch_1',
            name: spec.name,
            arguments: '{}',
            executionMode: spec.executionMode,
            stripAfterExecute: spec.stripAfterExecute
          },
          execution: {
            flowId: `${spec.name}_ok`
          }
        }
      ],
      executedIds: new Set(['call_dispatch_1']),
      executedFlowIds: [`${spec.name}_ok`],
      lastExecution: {
        flowId: `${spec.name}_ok`
      }
    };

    const outcome = planServertoolOutcomeWithNative(
      buildServertoolOutcomePlanInput({
        toolCalls: [
          { id: 'call_dispatch_1', name: spec.name, arguments: '{}' },
          { id: 'call_dispatch_2', name: 'client_side_tool', arguments: '{}' }
        ],
        executionState
      })
    );

    expect(outcome).toMatchObject({
      outcomeMode: 'mixed_client_tools',
      requiresPendingInjection: true,
      primaryExecutionMode: spec.executionMode,
      flowId: 'servertool_mixed'
    });
    expect(outcome.remainingToolCallIds).toEqual(['call_dispatch_2']);
    expect((outcome as any).followupStrategy).toBeUndefined();
    expect((outcome as any).pendingSessionId).toBeUndefined();
    expect((outcome as any).pendingInjectionMessageKinds).toBeUndefined();
  });
});
