import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject, JsonValue } from '../conversion/hub/types/json.js';
import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext,
  ToolCall
} from './types.js';
import {
  listAutoServerToolHooks
} from './registry.js';
import { ProviderProtocolError } from '../conversion/provider-protocol-error.js';
import './handlers/stop-message-auto.js';
import './handlers/vision.js';
import './handlers/fixture.js';
import { readRuntimeMetadata } from '../conversion/runtime-metadata.js';
import { loadRoutingInstructionStateSync } from '../native/router-hotpath/native-virtual-router-routing-state.js';
import {
  detectEmptyAssistantPayloadContractSignalWithNative,
  planServertoolToolCallDispatchWithNative,
  runServertoolResponseStageWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import {
  applyPreCommandHooksToToolCalls,
  buildServertoolDispatchPlanInput,
  resolveToolCallExecutionOutcome,
  runAutoHookExecutionQueue,
  runToolCallExecutionLoop
} from './execution-shell.js';
import { buildServertoolCliProjectionForToolCall } from './cli-projection.js';
import { extractTextFromChatLikeWithNative } from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  appendToolOutput,
  buildAutoHookQueuesFromConfig,
  filterOutExecutedToolCalls,
  patchToolCallArgumentsById,
  replaceJsonObjectInPlace,
  stripToolOutputs
} from './orchestration-blocks.js';
import { resolveServertoolPersistentScopeKey } from './state-scope.js';
import { isStopEligibleForServerTool } from './stop-gateway-context.js';

type AutoHookQueueName = 'A_optional' | 'B_mandatory';
type AutoHookDescriptor = ReturnType<typeof listAutoServerToolHooks>[number];

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

export async function runServerSideToolEngine(
  options: ServerSideToolEngineOptions
): Promise<ServerSideToolEngineResult> {
  const base = asObject(options.chatResponse);
  if (!base) {
    return { mode: 'passthrough', finalChatResponse: options.chatResponse };
  }

  if (isClientDisconnected(options.adapterContext)) {
    throw Object.assign(new Error('[servertool] client disconnected before servertool execution'), {
      code: 'SERVERTOOL_CLIENT_DISCONNECTED',
      details: { requestId: options.requestId }
    });
  }
  const toolCalls = extractToolCalls(base, options.requestId);
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

  // Tool-call servertools: execute all executable servertool calls first, then decide:
  // - if only servertools were present -> followup via reenter (existing behavior)
  // - if mixed (servertool + client tools) -> persist servertool results, return remaining tool_calls to client
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
    buildServertoolDispatchPlanInput({
      toolCalls,
      disableToolCallHandlers: options.disableToolCallHandlers === true,
      ...(includeToolCallNames ? { includeToolCallHandlerNames: [...includeToolCallNames] } : {}),
      ...(excludeToolCallNames ? { excludeToolCallHandlerNames: [...excludeToolCallNames] } : {}),
      runtimeMetadata
    })
  );

  const cliProjectedToolCall = dispatchPlan.executableToolCalls.find(isClientExecCliProjectionToolCall);
  if (cliProjectedToolCall) {
    const additionalToolCalls = collectAdditionalClientToolCalls(base, cliProjectedToolCall.id);
    const projection = buildServertoolCliProjectionForToolCall({
      options,
      toolCall: cliProjectedToolCall,
      ...(additionalToolCalls.length ? { additionalToolCalls } : {}),
      reasoningText: `RouteCodex intercepted servertool ${cliProjectedToolCall.name} and will execute it through the client-visible CLI path.`
    });
    return {
      mode: 'tool_flow',
      finalChatResponse: projection.chatResponse,
      execution: {
        flowId: 'servertool_cli_projection',
        context: {
          servertoolCliProjection: projection.chatResponse.__servertool_cli_projection as JsonObject
        }
      }
    };
  }

  const executionState = await runToolCallExecutionLoop({
    dispatchPlan,
    options,
    contextBase,
    runtimePreCommandState,
    base,
    baseForExecution,
    patchToolCallArgumentsById,
    appendToolOutput
  });

  if (executionState.executedToolCalls.length > 0) {
    return resolveToolCallExecutionOutcome({
      base,
      baseForExecution,
      options,
      toolCalls,
      executionState,
      filterOutExecutedToolCalls,
      stripToolOutputs
    });
  }

  const payloadContractSignal = detectEmptyAssistantPayloadContractSignalWithNative(base);
  if (payloadContractSignal && !isStopEligibleForServerTool(base, options.adapterContext)) {
    return { mode: 'passthrough', finalChatResponse: base };
  }
  const autoHookExecutionList = listAutoServerToolHooks();
  const { optionalQueue, mandatoryQueue } = buildAutoHookQueuesFromConfig({
    hooks: autoHookExecutionList,
    includeAutoHookIds,
    excludeAutoHookIds
  });

  const optionalResult = await runAutoHookExecutionQueue({
    queueName: 'A_optional',
    hooks: optionalQueue,
    options,
    contextBase: contextBase as ServerToolHandlerContext
  });
  if (optionalResult) {
    return {
      mode: 'tool_flow',
      finalChatResponse: optionalResult.chatResponse,
      execution: optionalResult.execution
    };
  }

  const mandatoryResult = await runAutoHookExecutionQueue({
    queueName: 'B_mandatory',
    hooks: mandatoryQueue,
    options,
    contextBase: contextBase as ServerToolHandlerContext
  });
  if (mandatoryResult) {
    return {
      mode: 'tool_flow',
      finalChatResponse: mandatoryResult.chatResponse,
      execution: mandatoryResult.execution
    };
  }

  return { mode: 'passthrough', finalChatResponse: base };
}

function isClientExecCliProjectionToolCall(toolCall: ToolCall & { executionMode?: string }): boolean {
  const executionMode = typeof toolCall.executionMode === 'string' ? toolCall.executionMode.trim() : '';
  if (executionMode === 'client_exec_cli_projection' || executionMode === 'client_inject_only') {
    return true;
  }
  return toolCall.name === 'servertool_fixture';
}

function collectAdditionalClientToolCalls(base: JsonObject, projectedToolCallId: string): JsonValue[] {
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
    return name !== 'servertool_fixture' && name !== 'stop_message_auto';
  });
}

export function extractToolCalls(chatResponse: JsonObject, requestId = ''): ToolCall[] {
  const stage = runServertoolResponseStageWithNative(chatResponse, requestId);
  const normalizedPayload = asObject(stage.normalizedPayload) ?? chatResponse;
  replaceJsonObjectInPlace(chatResponse, normalizedPayload);
  return stage.toolCalls.map((entry) => ({
    id: entry.id,
    name: entry.name,
    arguments: entry.arguments
  }));
}


function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function getArray(value: unknown): JsonValue[] {
  return Array.isArray(value) ? (value as JsonValue[]) : [];
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isClientDisconnected(adapterContext: AdapterContext): boolean {
  if (!adapterContext || typeof adapterContext !== 'object') {
    return false;
  }
  const state = (adapterContext as { clientConnectionState?: unknown }).clientConnectionState;
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    const disconnected = (state as { disconnected?: unknown }).disconnected;
    if (disconnected === true) {
      return true;
    }
    if (typeof disconnected === 'string' && disconnected.trim().toLowerCase() === 'true') {
      return true;
    }
  }
  const raw = (adapterContext as { clientDisconnected?: unknown }).clientDisconnected;
  if (raw === true) {
    return true;
  }
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'true') {
    return true;
  }
  return false;
}

export function extractTextFromChatLike(payload: JsonObject): string {
  return extractTextFromChatLikeWithNative(payload);
}

// Explicit marker that a TS helper is operating under native servertool / router-hotpath contract.
// This keeps thin TS shells auditable without duplicating native semantics in multiple places.
export function bindServertoolContractWithNative<T>(value: T): T {
  return value;
}
