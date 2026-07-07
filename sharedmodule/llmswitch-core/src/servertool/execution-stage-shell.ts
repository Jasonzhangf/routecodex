import type {
  JsonObject,
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext,
  ToolCall
} from './types.js';
import { runServertoolIoExecutionQueue } from './execution-queue-shell.js';
import { finalizeServertoolResponseStage } from './response-stage-finalize-shell.js';
import {
  buildServertoolDispatchPlanInputWithNative,
  buildServertoolCliProjectionRuntimeBranchWithNative,
  materializeNativeToolCallExecutionOutcomeWithNative as materializeNativeToolCallExecutionOutcome,
  planServertoolToolCallDispatchWithNative,
  resolveServertoolPostExecutionBranchDecisionWithNative,
  resolveServertoolPreExecutionBranchDecisionWithNative
} from 'rcc-llmswitch-core/native/servertool-wrapper';
import type { NativeServertoolResponseStageGate } from 'rcc-llmswitch-core/native/servertool-wrapper';
import {
  readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter
} from './metadata-center-carrier.js';

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
  const runtimeMetadata = readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter(
    args.options.adapterContext
  );
  const dispatchPlan = planServertoolToolCallDispatchWithNative(
    buildServertoolDispatchPlanInputWithNative({
      toolCalls: args.toolCalls,
      disableToolCallHandlers: args.options.disableToolCallHandlers === true,
      includeToolCallHandlerNames: args.includeToolCallNames != null ? [...args.includeToolCallNames] : null,
      excludeToolCallHandlerNames: args.excludeToolCallNames != null ? [...args.excludeToolCallNames] : null,
      runtimeMetadata
    })
  );

  const preExecutionBranchDecision = resolveServertoolPreExecutionBranchDecisionWithNative({
    executableToolCalls: dispatchPlan.executableToolCalls
  });
  if (preExecutionBranchDecision.projectClientExecCli) {
    const projectedToolCall = preExecutionBranchDecision.projectedToolCall;
    const branch = buildServertoolCliProjectionRuntimeBranchWithNative({
      requestId: args.options.requestId,
      toolName: projectedToolCall.name,
      toolArguments: projectedToolCall.arguments,
      projectedToolCallId: projectedToolCall.id,
      base: args.baseObject
    });
    return branch.result as unknown as ServerSideToolEngineResult;
  }
  if (!preExecutionBranchDecision.continueResponseStage) {
    throw new Error('[servertool] invalid pre-execution branch action');
  }

  const executionState = await runServertoolIoExecutionQueue({
    dispatchPlan,
    options: args.options,
    contextBase: args.contextBase,
    baseForExecution: args.baseObject
  });

  const postExecutionBranchDecision = resolveServertoolPostExecutionBranchDecisionWithNative({
    executableToolCalls: dispatchPlan.executableToolCalls,
    executedToolCallsLen: executionState.executedToolCalls.length
  });
  if (postExecutionBranchDecision.resolveExecutionOutcome) {
    return materializeNativeToolCallExecutionOutcome({
      baseForExecution: args.baseObject,
      options: args.options,
      toolCalls: args.toolCalls,
      executionState
    });
  }
  if (!postExecutionBranchDecision.continueResponseStage) {
    throw new Error('[servertool] invalid post-execution branch action');
  }
  return finalizeServertoolResponseStage({
    options: args.options,
    baseObject: args.baseObject,
    contextBase: args.contextBase,
    includeAutoHookIds: args.includeAutoHookIds,
    excludeAutoHookIds: args.excludeAutoHookIds,
    responseStageGatePlan: args.responseStageGatePlan
  });
}
