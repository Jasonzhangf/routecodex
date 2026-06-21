import type { JsonObject } from '../conversion/hub/types/json.js';
import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext,
  ToolCall
} from './types.js';
import {
  planServertoolResponseStageGateWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import {
  runServertoolIoExecutionQueue
} from './execution-dispatch-outcome-shell.js';
import { materializeNativeToolCallExecutionOutcome } from './execution-handler-materialization-shell.js';
import {
  extractTextFromChatLikeWithNative,
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  filterOutExecutedToolCalls,
  stripToolOutputs
} from './orchestration-blocks.js';
import { runServertoolResponseStageAutoHookPass } from './response-stage-auto-hook-shell.js';
import { finalizeServertoolResponseStage } from './response-stage-finalize-shell.js';
import { extractToolCallsFromResponseStage } from './extract-tool-calls-shell.js';
import { prepareServertoolDispatchStage } from './dispatch-preparation-shell.js';
import {
  buildServertoolCliProjectionBranchResult
} from './cli-projection-runtime-shell.js';
import { planServertoolExecutionBranchRuntimeAction } from './execution-branch-runtime-shell.js';
import { runServertoolEntryPreflight } from './entry-preflight-shell.js';

function normalizeFilterTokenSet(values: string[] | undefined): Set<string> | null {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const normalized = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== 'string') {
      continue;
    }
    const value = raw.trim().toLowerCase();
    if (!value) {
      continue;
    }
    normalized.add(value);
  }
  return normalized.size > 0 ? normalized : null;
}

export const runServerSideToolEngine = async (
  options: ServerSideToolEngineOptions
): Promise<ServerSideToolEngineResult> => {
  const base = asObject(options.chatResponse);
  const entryPreflight = runServertoolEntryPreflight({
    options,
    base
  });
  if (entryPreflight.action === 'return_result') {
    return entryPreflight.result;
  }
  const baseObject = entryPreflight.baseObject;
  const toolCalls = extractToolCallsFromResponseStage(baseObject, options.requestId);
  const contextBase: Omit<ServerToolHandlerContext, 'toolCall'> = {
    base: baseObject,
    toolCalls,
    adapterContext: options.adapterContext,
    requestId: options.requestId,
    entryEndpoint: options.entryEndpoint,
    providerProtocol: options.providerProtocol
  };
  const includeToolCallNames = normalizeFilterTokenSet(options.includeToolCallHandlerNames);
  const excludeToolCallNames = normalizeFilterTokenSet(options.excludeToolCallHandlerNames);
  const includeAutoHookIds = normalizeFilterTokenSet(options.includeAutoHookIds);
  const excludeAutoHookIds = normalizeFilterTokenSet(options.excludeAutoHookIds);
  const responseHookStagePlan = planServertoolResponseStageGateWithNative({
    payload: baseObject,
    adapterContext: options.adapterContext as Record<string, unknown>
  });
  if (responseHookStagePlan.responseHookMatched) {
    const responseStageAutoHook = await runServertoolResponseStageAutoHookPass({
      options,
      contextBase: contextBase as ServerToolHandlerContext,
      includeAutoHookIds,
      excludeAutoHookIds,
      responseStageGatePlan: responseHookStagePlan as Record<string, unknown>
    });
    if (responseStageAutoHook.action === 'return_auto_hook_result') {
      return responseStageAutoHook.result;
    }
  }

  const baseForExecution = structuredClone(baseObject);
  const { dispatchPlan } = prepareServertoolDispatchStage({
    options,
    toolCalls,
    baseObject,
    baseForExecution,
    includeToolCallNames,
    excludeToolCallNames
  });

  const preExecutionBranchPlan = planServertoolExecutionBranchRuntimeAction({
    executableToolCalls: dispatchPlan.executableToolCalls,
    executedToolCallsLen: 0
  });
  if (preExecutionBranchPlan.action === 'client_exec_cli_projection') {
    return buildServertoolCliProjectionBranchResult({
      options,
      base: baseObject,
      executableToolCalls: dispatchPlan.executableToolCalls,
      projectedToolCallIndex: preExecutionBranchPlan.projectedToolCallIndex
    });
  }

  const executionState = await runServertoolIoExecutionQueue({
    dispatchPlan,
    options,
    contextBase,
    baseForExecution
  });

  const postExecutionBranchPlan = planServertoolExecutionBranchRuntimeAction({
    executableToolCalls: dispatchPlan.executableToolCalls,
    executedToolCallsLen: executionState.executedToolCalls.length
  });
  if (postExecutionBranchPlan.action === 'resolve_execution_outcome') {
    return materializeNativeToolCallExecutionOutcome({
      base: baseObject,
      baseForExecution,
      options,
      toolCalls,
      executionState,
      filterOutExecutedToolCalls,
      stripToolOutputs,
      pendingInjectionMessageKinds: []
    });
  }

  return finalizeServertoolResponseStage({
    options,
    baseObject,
    contextBase: contextBase as ServerToolHandlerContext,
    includeAutoHookIds,
    excludeAutoHookIds,
    initialResponseStageGatePlan: responseHookStagePlan as Record<string, unknown>
  });
};

export const extractToolCalls = (chatResponse: JsonObject, requestId = ''): ToolCall[] => {
  return extractToolCallsFromResponseStage(chatResponse, requestId);
};

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

export function extractTextFromChatLike(payload: JsonObject): string {
  return extractTextFromChatLikeWithNative(payload);
}
