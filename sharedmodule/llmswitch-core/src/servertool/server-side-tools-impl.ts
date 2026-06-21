import type { JsonObject, JsonValue } from '../conversion/hub/types/json.js';
import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext,
  ToolCall
} from './types.js';
import { readRuntimeMetadata } from '../conversion/runtime-metadata.js';
import {
  collectServertoolAdditionalClientToolCallsWithNative,
  isServertoolClientExecCliProjectionToolCallWithNative,
  planServertoolResponseStageGateWithNative,
  planServertoolToolCallDispatchWithNative,
  runServertoolResponseStageWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import {
  applyPreCommandHooksToToolCalls,
} from './pre-command-hooks.js';
import {
  buildServertoolDispatchPlanInput,
  runServertoolIoExecutionQueue
} from './execution-dispatch-outcome-shell.js';
import { materializeNativeToolCallExecutionOutcome } from './execution-handler-materialization-shell.js';
import {
  extractTextFromChatLikeWithNative,
  planServertoolEntryPreflightWithNative,
  planServertoolExecutionBranchWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  filterOutExecutedToolCalls,
  patchToolCallArgumentsById,
  replaceJsonObjectInPlace,
  stripToolOutputs
} from './orchestration-blocks.js';
import { resolveServertoolRuntimePreCommandState } from './pre-command-runtime-state-shell.js';
import { runServertoolResponseStageAutoHookPass } from './response-stage-auto-hook-shell.js';
import {
  buildServertoolCliProjectionBranchResult,
  collectAdditionalClientToolCalls,
  isClientExecCliProjectionToolCall
} from './cli-projection-runtime-shell.js';
import {
  createServerToolClientDisconnectedError,
  isAdapterClientDisconnected
} from './timeout-error-block.js';

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
  const entryPreflightPlan = planServertoolEntryPreflightWithNative({
    hasBaseObject: Boolean(base),
    adapterClientDisconnected: isAdapterClientDisconnected(options.adapterContext)
  });
  if (entryPreflightPlan.action === 'return_passthrough_non_object_chat') {
    return { mode: 'passthrough', finalChatResponse: options.chatResponse };
  }
  if (entryPreflightPlan.action === 'throw_client_disconnected') {
    throw createServerToolClientDisconnectedError({
      requestId: options.requestId
    });
  }
  const baseObject = base as JsonObject;
  const toolCalls = extractToolCalls(baseObject, options.requestId);
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
  const runtimeMetadata = readRuntimeMetadata(options.adapterContext as unknown as Record<string, unknown>);
  const runtimePreCommandState = resolveServertoolRuntimePreCommandState({
    adapterContext: options.adapterContext,
    runtimeMetadata,
    requestId: options.requestId,
    entryEndpoint: options.entryEndpoint,
    providerProtocol: options.providerProtocol
  });

  applyPreCommandHooksToToolCalls({
    options,
    toolCalls,
    runtimePreCommandState,
    bases: [baseObject, baseForExecution],
    patchToolCallArgumentsById
  });

  const dispatchPlan = planServertoolToolCallDispatchWithNative(
    buildServertoolDispatchPlanInput({
      toolCalls,
      disableToolCallHandlers: options.disableToolCallHandlers === true,
      ...(includeToolCallNames ? { includeToolCallHandlerNames: [...includeToolCallNames] } : {}),
      ...(excludeToolCallNames ? { excludeToolCallHandlerNames: [...excludeToolCallNames] } : {}),
      runtimeMetadata
    })
  );

  const preExecutionBranchPlan = planServertoolExecutionBranchWithNative({
    executableToolCalls: dispatchPlan.executableToolCalls.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      executionMode: toolCall.executionMode
    })),
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

  const postExecutionBranchPlan = planServertoolExecutionBranchWithNative({
    executableToolCalls: dispatchPlan.executableToolCalls.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      executionMode: toolCall.executionMode
    })),
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

  const responseStagePlan = responseHookStagePlan.responseHookMatched ? responseHookStagePlan : planServertoolResponseStageGateWithNative({
    payload: baseObject,
    adapterContext: options.adapterContext as Record<string, unknown>
  });
  const responseStageAutoHook = await runServertoolResponseStageAutoHookPass({
    options,
    contextBase: contextBase as ServerToolHandlerContext,
    includeAutoHookIds,
    excludeAutoHookIds,
    responseStageGatePlan: responseStagePlan as Record<string, unknown>
  });
  if (responseStageAutoHook.action === 'return_passthrough_bypass') {
    return { mode: 'passthrough', finalChatResponse: baseObject };
  }
  if (responseStageAutoHook.action === 'return_auto_hook_result') {
    return responseStageAutoHook.result;
  }
  return { mode: 'passthrough', finalChatResponse: baseObject };
};

export const extractToolCalls = (chatResponse: JsonObject, requestId = ''): ToolCall[] => {
  const stage = runServertoolResponseStageWithNative(chatResponse, requestId);
  const normalizedPayload = asObject(stage.normalizedPayload) ?? chatResponse;
  replaceJsonObjectInPlace(chatResponse, normalizedPayload);
  return stage.toolCalls.map((entry) => ({
    id: entry.id,
    name: entry.name,
    arguments: entry.arguments
  }));
};

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

export function extractTextFromChatLike(payload: JsonObject): string {
  return extractTextFromChatLikeWithNative(payload);
}
