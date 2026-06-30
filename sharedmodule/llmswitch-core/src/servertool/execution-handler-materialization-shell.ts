import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  appendServertoolExecutedRecordWithNative,
  planServertoolExecutionDispatchErrorWithNative,
  planServertoolExecutionOutcomeRuntimeActionWithNative,
  createServertoolExecutionLoopStateWithNative,
  planServertoolHandlerContractErrorWithNative,
  planServertoolHandlerRuntimeActionForPlannedWithNative,
  type NativeServertoolExecutionLoopState
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  buildServertoolOutcomePlanInputWithNative,
  planServertoolOutcomeWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import { __executeBuiltinHandlerForRuntime } from './builtin-handler-catalog.js';
import { createServertoolProviderProtocolErrorFromPlan } from './timeout-error-block.js';
import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext,
  ServerToolHandlerPlan,
  ServerToolHandlerResult,
  ToolCall
} from './types.js';

export interface ServertoolExecutedRecord {
  toolCall: {
    id: string;
    name: string;
    arguments: string;
    executionMode: string;
    stripAfterExecute: boolean;
  };
  execution?: {
    flowId: string;
  };
}

export interface ServertoolExecutionLoopState {
  executedToolCalls: ServertoolExecutedRecord[];
  executedIds: Set<string>;
  executedFlowIds: string[];
  lastExecution?: {
    flowId: string;
  };
}

export function createServertoolExecutionLoopStateFromNative(): ServertoolExecutionLoopState {
  return hydrateExecutionLoopState(createServertoolExecutionLoopStateWithNative());
}

export function appendExecutedToolRecordFromNative(
  state: ServertoolExecutionLoopState,
  toolCall: ServertoolExecutedRecord['toolCall'],
  execution?: ServertoolExecutedRecord['execution']
): void {
  const next = hydrateExecutionLoopState(
    appendServertoolExecutedRecordWithNative({
      state: dehydrateExecutionLoopState(state),
      toolCall,
      ...(execution ? { execution } : {})
    })
  );
  state.executedToolCalls = next.executedToolCalls;
  state.executedIds = next.executedIds;
  state.executedFlowIds = next.executedFlowIds;
  state.lastExecution = next.lastExecution;
}

type ServertoolExecutionDispatchErrorInput = Parameters<
  typeof planServertoolExecutionDispatchErrorWithNative
>[0];

function throwServertoolExecutionDispatchError(args: ServertoolExecutionDispatchErrorInput): never {
  throw createServertoolProviderProtocolErrorFromPlan(
    planServertoolExecutionDispatchErrorWithNative(args)
  );
}

export function materializeNativeToolCallExecutionOutcome(args: {
  baseForExecution: JsonObject;
  options: ServerSideToolEngineOptions;
  toolCalls: ToolCall[];
  executionState: ServertoolExecutionLoopState;
}): ServerSideToolEngineResult {
  const outcomePlan = planServertoolOutcomeWithNative(
    buildServertoolOutcomePlanInputWithNative({
      toolCalls: args.toolCalls,
      executionState: args.executionState,
      adapterContext: args.options.adapterContext,
      baseForExecution: args.baseForExecution,
    })
  );

  const outcomeRuntimeActionPlan = planServertoolExecutionOutcomeRuntimeActionWithNative({
    outcomeMode: outcomePlan.outcomeMode,
    hasLastExecution: Boolean(args.executionState.lastExecution),
    executedToolCallsLen: args.executionState.executedToolCalls.length,
    lastExecution: args.executionState.lastExecution,
    flowId: outcomePlan.flowId
  });

  if (outcomeRuntimeActionPlan.action === 'invalid_mixed_client_tools_outcome') {
    throwServertoolExecutionDispatchError({
      kind: 'invalid_mixed_client_tools_outcome',
      requestId: args.options.requestId,
      outcomeMode: outcomePlan.outcomeMode,
      requiresPendingInjection: outcomePlan.requiresPendingInjection
    });
  }

  if (outcomeRuntimeActionPlan.action === 'missing_servertool_execution_contract') {
    throwServertoolExecutionDispatchError({
      kind: 'missing_servertool_execution_contract',
      requestId: args.options.requestId,
      outcomeMode: outcomePlan.outcomeMode
    });
  }
  return {
    mode: 'tool_flow',
    finalChatResponse: args.baseForExecution,
    execution: {
      flowId: outcomeRuntimeActionPlan.executionFlowId
    }
  };
}

export const materializeServertoolPlannedResult = async (
  planned: ServerToolHandlerPlan | ServerToolHandlerResult,
  options: ServerSideToolEngineOptions
): Promise<ServerToolHandlerResult | null> => {
  const actionPlan = planServertoolHandlerRuntimeActionForPlannedWithNative(planned);
  if (actionPlan.action === 'finalize_without_backend') {
    const plan = planned as ServerToolHandlerPlan;
    return await plan.finalize();
  }
  if (actionPlan.action === 'invalid_plan_missing_finalize') {
    throw createServertoolProviderProtocolErrorFromPlan(
      planServertoolHandlerContractErrorWithNative({
        kind: 'invalid_handler_plan_missing_finalize',
        requestId: options.requestId
      })
    );
  }
  if (actionPlan.action === 'invalid_plan_result') {
    throw createServertoolProviderProtocolErrorFromPlan(
      planServertoolHandlerContractErrorWithNative({
        kind: 'invalid_handler_plan_result',
        requestId: options.requestId
      })
    );
  }
  return planned as ServerToolHandlerResult;
};

export async function executeBuiltinServerToolHandler(args: {
  builtinName: string;
  ctx: ServerToolHandlerContext;
}): Promise<ServerToolHandlerPlan | ServerToolHandlerResult | null> {
  return __executeBuiltinHandlerForRuntime(args.builtinName, args.ctx);
}

function hydrateExecutionLoopState(state: NativeServertoolExecutionLoopState): ServertoolExecutionLoopState {
  return {
    executedToolCalls: state.executedToolCalls as ServertoolExecutedRecord[],
    executedIds: new Set(state.executedIds),
    executedFlowIds: state.executedFlowIds,
    ...(state.lastExecution ? { lastExecution: state.lastExecution as ServertoolExecutedRecord['execution'] } : {})
  };
}

function dehydrateExecutionLoopState(state: ServertoolExecutionLoopState): NativeServertoolExecutionLoopState {
  return {
    executedToolCalls: state.executedToolCalls as any,
    executedIds: [...state.executedIds],
    executedFlowIds: state.executedFlowIds,
    ...(state.lastExecution ? { lastExecution: state.lastExecution as any } : {})
  };
}
