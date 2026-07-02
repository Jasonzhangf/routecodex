import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext,
  ToolCall
} from './types.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { prepareServertoolDispatchStage } from './dispatch-preparation-shell.js';
import { runServertoolIoExecutionQueue } from './execution-queue-shell.js';
import { materializeNativeToolCallExecutionOutcome } from './execution-handler-materialization-shell.js';
import { finalizeServertoolResponseStage } from './response-stage-finalize-shell.js';
import {
  buildServertoolCliProjectionRuntimeBranchWithNative,
  planServertoolExecutionBranchWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import type { NativeServertoolResponseStageGate } from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';

export async function runServertoolExecutionStage(args: {
  options: ServerSideToolEngineOptions;
  baseObject: JsonObject;
  toolCalls: ToolCall[];
  contextBase: Omit<ServerToolHandlerContext, 'toolCall'>;
  includeToolCallNames: Set<string> | null;
  excludeToolCallNames: Set<string> | null;
  includeAutoHookIds: Set<string> | null;
  excludeAutoHookIds: Set<string> | null;
  responseStageGatePlan: NativeServertoolResponseStageGate;
}): Promise<ServerSideToolEngineResult> {
  const { dispatchPlan } = prepareServertoolDispatchStage({
    options: args.options,
    toolCalls: args.toolCalls,
    includeToolCallNames: args.includeToolCallNames,
    excludeToolCallNames: args.excludeToolCallNames
  });

  const preExecutionBranchPlan = planServertoolExecutionBranchWithNative({
    executableToolCalls: dispatchPlan.executableToolCalls,
    executedToolCallsLen: 0
  });
  switch (preExecutionBranchPlan.action) {
    case 'client_exec_cli_projection': {
      const projectedToolCall = preExecutionBranchPlan.projectedToolCall;
      const branch = buildServertoolCliProjectionRuntimeBranchWithNative({
        requestId: args.options.requestId,
        toolName: projectedToolCall.name,
        toolArguments: projectedToolCall.arguments,
        projectedToolCallId: projectedToolCall.id,
        base: args.baseObject
      });
      return {
        mode: branch.resultMode,
        finalChatResponse: branch.chatResponse,
        execution: branch.execution
      };
    }
    case 'continue_response_stage':
      break;
    default:
      throw new Error('[servertool] invalid pre-execution branch action');
  }

  const executionState = await runServertoolIoExecutionQueue({
    dispatchPlan,
    options: args.options,
    contextBase: args.contextBase,
    baseForExecution: args.baseObject
  });

  const postExecutionBranchPlan = planServertoolExecutionBranchWithNative({
    executableToolCalls: dispatchPlan.executableToolCalls,
    executedToolCallsLen: executionState.executedToolCalls.length
  });
  switch (postExecutionBranchPlan.action) {
    case 'resolve_execution_outcome':
      return materializeNativeToolCallExecutionOutcome({
        baseForExecution: args.baseObject,
        options: args.options,
        toolCalls: args.toolCalls,
        executionState
      });
    case 'continue_response_stage':
      return finalizeServertoolResponseStage({
        options: args.options,
        baseObject: args.baseObject,
        contextBase: args.contextBase,
        includeAutoHookIds: args.includeAutoHookIds,
        excludeAutoHookIds: args.excludeAutoHookIds,
        responseStageGatePlan: args.responseStageGatePlan
      });
    default:
      throw new Error('[servertool] invalid post-execution branch action');
  }
}
