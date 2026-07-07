import type {
  JsonObject,
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext,
  ToolCall
} from './types.js';
import { runServertoolIoExecutionQueue } from './execution-queue-shell.js';
import {
  buildServertoolDispatchPlanInputWithNative,
  buildServertoolCliProjectionRuntimeBranchWithNative,
  finalizeServertoolResponseStageWithNative,
  materializeNativeToolCallExecutionOutcomeWithNative as materializeNativeToolCallExecutionOutcome,
  planServertoolToolCallDispatchWithNative,
  resolveServertoolResponseStageAutoHookPostApplicationWithNative,
  resolveServertoolResponseStageAutoHookPostDecisionWithNative,
  resolveServertoolResponseStageAutoHookPreApplicationWithNative,
  resolveServertoolResponseStageAutoHookPreDecisionWithNative,
  resolveServertoolPostExecutionBranchDecisionWithNative,
  resolveServertoolPreExecutionBranchDecisionWithNative
} from 'rcc-llmswitch-core/native/servertool-wrapper';
import type { NativeServertoolResponseStageGate } from 'rcc-llmswitch-core/native/servertool-wrapper';
import {
  readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter
} from './metadata-center-carrier.js';
import { runServertoolAutoHookCaller } from './auto-hook-caller.js';
import { createServertoolProviderProtocolErrorFromPlan } from './timeout-error-block.js';

export type ServertoolResponseStageAutoHookPassResult =
  | { action: 'return_passthrough_bypass'; result?: never }
  | { action: 'continue_without_result'; result?: never }
  | { action: 'return_auto_hook_result'; result: ServerSideToolEngineResult };

export async function runServertoolResponseStageAutoHookPass(args: {
  options: ServerSideToolEngineOptions;
  contextBase: Omit<ServerToolHandlerContext, 'toolCall'>;
  includeAutoHookIds: Set<string> | null;
  excludeAutoHookIds: Set<string> | null;
  responseStageGatePlan: NativeServertoolResponseStageGate;
  baseObject: JsonObject;
}): Promise<ServertoolResponseStageAutoHookPassResult> {
  const preAutoHookDecision = resolveServertoolResponseStageAutoHookPreDecisionWithNative({
    responseStageGatePlan: args.responseStageGatePlan,
    baseObject: args.baseObject
  });
  const preAutoHookApplication = resolveServertoolResponseStageAutoHookPreApplicationWithNative({
    decision: preAutoHookDecision
  });
  if (preAutoHookApplication.returnPassResult) {
    return preAutoHookApplication.result;
  }
  if (!preAutoHookApplication.runAutoHooks) {
    throw new Error('[servertool] invalid response-stage pre auto-hook application');
  }

  const autoHookResult = await runServertoolAutoHookCaller({
    options: args.options,
    contextBase: args.contextBase,
    includeAutoHookIds: args.includeAutoHookIds,
    excludeAutoHookIds: args.excludeAutoHookIds
  });
  const postAutoHookDecision = resolveServertoolResponseStageAutoHookPostDecisionWithNative({
    requestId: args.options.requestId,
    responseStageGatePlan: args.responseStageGatePlan,
    baseObject: args.baseObject,
    autoHookResult
  });
  const postAutoHookApplication = resolveServertoolResponseStageAutoHookPostApplicationWithNative({
    decision: postAutoHookDecision
  });
  if (postAutoHookApplication.throwRequiredResponseHookEmpty) {
    throw createServertoolProviderProtocolErrorFromPlan(postAutoHookApplication.errorPlan);
  }
  if (!postAutoHookApplication.returnPassResult) {
    throw new Error('[servertool] invalid response-stage post auto-hook application');
  }
  return postAutoHookApplication.result;
}

async function applyServertoolResponseStageFinalize(args: {
  options: ServerSideToolEngineOptions;
  baseObject: JsonObject;
  contextBase: Omit<ServerToolHandlerContext, 'toolCall'>;
  includeAutoHookIds: Set<string> | null;
  excludeAutoHookIds: Set<string> | null;
  responseStageGatePlan: NativeServertoolResponseStageGate;
}): Promise<ServerSideToolEngineResult> {
  const responseStageAutoHook = await runServertoolResponseStageAutoHookPass({
    options: args.options,
    contextBase: args.contextBase,
    includeAutoHookIds: args.includeAutoHookIds,
    excludeAutoHookIds: args.excludeAutoHookIds,
    responseStageGatePlan: args.responseStageGatePlan,
    baseObject: args.baseObject
  });
  return finalizeServertoolResponseStageWithNative({
    responseStageGatePlan: args.responseStageGatePlan,
    baseObject: args.baseObject,
    responseStageAutoHookResult: responseStageAutoHook
  });
}

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
  return applyServertoolResponseStageFinalize({
    options: args.options,
    baseObject: args.baseObject,
    contextBase: args.contextBase,
    includeAutoHookIds: args.includeAutoHookIds,
    excludeAutoHookIds: args.excludeAutoHookIds,
    responseStageGatePlan: args.responseStageGatePlan
  });
}
