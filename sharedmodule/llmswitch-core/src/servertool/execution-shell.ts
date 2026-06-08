import type { JsonObject } from '../conversion/hub/types/json.js';
import { ProviderProtocolError } from '../conversion/provider-protocol-error.js';
import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolBackendPlan,
  ServerToolBackendResult,
  ServerToolAutoHookTraceEvent,
  ServerToolHandlerContext,
  ServerToolHandler,
  ServerToolHandlerPlan,
  ServerToolHandlerResult,
  ServerToolExecution,
  ServerToolFollowupPlan,
  ToolCall
} from './types.js';
import { executeVisionBackendPlan } from './handlers/vision.js';
import { executeWebSearchBackendPlan } from './handlers/web-search.js';
import { getServerToolHandler, listRegisteredServerToolHandlerRecords } from './registry.js';
import { planServertoolNoopOutcomeWithNative, planServertoolOutcomeWithNative, planServertoolToolCallDispatchWithNative } from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import { runPreCommandHooks } from './pre-command-hooks.js';
import {
  buildServertoolFollowupConfig,
  buildServertoolPendingInjectionConfig
} from './skeleton-config.js';

export interface ServertoolExecutedRecord {
  toolCall: ToolCall & {
    executionMode: string;
    stripAfterExecute: boolean;
  };
  execution?: ServerToolExecution;
}

export interface ServertoolExecutionLoopState {
  executedToolCalls: ServertoolExecutedRecord[];
  executedIds: Set<string>;
  executedFlowIds: string[];
  lastExecution?: ServerToolExecution;
}

export interface ServertoolAutoHookDescriptor {
  id: string;
  phase: string;
  priority: number;
  handler: ServerToolHandler;
}

export function createServertoolExecutionLoopState(): ServertoolExecutionLoopState {
  return {
    executedToolCalls: [],
    executedIds: new Set<string>(),
    executedFlowIds: []
  };
}

export function appendExecutedToolRecord(
  state: ServertoolExecutionLoopState,
  toolCall: ServertoolExecutedRecord['toolCall'],
  execution?: ServerToolExecution
): void {
  state.executedToolCalls.push({ toolCall, ...(execution ? { execution } : {}) });
  state.executedIds.add(toolCall.id);
  if (execution?.flowId && execution.flowId.trim()) {
    state.executedFlowIds.push(execution.flowId.trim());
  }
  if (execution) {
    state.lastExecution = execution;
  }
}

export function assertDispatchExecutionMode(
  options: ServerSideToolEngineOptions,
  toolName: string,
  nativeExecutionMode: string,
  tsExecutionMode: string
): void {
  if (tsExecutionMode === nativeExecutionMode) {
    return;
  }
  throw new ProviderProtocolError(
    `[servertool] dispatch spec mismatch: ${toolName}: native=${nativeExecutionMode} ts=${tsExecutionMode}`,
    {
      code: 'SERVERTOOL_HANDLER_FAILED',
      category: 'INTERNAL_ERROR',
      details: {
        toolName,
        requestId: options.requestId,
        nativeExecutionMode,
        tsExecutionMode
      }
    }
  );
}

export async function runServertoolHandler(
  handler: (ctx: ServerToolHandlerContext) => Promise<ServerToolHandlerPlan | ServerToolHandlerResult | null>,
  ctx: ServerToolHandlerContext
): Promise<ServerToolHandlerPlan | ServerToolHandlerResult | null> {
  try {
    return await handler(ctx);
  } catch (error) {
    const toolName =
      ctx && ctx.toolCall && typeof ctx.toolCall.name === 'string' && ctx.toolCall.name.trim()
        ? ctx.toolCall.name.trim()
        : 'auto';
    const message = error instanceof Error ? error.message : String(error ?? 'unknown');
    const wrapped = new ProviderProtocolError(`[servertool] handler failed: ${toolName}: ${message}`, {
      code: 'SERVERTOOL_HANDLER_FAILED',
      category: 'INTERNAL_ERROR',
      details: {
        toolName,
        requestId: ctx.requestId,
        entryEndpoint: ctx.entryEndpoint,
        providerProtocol: ctx.providerProtocol,
        error: message
      }
    }) as ProviderProtocolError & { status?: number; cause?: unknown };
    wrapped.status = 500;
    wrapped.cause = error;
    throw wrapped;
  }
}

export async function materializeServertoolPlannedResult(
  planned: ServerToolHandlerPlan | ServerToolHandlerResult,
  options: ServerSideToolEngineOptions
): Promise<ServerToolHandlerResult | null> {
  if (planned && typeof planned === 'object' && !Array.isArray(planned) && typeof (planned as any).finalize === 'function') {
    const plan = planned as ServerToolHandlerPlan;
    const backendResult = plan.backend ? await executeServertoolBackendPlan(plan.backend, options) : undefined;
    return await plan.finalize({ ...(backendResult ? { backendResult } : {}) });
  }
  return planned as ServerToolHandlerResult;
}

export async function executeServertoolBackendPlan(
  plan: ServerToolBackendPlan,
  options: ServerSideToolEngineOptions
): Promise<ServerToolBackendResult | undefined> {
  if (!plan) return undefined;
  if (plan.kind === 'vision_analysis') {
    if (!options.reenterPipeline) return undefined;
    return await executeVisionBackendPlan({ plan, options });
  }
  if (plan.kind === 'web_search') {
    return await executeWebSearchBackendPlan({ plan, options });
  }
  return undefined;
}

export function buildOutcomePlannerExecutedToolCalls(
  records: ServertoolExecutedRecord[]
): Array<{
  id: string;
  name: string;
  arguments: string;
  executionMode: string;
  stripAfterExecute: boolean;
}> {
  return records.map((record) => ({
    id: record.toolCall.id,
    name: record.toolCall.name,
    arguments: record.toolCall.arguments,
    executionMode: record.toolCall.executionMode,
    stripAfterExecute: record.toolCall.stripAfterExecute
  }));
}

export function resolveServertoolHandlerExecutionSpec(toolCall: ToolCall): {
  executionMode: string;
  stripAfterExecute: boolean;
} {
  const entry = getServerToolHandler(toolCall.name);
  return {
    executionMode: entry?.registration.executionMode ?? 'guarded',
    stripAfterExecute: entry?.registration.stripAfterExecute ?? true
  };
}

export function applyPreCommandHooksToToolCall(args: {
  options: ServerSideToolEngineOptions;
  toolCall: ToolCall;
  runtimePreCommandState?: JsonObject;
  bases?: JsonObject[];
  patchToolCallArgumentsById?: (chatResponse: JsonObject, toolCallId: string, argumentsText: string) => void;
}): void {
  const preHookResult = runPreCommandHooks({
    requestId: args.options.requestId,
    entryEndpoint: args.options.entryEndpoint,
    providerProtocol: args.options.providerProtocol,
    toolName: args.toolCall.name,
    toolCallId: args.toolCall.id,
    toolArguments: args.toolCall.arguments,
    preCommandState: args.runtimePreCommandState
  });
  for (const trace of preHookResult.traces) {
    try {
      args.options.onAutoHookTrace?.(trace);
    } catch {
      // best-effort
    }
  }
  if (!preHookResult.changed || preHookResult.toolArguments === args.toolCall.arguments) {
    return;
  }
  args.toolCall.arguments = preHookResult.toolArguments;
  if (!args.bases?.length || !args.patchToolCallArgumentsById) {
    return;
  }
  for (const base of args.bases) {
    args.patchToolCallArgumentsById(base, args.toolCall.id, preHookResult.toolArguments);
  }
}

export function applyPreCommandHooksToToolCalls(args: {
  options: ServerSideToolEngineOptions;
  toolCalls: ToolCall[];
  runtimePreCommandState?: JsonObject;
  bases: JsonObject[];
  patchToolCallArgumentsById: (chatResponse: JsonObject, toolCallId: string, argumentsText: string) => void;
}): void {
  for (const toolCall of args.toolCalls) {
    applyPreCommandHooksToToolCall({
      options: args.options,
      toolCall,
      runtimePreCommandState: args.runtimePreCommandState,
      bases: args.bases,
      patchToolCallArgumentsById: args.patchToolCallArgumentsById
    });
  }
}

export function applyServertoolExecutionResult(
  baseForExecution: JsonObject,
  nextChatResponse: JsonObject
): void {
  const newKeys = new Set(Object.keys(nextChatResponse));
  for (const [key, value] of Object.entries(nextChatResponse)) {
    (baseForExecution as any)[key] = value;
  }
  for (const key of Object.keys(baseForExecution)) {
    if (!newKeys.has(key)) {
      delete (baseForExecution as any)[key];
    }
  }
}

export function buildServertoolDispatchPlanInput(args: {
  toolCalls: ToolCall[];
  disableToolCallHandlers: boolean;
  includeToolCallHandlerNames?: string[];
  excludeToolCallHandlerNames?: string[];
  runtimeMetadata?: JsonObject;
}) {
  return {
    toolCalls: args.toolCalls,
    disableToolCallHandlers: args.disableToolCallHandlers,
    ...(args.includeToolCallHandlerNames?.length
      ? { includeToolCallHandlerNames: args.includeToolCallHandlerNames }
      : {}),
    ...(args.excludeToolCallHandlerNames?.length
      ? { excludeToolCallHandlerNames: args.excludeToolCallHandlerNames }
      : {}),
    registeredToolCallHandlers: listRegisteredServerToolHandlerRecords()
      .filter((entry) => entry.registration.trigger === 'tool_call')
      .map((entry) => ({
        name: entry.registration.name,
        trigger: entry.registration.trigger,
        executionMode: entry.registration.executionMode,
        stripAfterExecute: entry.registration.stripAfterExecute
      })),
    runtimeMetadata: args.runtimeMetadata
  };
}

export function buildServertoolOutcomePlanInput(args: {
  toolCalls: ToolCall[];
  executionState: ServertoolExecutionLoopState;
  sessionId?: string;
  conversationId?: string;
  toolOutputs?: unknown[];
  pendingInjectionMessageKinds?: string[];
}) {
  return {
    toolCalls: args.toolCalls,
    executedToolCalls: buildOutcomePlannerExecutedToolCalls(args.executionState.executedToolCalls),
    executedFlowIds: args.executionState.executedFlowIds,
    ...(args.executionState.lastExecution?.flowId
      ? { lastExecutionFlowId: args.executionState.lastExecution.flowId }
      : {}),
    hasLastExecutionFollowup: Boolean(args.executionState.lastExecution?.followup),
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.conversationId ? { conversationId: args.conversationId } : {}),
    ...(args.toolOutputs?.length ? { toolOutputs: args.toolOutputs } : {}),
    ...(args.pendingInjectionMessageKinds?.length
      ? { pendingInjectionMessageKinds: args.pendingInjectionMessageKinds }
      : {}),
  };
}

export function resolveToolCallExecutionOutcome(args: {
  base: JsonObject;
  baseForExecution: JsonObject;
  options: ServerSideToolEngineOptions;
  toolCalls: ToolCall[];
  executionState: ServertoolExecutionLoopState;
  filterOutExecutedToolCalls: (chatResponse: JsonObject, executedIds: Set<string>) => void;
  stripToolOutputs: (base: JsonObject) => void;
}): ServerSideToolEngineResult {
  const pendingInjectionConfig = buildServertoolPendingInjectionConfig();
  const sessionId =
    args.options.adapterContext && typeof (args.options.adapterContext as any).sessionId === 'string'
      ? String((args.options.adapterContext as any).sessionId).trim()
      : '';
  const conversationId =
    args.options.adapterContext && typeof (args.options.adapterContext as any).conversationId === 'string'
      ? String((args.options.adapterContext as any).conversationId).trim()
      : '';

  const outcomePlan = planServertoolOutcomeWithNative(
    buildServertoolOutcomePlanInput({
      toolCalls: args.toolCalls,
      executionState: args.executionState,
      toolOutputs: Array.isArray((args.baseForExecution as any).tool_outputs)
        ? ((args.baseForExecution as any).tool_outputs as unknown[])
        : undefined,
      pendingInjectionMessageKinds: pendingInjectionConfig.messageKinds,
      ...(sessionId ? { sessionId } : {}),
      ...(conversationId ? { conversationId } : {})
    })
  );

  if (outcomePlan.outcomeMode === 'mixed_client_tools') {
    if (!outcomePlan.requiresPendingInjection || outcomePlan.followupStrategy !== 'pending_injection') {
      throw new ProviderProtocolError('[servertool] invalid native mixed-client-tools outcome contract', {
        code: 'SERVERTOOL_HANDLER_FAILED',
        category: 'INTERNAL_ERROR',
        details: {
          requestId: args.options.requestId,
          outcomeMode: outcomePlan.outcomeMode,
          followupStrategy: outcomePlan.followupStrategy,
          requiresPendingInjection: outcomePlan.requiresPendingInjection
        }
      });
    }
    const clientResponse = JSON.parse(JSON.stringify(args.base)) as JsonObject;
    args.filterOutExecutedToolCalls(clientResponse, args.executionState.executedIds);
    args.stripToolOutputs(clientResponse);
    const injectionMessages = outcomePlan.pendingInjectionMessagesResolved as JsonObject[];
    return {
      mode: 'tool_flow',
      finalChatResponse: clientResponse,
      execution: { flowId: outcomePlan.flowId || 'servertool_mixed' },
      ...(outcomePlan.pendingSessionId && injectionMessages.length
        ? {
            pendingInjection: {
              sessionId: outcomePlan.pendingSessionId,
              ...(outcomePlan.aliasSessionIds.length ? { aliasSessionIds: outcomePlan.aliasSessionIds } : {}),
              afterToolCallIds: outcomePlan.remainingToolCallIds,
              messages: injectionMessages
            }
          }
        : {})
    };
  }

  const followupConfig = buildServertoolFollowupConfig();
  const genericOps = followupConfig.genericInjectionOps
    .map((op) => (typeof op === 'string' ? op.trim() : ''))
    .filter(Boolean)
    .map((op) => ({ op, required: true }));
  const genericFollowup = {
    requestIdSuffix: ':servertool_followup',
    ...(genericOps.length ? { injection: { ops: genericOps } } : {})
  } as any;
  const followup =
    outcomePlan.followupStrategy === 'reuse_last_execution' &&
    outcomePlan.useLastExecutionFollowup &&
    args.executionState.lastExecution?.followup
      ? args.executionState.lastExecution.followup
      : genericFollowup;
  const flowId = outcomePlan.flowId || 'servertool_multi';
  return {
    mode: 'tool_flow',
    finalChatResponse: args.baseForExecution,
    execution: {
      ...(args.executionState.lastExecution && args.executionState.executedToolCalls.length === 1
        ? args.executionState.lastExecution
        : ({ flowId } as any)),
      flowId,
      followup
    }
  };
}

export async function runToolCallExecutionLoop(args: {
  dispatchPlan: ReturnType<typeof planServertoolToolCallDispatchWithNative>;
  options: ServerSideToolEngineOptions;
  contextBase: Omit<ServerToolHandlerContext, 'toolCall'>;
  runtimePreCommandState?: JsonObject;
  base: JsonObject;
  baseForExecution: JsonObject;
  patchToolCallArgumentsById: (chatResponse: JsonObject, toolCallId: string, argumentsText: string) => void;
  appendToolOutput: (base: JsonObject, toolCallId: string, name: string, content: string) => void;
}): Promise<ServertoolExecutionLoopState> {
  const executionState = createServertoolExecutionLoopState();

  for (const toolCall of args.dispatchPlan.executableToolCalls) {
    const entry = getServerToolHandler(toolCall.name);
    if (!entry || entry.trigger !== 'tool_call') {
      continue;
    }
    assertDispatchExecutionMode(args.options, toolCall.name, toolCall.executionMode, entry.registration.executionMode);
    const ctx: ServerToolHandlerContext = { ...args.contextBase, base: args.baseForExecution, toolCall };
    let planned: ServerToolHandlerPlan | ServerToolHandlerResult | null = null;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        planned = await runServertoolHandler(entry.handler, ctx);
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    const result = planned ? await materializeServertoolPlannedResult(planned, args.options) : null;
    if (result) {
      applyServertoolExecutionResult(args.baseForExecution, JSON.parse(JSON.stringify(result.chatResponse)) as JsonObject);
      appendExecutedToolRecord(executionState, toolCall, result.execution);
      continue;
    }
    if (lastErr) {
      const message = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown');
      args.appendToolOutput(
        args.baseForExecution,
        toolCall.id,
        toolCall.name,
        JSON.stringify({
          ok: false,
          tool: toolCall.name,
          message,
          retryable: true
        })
      );
      appendExecutedToolRecord(executionState, toolCall, {
        flowId: `${toolCall.name}_error`
      });
    }
  }

  // Process noop tool calls — acknowledged and auto-continued without handler execution.
  // Rust produces the standard delta: tool_outputs entry + clientInjectOnly followup.
  for (const toolCall of args.dispatchPlan.noopToolCalls ?? []) {
    const noopResult = planServertoolNoopOutcomeWithNative({
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      base: args.baseForExecution as Record<string, unknown>
    });

    applyServertoolExecutionResult(
      args.baseForExecution,
      JSON.parse(JSON.stringify(noopResult.chatResponse)) as JsonObject
    );

    appendExecutedToolRecord(executionState, {
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
      executionMode: 'noop',
      stripAfterExecute: true
    }, {
      flowId: noopResult.flowId,
      followup: noopResult.followup as unknown as ServerToolFollowupPlan,
      context: { [toolCall.name]: { visibleSummary: '' } }
    });
  }

  return executionState;
}

export async function runAutoHookExecutionQueue(args: {
  queueName: ServerToolAutoHookTraceEvent['queue'];
  hooks: ServertoolAutoHookDescriptor[];
  options: ServerSideToolEngineOptions;
  contextBase: ServerToolHandlerContext;
}): Promise<ServerToolHandlerResult | null> {
  const queueTotal = args.hooks.length;
  for (let idx = 0; idx < args.hooks.length; idx += 1) {
    const hook = args.hooks[idx];
    const traceBase: Omit<ServerToolAutoHookTraceEvent, 'result' | 'reason' | 'flowId'> = {
      hookId: hook.id,
      phase: hook.phase,
      priority: hook.priority,
      queue: args.queueName,
      queueIndex: idx + 1,
      queueTotal
    };

    let planned: ServerToolHandlerPlan | ServerToolHandlerResult | null = null;
    try {
      planned = await runServertoolHandler(hook.handler, args.contextBase);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? 'unknown');
      try {
        args.options.onAutoHookTrace?.({
          ...traceBase,
          result: 'error',
          reason: message
        });
      } catch {
        // best-effort
      }
      throw error;
    }

    if (!planned) {
      try {
        args.options.onAutoHookTrace?.({
          ...traceBase,
          result: 'miss',
          reason: 'predicate_false'
        });
      } catch {
        // best-effort
      }
      continue;
    }

    const result = await materializeServertoolPlannedResult(planned, args.options);
    if (result) {
      const flowId =
        result.execution && typeof result.execution.flowId === 'string' && result.execution.flowId.trim()
          ? result.execution.flowId.trim()
          : undefined;
      try {
        args.options.onAutoHookTrace?.({
          ...traceBase,
          result: 'match',
          reason: flowId ? 'matched' : 'matched_without_flow',
          ...(flowId ? { flowId } : {})
        });
      } catch {
        // best-effort
      }
      return result;
    }

    try {
      args.options.onAutoHookTrace?.({
        ...traceBase,
        result: 'miss',
        reason: 'empty_materialized_result'
      });
    } catch {
      // best-effort
    }
  }

  return null;
}
