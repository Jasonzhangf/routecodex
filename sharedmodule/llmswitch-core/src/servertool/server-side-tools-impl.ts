import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject, JsonValue } from '../conversion/hub/types/json.js';
import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext,
  ToolCall
} from './types.js';
import { ProviderProtocolError } from '../conversion/provider-protocol-error.js';
import { readRuntimeMetadata } from '../conversion/runtime-metadata.js';
import { loadRoutingInstructionStateSync } from '../native/router-hotpath/native-virtual-router-routing-state.js';
import {
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
import { extractTextFromChatLikeWithNative } from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  appendToolOutput,
  filterOutExecutedToolCalls,
  patchToolCallArgumentsById,
  replaceJsonObjectInPlace,
  stripToolOutputs
} from './orchestration-blocks.js';
import { runServertoolAutoHookCallerViaThinShell } from './auto-hook-caller.js';
import { resolveServertoolPersistentScopeKey } from './state-scope.js';
import { isAdapterClientDisconnected } from './timeout-error-block.js';

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
  if (!base) {
    return { mode: 'passthrough', finalChatResponse: options.chatResponse };
  }

  if (isAdapterClientDisconnected(options.adapterContext)) {
    throw Object.assign(new Error('[servertool] client disconnected before servertool execution'), {
      code: 'SERVERTOOL_CLIENT_DISCONNECTED',
      details: { requestId: options.requestId }
    });
  }
  const toolCalls = extractToolCallsImpl(base, options.requestId);
  const contextBase: Omit<ServerToolHandlerContext, 'toolCall'> = {
    base,
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

  const baseForExecution = cloneJson(base) as JsonObject;
  const runtimeMetadata = readRuntimeMetadata(options.adapterContext as unknown as Record<string, unknown>);
  const runtimePreCommandState = (() => {
    const directRuntime = asObject((options.adapterContext as Record<string, unknown> | undefined)?.__rt);
    const runtimeState =
      asObject(directRuntime?.preCommandState) ??
      asObject((runtimeMetadata as Record<string, unknown> | undefined)?.preCommandState);
    if (runtimeState) {
      return runtimeState;
    }
    const persistentScopeKey = resolveServertoolPersistentScopeKey(options.adapterContext);
    if (!persistentScopeKey) {
      return undefined;
    }
    try {
      const persistedState = loadRoutingInstructionStateSync(persistentScopeKey);
      return persistedState ? (JSON.parse(JSON.stringify(persistedState)) as JsonObject) : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? 'unknown');
      const wrapped = new ProviderProtocolError(`[servertool] sticky routing state load failed: ${persistentScopeKey}: ${message}`, {
        code: 'SERVERTOOL_STATE_LOAD_FAILED',
        category: 'INTERNAL_ERROR',
        details: {
          stickyKey: persistentScopeKey,
          requestId: options.requestId,
          entryEndpoint: options.entryEndpoint,
          providerProtocol: options.providerProtocol,
          error: message
        }
      }) as ProviderProtocolError & { status?: number; cause?: unknown };
      wrapped.status = 500;
      wrapped.cause = error;
      throw wrapped;
    }
  })();

  applyPreCommandHooksToToolCalls({
    options,
    toolCalls,
    runtimePreCommandState,
    bases: [base, baseForExecution],
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

  const cliProjectedToolCall = dispatchPlan.executableToolCalls.find(isClientExecCliProjectionToolCall);
  if (cliProjectedToolCall) {
    const additionalToolCalls = collectAdditionalClientToolCallsImpl(base, cliProjectedToolCall.id);
    const projection = buildServertoolCliProjectionForToolCall({
      options,
      toolCall: cliProjectedToolCall,
      ...(additionalToolCalls.length ? { additionalToolCalls } : {}),
      reasoningText: `继续执行本地 hook ${cliProjectedToolCall.name}。`
    });
    return {
      mode: 'tool_flow',
      finalChatResponse: projection.chatResponse,
      execution: {
        flowId: 'servertool_cli_projection',
        context: {
          servertoolCliProjection: {
            clientCallId: projection.clientCallId,
            toolName: projection.toolName,
            requestId: options.requestId
          } as JsonObject
        }
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

  if (executionState.executedToolCalls.length > 0) {
    return resolveToolCallExecutionOutcomeThinShell({
      base,
      baseForExecution,
      options,
      toolCalls,
      executionState,
      filterOutExecutedToolCalls,
      stripToolOutputs,
      pendingInjectionMessageKinds: []
    });
  }

  const responseStageGatePlan = planServertoolResponseStageGateWithNative({
    payload: base,
    adapterContext: options.adapterContext as Record<string, unknown>,
    hasServertoolSupport:
      typeof options.providerInvoker === 'function' || typeof options.reenterPipeline === 'function'
  });
  if (responseStageGatePlan?.shouldBypass === true) {
    return { mode: 'passthrough', finalChatResponse: base };
  }
  const autoHookResult = await runServertoolAutoHookCallerImpl({
    options,
    contextBase: contextBase as ServerToolHandlerContext,
    includeAutoHookIds,
    excludeAutoHookIds
  });
  return autoHookResult ?? { mode: 'passthrough', finalChatResponse: base };
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
  const executionMode = typeof toolCall.executionMode === 'string' ? toolCall.executionMode.trim() : '';
  return executionMode === 'client_exec_cli_projection';
}

const collectAdditionalClientToolCallsViaImplThinShell = (base: JsonObject, projectedToolCallId: string): JsonValue[] => {
  const choices = getArray((base as { choices?: unknown }).choices);
  const first = asObject(choices[0]);
  const message = asObject(first?.message);
  const toolCalls = getArray((message as { tool_calls?: unknown } | null)?.tool_calls);
  return toolCalls.filter((toolCall) => {
    const row = asObject(toolCall);
    if (!row) {
      return false;
    }
    const id = typeof row.id === 'string' ? row.id : '';
    if (!id || id === projectedToolCallId) {
      return false;
    }
    const functionRow = asObject((row as { function?: unknown }).function);
    const name = typeof functionRow?.name === 'string' ? functionRow.name.trim() : '';
    return name !== 'stop_message_auto';
  });
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
