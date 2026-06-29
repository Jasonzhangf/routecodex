import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext,
  ToolCall
} from './types.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { prepareServertoolDispatchStage } from './dispatch-preparation-shell.js';
import { planServertoolExecutionBranchRuntimeAction } from './execution-branch-runtime-shell.js';
import { buildServertoolCliProjectionBranchResult } from './cli-projection-runtime-shell.js';
import { runServertoolIoExecutionQueue } from './execution-queue-shell.js';
import { materializeNativeToolCallExecutionOutcome } from './execution-handler-materialization-shell.js';
import { filterOutExecutedToolCalls, stripToolOutputs } from './orchestration-blocks.js';
import { finalizeServertoolResponseStage } from './response-stage-finalize-shell.js';

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

  const preExecutionBranchPlan = planServertoolExecutionBranchRuntimeAction({
    executableToolCalls: dispatchPlan.executableToolCalls,
    executedToolCallsLen: 0
  });
  const projectedPreExecutionToolCall =
    typeof preExecutionBranchPlan.projectedToolCallIndex === 'number'
      ? dispatchPlan.executableToolCalls[preExecutionBranchPlan.projectedToolCallIndex]
      : undefined;
  const isStopMessageAutoPreProjection = projectedPreExecutionToolCall?.name === 'stop_message_auto';
  if (preExecutionBranchPlan.action === 'client_exec_cli_projection' && !isStopMessageAutoPreProjection) {
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

  const postExecutionBranchPlan = planServertoolExecutionBranchRuntimeAction({
    executableToolCalls: dispatchPlan.executableToolCalls,
    executedToolCallsLen: executionState.executedToolCalls.length
  });
  if (postExecutionBranchPlan.action === 'resolve_execution_outcome') {
    return materializeNativeToolCallExecutionOutcome({
      base: args.baseObject,
      baseForExecution,
      options: args.options,
      toolCalls: args.toolCalls,
      executionState,
      filterOutExecutedToolCalls,
      stripToolOutputs,
      pendingInjectionMessageKinds: []
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
