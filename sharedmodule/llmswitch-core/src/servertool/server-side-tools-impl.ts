import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject, JsonValue } from '../conversion/hub/types/json.js';
import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext,
  ToolCall
} from './types.js';
import { readRuntimeMetadata } from '../conversion/runtime-metadata.js';
import { loadRoutingInstructionStateSync } from '../native/router-hotpath/native-virtual-router-routing-state.js';
import {
  collectServertoolAdditionalClientToolCallsWithNative,
  isServertoolClientExecCliProjectionToolCallWithNative,
  planServertoolResponseStageGateWithNative,
  planServertoolToolCallDispatchWithNative,
  runServertoolResponseStageWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import {
  applyPreCommandHooksToToolCalls,
  buildServertoolDispatchPlanInputThinShell,
  resolveToolCallExecutionOutcomeThinShell,
  runToolCallExecutionLoopThinShell
} from './execution-shell.js';
import { buildServertoolCliProjectionForToolCall } from './cli-projection.js';
import {
  buildServertoolCliProjectionExecutionContextWithNative,
  extractTextFromChatLikeWithNative,
  planServertoolEntryPreflightWithNative,
  planServertoolExecutionBranchWithNative,
  planRuntimePreCommandStateRuntimeActionWithNative,
  planServertoolResponseStageRuntimeActionWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  appendToolOutput,
  filterOutExecutedToolCalls,
  patchToolCallArgumentsById,
  replaceJsonObjectInPlace,
  stripToolOutputs
} from './orchestration-blocks.js';
import { runServertoolAutoHookCallerViaThinShell } from './auto-hook-caller.js';
import { resolveServertoolPersistentScopeKey } from './state-scope.js';
import {
  createServertoolProviderProtocolErrorFromPlan,
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

const runServerSideToolEngineViaThinShell = async (
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
  const toolCalls = extractToolCallsImpl(baseObject, options.requestId);
  const contextBase: Omit<ServerToolHandlerContext, 'toolCall'> = {
    base: baseObject,
    toolCalls,
    adapterContext: options.adapterContext,
    requestId: options.requestId,
    entryEndpoint: options.entryEndpoint,
    providerProtocol: options.providerProtocol,
    capabilities: {
      reenterPipeline: typeof options.reenterPipeline === 'function',
      providerInvoker: typeof options.providerInvoker === 'function'
    }
  };
  const includeToolCallNames = normalizeFilterTokenSet(options.includeToolCallHandlerNames);
  const excludeToolCallNames = normalizeFilterTokenSet(options.excludeToolCallHandlerNames);
  const includeAutoHookIds = normalizeFilterTokenSet(options.includeAutoHookIds);
  const excludeAutoHookIds = normalizeFilterTokenSet(options.excludeAutoHookIds);

  const baseForExecution = cloneJson(baseObject) as JsonObject;
  const runtimeMetadata = readRuntimeMetadata(options.adapterContext as unknown as Record<string, unknown>);
  const persistentScopeKey = resolveServertoolPersistentScopeKey(options.adapterContext);
  const runtimePreCommandState = (() => {
    const directRuntime = asObject((options.adapterContext as Record<string, unknown> | undefined)?.__rt);
    const runtimeActionBase = {
      directRuntimePreCommandState: directRuntime?.preCommandState,
      runtimeMetadataPreCommandState: (runtimeMetadata as Record<string, unknown> | undefined)?.preCommandState,
      hasPersistentScopeKey: Boolean(persistentScopeKey)
    };
    const initialAction = planRuntimePreCommandStateRuntimeActionWithNative({
      ...runtimeActionBase,
      persistedLoadAttempted: false
    });
    if (initialAction.action === 'use_selected') {
      return initialAction.state as JsonObject | undefined;
    }
    try {
      const persistedState = loadRoutingInstructionStateSync(persistentScopeKey);
      const persistedAction = planRuntimePreCommandStateRuntimeActionWithNative({
        ...runtimeActionBase,
        hasPersistentScopeKey: true,
        persistedState: persistedState ? (JSON.parse(JSON.stringify(persistedState)) as JsonObject) : undefined,
        persistedLoadAttempted: true
      });
      if (persistedAction.action !== 'use_selected') {
        throw new Error(
          `[servertool] invalid native pre-command runtime action after persisted load: ${String(persistedAction.action)}`
        );
      }
      return persistedAction.state as JsonObject | undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? 'unknown');
      const failedAction = planRuntimePreCommandStateRuntimeActionWithNative({
        ...runtimeActionBase,
        hasPersistentScopeKey: true,
        persistedLoadAttempted: true,
        persistedLoadError: message,
        requestId: options.requestId,
        stickyKey: persistentScopeKey ?? '',
        entryEndpoint: options.entryEndpoint,
        providerProtocol: options.providerProtocol
      });
      if (failedAction.action !== 'throw_state_load_failed' || !failedAction.errorPlan) {
        throw new Error(
          `[servertool] invalid native pre-command runtime action for persisted load error: ${String(failedAction.action)}`
        );
      }
      const wrapped = createServertoolProviderProtocolErrorFromPlan(
        failedAction.errorPlan
      ) as ReturnType<typeof createServertoolProviderProtocolErrorFromPlan> & { cause?: unknown };
      wrapped.status = 500;
      wrapped.cause = error;
      throw wrapped;
    }
  })();

  applyPreCommandHooksToToolCalls({
    options,
    toolCalls,
    runtimePreCommandState,
    bases: [baseObject, baseForExecution],
    patchToolCallArgumentsById
  });

  const dispatchPlan = planServertoolToolCallDispatchWithNative(
    buildServertoolDispatchPlanInputThinShell({
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
    const cliProjectedToolCall =
      typeof preExecutionBranchPlan.projectedToolCallIndex === 'number'
        ? dispatchPlan.executableToolCalls[preExecutionBranchPlan.projectedToolCallIndex]
        : undefined;
    if (!cliProjectedToolCall) {
      throw new Error(
        `[servertool] native execution-branch projected missing tool call index: ${String(preExecutionBranchPlan.projectedToolCallIndex ?? '')}`
      );
    }
    const additionalToolCalls = collectAdditionalClientToolCallsImpl(baseObject, cliProjectedToolCall.id);
    const projection = buildServertoolCliProjectionForToolCall({
      options,
      toolCall: cliProjectedToolCall,
      ...(additionalToolCalls.length ? { additionalToolCalls } : {}),
      reasoningText: `继续执行本地 hook ${cliProjectedToolCall.name}。`
    });
    const execution = buildServertoolCliProjectionExecutionContextWithNative({
      requestId: options.requestId,
      clientCallId: projection.clientCallId,
      toolName: projection.toolName
    });
    return {
      mode: 'tool_flow',
      finalChatResponse: projection.chatResponse,
      execution: execution as {
        flowId: string;
        context?: JsonObject;
      }
    };
  }

  const executionState = await runToolCallExecutionLoopThinShell({
    dispatchPlan,
    options,
    contextBase,
    baseForExecution,
    appendToolOutput
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
    return resolveToolCallExecutionOutcomeThinShell({
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

  const responseStagePlan = planServertoolResponseStageGateWithNative({
    payload: baseObject,
    adapterContext: options.adapterContext as Record<string, unknown>,
    capabilities: {
      providerInvoker: typeof options.providerInvoker === 'function',
      reenterPipeline: typeof options.reenterPipeline === 'function',
      clientInjectDispatch: false
    }
  });
  const preAutoHookRuntimeAction = planServertoolResponseStageRuntimeActionWithNative({
    responseStageGatePlan: responseStagePlan,
    autoHookEvaluated: false,
    hasAutoHookResult: false
  });
  if (preAutoHookRuntimeAction.action === 'return_passthrough_bypass') {
    return { mode: 'passthrough', finalChatResponse: baseObject };
  }
  const autoHookResult = await runServertoolAutoHookCallerImpl({
    options,
    contextBase: contextBase as ServerToolHandlerContext,
    includeAutoHookIds,
    excludeAutoHookIds
  });
  const postAutoHookRuntimeAction = planServertoolResponseStageRuntimeActionWithNative({
    responseStageGatePlan: responseStagePlan,
    autoHookEvaluated: true,
    hasAutoHookResult: Boolean(autoHookResult)
  });
  if (postAutoHookRuntimeAction.action === 'return_auto_hook_result') {
    return autoHookResult as ServerSideToolEngineResult;
  }
  return { mode: 'passthrough', finalChatResponse: baseObject };
};

const runServertoolAutoHookCallerViaImplThinShell = async (args: {
  options: ServerSideToolEngineOptions;
  contextBase: ServerToolHandlerContext;
  includeAutoHookIds: Set<string> | null;
  excludeAutoHookIds: Set<string> | null;
}): Promise<ServerSideToolEngineResult | null> => {
  return await runServertoolAutoHookCallerViaThinShell(args);
};

export function isClientExecCliProjectionToolCall(toolCall: ToolCall & { executionMode?: string }): boolean {
  return isServertoolClientExecCliProjectionToolCallWithNative({
    executionMode: toolCall.executionMode
  });
}

const collectAdditionalClientToolCallsViaImplThinShell = (base: JsonObject, projectedToolCallId: string): JsonValue[] => {
  return collectServertoolAdditionalClientToolCallsWithNative({
    base,
    projectedToolCallId
  }) as JsonValue[];
};

const extractToolCallsViaImplThinShell = (chatResponse: JsonObject, requestId = ''): ToolCall[] => {
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

function getArray(value: unknown): JsonValue[] {
  return Array.isArray(value) ? (value as JsonValue[]) : [];
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function extractTextFromChatLike(payload: JsonObject): string {
  return extractTextFromChatLikeWithNative(payload);
}

export function bindServertoolContractWithNative<T>(value: T): T {
  return value;
}

export const runServerSideToolEngineImpl = runServerSideToolEngineViaThinShell;
export const runServertoolAutoHookCallerImpl = runServertoolAutoHookCallerViaImplThinShell;
export const collectAdditionalClientToolCallsImpl = collectAdditionalClientToolCallsViaImplThinShell;
export const extractToolCallsImpl = extractToolCallsViaImplThinShell;
