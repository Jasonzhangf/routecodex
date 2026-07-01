import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  planServertoolExecutionOutcomeMaterializationWithNative,
  planServertoolHandlerMaterializationForPlannedWithNative,
  type NativeServertoolExecutionLoopState
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  buildServertoolOutcomePlanInputWithNative,
  planServertoolOutcomeWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import { createServertoolProviderProtocolErrorFromPlan } from './timeout-error-block.js';
import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerPlan,
  ServerToolHandlerResult,
  ToolCall
} from './types.js';

export function materializeNativeToolCallExecutionOutcome(args: {
  baseForExecution: JsonObject;
  options: ServerSideToolEngineOptions;
  toolCalls: ToolCall[];
  executionState: NativeServertoolExecutionLoopState;
}): ServerSideToolEngineResult {
  const outcomePlan = planServertoolOutcomeWithNative(
    buildServertoolOutcomePlanInputWithNative({
      toolCalls: args.toolCalls,
      executionState: args.executionState,
      adapterContext: args.options.adapterContext,
      baseForExecution: args.baseForExecution,
    })
  );

  const materializationPlan = planServertoolExecutionOutcomeMaterializationWithNative({
    requestId: args.options.requestId,
    outcomeMode: outcomePlan.outcomeMode,
    requiresPendingInjection: outcomePlan.requiresPendingInjection,
    hasLastExecution: args.executionState.lastExecution != null,
    executedToolCallsLen: args.executionState.executedToolCalls.length,
    lastExecution: args.executionState.lastExecution,
    flowId: outcomePlan.flowId
  });

  if (materializationPlan.action === 'throw_dispatch_error') {
    throw createServertoolProviderProtocolErrorFromPlan(materializationPlan.errorPlan);
  }
  return {
    mode: 'tool_flow',
    finalChatResponse: args.baseForExecution,
    execution: {
      flowId: materializationPlan.executionFlowId
    }
  };
}

export const materializeServertoolPlannedResult = async (
  planned: ServerToolHandlerPlan | ServerToolHandlerResult,
  options: ServerSideToolEngineOptions
): Promise<ServerToolHandlerResult | null> => {
  const actionPlan = planServertoolHandlerMaterializationForPlannedWithNative(
    planned,
    options.requestId
  );
  switch (actionPlan.action) {
    case 'finalize_without_backend': {
      const plan = planned as ServerToolHandlerPlan;
      return await plan.finalize();
    }
    case 'throw_handler_error':
      throw createServertoolProviderProtocolErrorFromPlan(actionPlan.errorPlan);
    case 'return_handler_result':
      return planned as ServerToolHandlerResult;
  }
};
