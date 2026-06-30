import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext,
  ToolCall
} from './types.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { prepareServertoolDispatchStage } from './dispatch-preparation-shell.js';
import { buildServertoolCliProjectionBranchResult } from './cli-projection-runtime-shell.js';
import { runServertoolIoExecutionQueue } from './execution-queue-shell.js';
import { materializeNativeToolCallExecutionOutcome } from './execution-handler-materialization-shell.js';
import { finalizeServertoolResponseStage } from './response-stage-finalize-shell.js';
import { planServertoolExecutionBranchWithNative } from '../native/router-hotpath/native-servertool-core-semantics.js';

export async function runServertoolExecutionStage(args: {
  options: ServerSideToolEngineOptions;
  baseObject: JsonObject;
  toolCalls: ToolCall[];
  contextBase: Omit<ServerToolHandlerContext, 'toolCall'>;
  includeToolCallNames: Set<string> | null;
  excludeToolCallNames: Set<string> | null;
  includeAutoHookIds: Set<string> | null;
  excludeAutoHookIds: Set<string> | null;
  responseStageGatePlan: Record<string, unknown>;
}): Promise<ServerSideToolEngineResult> {
  const baseForExecution = args.baseObject;
  const { dispatchPlan } = prepareServertoolDispatchStage({
    options: args.options,
    toolCalls: args.toolCalls,
    baseObject: args.baseObject,
    baseForExecution,
    includeToolCallNames: args.includeToolCallNames,
    excludeToolCallNames: args.excludeToolCallNames
  });

  const preExecutionBranchInput = {
    executableToolCalls: dispatchPlan.executableToolCalls,
    executedToolCallsLen: 0
  };
  const preExecutionBranchPlan = planServertoolExecutionBranchWithNative({
    executableToolCalls: preExecutionBranchInput.executableToolCalls.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      executionMode: toolCall.executionMode
    })),
    executedToolCallsLen: preExecutionBranchInput.executedToolCallsLen
  });
  if (preExecutionBranchPlan.action === 'client_exec_cli_projection') {
    return buildServertoolCliProjectionBranchResult({
      options: args.options,
      base: args.baseObject,
      executableToolCalls: dispatchPlan.executableToolCalls,
      projectedToolCallIndex: preExecutionBranchPlan.projectedToolCallIndex
    });
  }

  const executionState = await runServertoolIoExecutionQueue({
    dispatchPlan,
    options: args.options,
    contextBase: args.contextBase,
    baseForExecution
  });

  const postExecutionBranchInput = {
    executableToolCalls: dispatchPlan.executableToolCalls,
    executedToolCallsLen: executionState.executedToolCalls.length
  };
  const postExecutionBranchPlan = planServertoolExecutionBranchWithNative({
    executableToolCalls: postExecutionBranchInput.executableToolCalls.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      executionMode: toolCall.executionMode
    })),
    executedToolCallsLen: postExecutionBranchInput.executedToolCallsLen
  });
  if (postExecutionBranchPlan.action === 'resolve_execution_outcome') {
    return materializeNativeToolCallExecutionOutcome({
      baseForExecution,
      options: args.options,
      toolCalls: args.toolCalls,
      executionState
    });
  }

  return finalizeServertoolResponseStage({
    options: args.options,
    baseObject: args.baseObject,
    contextBase: args.contextBase as ServerToolHandlerContext,
    includeAutoHookIds: args.includeAutoHookIds,
    excludeAutoHookIds: args.excludeAutoHookIds,
    initialResponseStageGatePlan: args.responseStageGatePlan
  });
}
