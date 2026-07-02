import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  finalizeServertoolHandlerPlanWithNative,
  materializeServertoolHandlerResultWithNative,
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

  switch (materializationPlan.action) {
    case 'throw_dispatch_error':
      throw createServertoolProviderProtocolErrorFromPlan(materializationPlan.errorPlan);
    case 'return_tool_flow':
      return {
        mode: materializationPlan.resultMode,
        finalChatResponse: args.baseForExecution,
        execution: {
          flowId: materializationPlan.executionFlowId
        }
      };
    default:
      throw new Error('[servertool] invalid execution outcome materialization action');
  }
}

export const materializeServertoolPlannedResult = async (
  planned: unknown,
  options: ServerSideToolEngineOptions
): Promise<ServerToolHandlerResult | null> => {
  const actionPlan = planServertoolHandlerMaterializationForPlannedWithNative(
    planned,
    options.requestId
  );
  switch (actionPlan.action) {
    case 'finalize_without_backend': {
      return await finalizeServertoolHandlerPlanWithNative(planned, options.requestId);
    }
    case 'throw_handler_error':
      throw createServertoolProviderProtocolErrorFromPlan(actionPlan.errorPlan);
    case 'return_handler_result':
      return materializeServertoolHandlerResultWithNative(planned, options.requestId);
    default:
      throw new Error('[servertool] invalid handler materialization action');
  }
};
