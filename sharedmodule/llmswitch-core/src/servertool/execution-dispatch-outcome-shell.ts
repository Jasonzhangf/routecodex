import type { JsonObject } from '../conversion/hub/types/json.js';
import { ProviderProtocolError } from '../conversion/provider-protocol-error.js';
import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolExecution,
  ServerToolFollowupPlan,
  ToolCall
} from './types.js';
import { getServerToolHandler, listAdHocRegisteredToolCallHandlerSpecs } from './registry.js';
import {
  planServertoolNoopOutcomeWithNative,
  planServertoolOutcomeWithNative,
  buildServertoolDispatchPlanInputWithNative,
  buildServertoolOutcomePlanInputWithNative,
  planServertoolToolCallDispatchWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import { materializeServertoolPlannedResult, type ServertoolExecutedRecord, type ServertoolExecutionLoopState, runServertoolHandler } from './execution-handler-materialization-shell.js';

export type { ServertoolExecutedRecord, ServertoolExecutionLoopState };

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

export const buildServertoolDispatchPlanInputThinShell = (args: {
  toolCalls: ToolCall[];
  disableToolCallHandlers: boolean;
  includeToolCallHandlerNames?: string[];
  excludeToolCallHandlerNames?: string[];
  runtimeMetadata?: JsonObject;
}) => {
  const adHocHandlers = listAdHocRegisteredToolCallHandlerSpecs()
    .map((entry) => ({
      name: entry.name,
      executionMode: entry.executionMode,
      stripAfterExecute: entry.stripAfterExecute
    }));
  return buildServertoolDispatchPlanInputWithNative({
    toolCalls: args.toolCalls,
    disableToolCallHandlers: args.disableToolCallHandlers,
    ...(args.includeToolCallHandlerNames?.length
      ? { includeToolCallHandlerNames: args.includeToolCallHandlerNames }
      : {}),
    ...(args.excludeToolCallHandlerNames?.length
      ? { excludeToolCallHandlerNames: args.excludeToolCallHandlerNames }
      : {}),
    adHocRegisteredToolCallHandlers: adHocHandlers,
    runtimeMetadata: args.runtimeMetadata
  });
};

export const buildServertoolOutcomePlanInputThinShell = (args: {
  toolCalls: ToolCall[];
  executionState: ServertoolExecutionLoopState;
  sessionId?: string;
  conversationId?: string;
  toolOutputs?: unknown[];
  pendingInjectionMessageKinds?: string[];
}) => {
  return buildServertoolOutcomePlanInputWithNative({
    toolCalls: args.toolCalls,
    executionState: args.executionState,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.conversationId ? { conversationId: args.conversationId } : {}),
    ...(args.toolOutputs?.length ? { toolOutputs: args.toolOutputs } : {}),
    ...(args.pendingInjectionMessageKinds?.length
      ? { pendingInjectionMessageKinds: args.pendingInjectionMessageKinds }
      : {}),
  });
};

export function materializeNativeToolCallExecutionOutcome(args: {
  base: JsonObject;
  baseForExecution: JsonObject;
  options: ServerSideToolEngineOptions;
  toolCalls: ToolCall[];
  executionState: ServertoolExecutionLoopState;
  filterOutExecutedToolCalls: (chatResponse: JsonObject, executedIds: Set<string>) => void;
  stripToolOutputs: (base: JsonObject) => void;
  pendingInjectionMessageKinds: string[];
}): ServerSideToolEngineResult {
  const sessionId =
    args.options.adapterContext && typeof (args.options.adapterContext as any).sessionId === 'string'
      ? String((args.options.adapterContext as any).sessionId).trim()
      : '';
  const conversationId =
    args.options.adapterContext && typeof (args.options.adapterContext as any).conversationId === 'string'
      ? String((args.options.adapterContext as any).conversationId).trim()
      : '';

  const outcomePlan = planServertoolOutcomeWithNative(
    buildServertoolOutcomePlanInputThinShell({
      toolCalls: args.toolCalls,
      executionState: args.executionState,
      toolOutputs: Array.isArray((args.baseForExecution as any).tool_outputs)
        ? ((args.baseForExecution as any).tool_outputs as unknown[])
        : undefined,
      pendingInjectionMessageKinds: args.pendingInjectionMessageKinds,
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

  const followup =
    outcomePlan.followupStrategy === 'reuse_last_execution' &&
    outcomePlan.useLastExecutionFollowup &&
    args.executionState.lastExecution?.followup
      ? args.executionState.lastExecution.followup
      : (outcomePlan.resolvedFollowup as ServerToolFollowupPlan | undefined);
  if (!followup) {
    throw new ProviderProtocolError('[servertool] missing native followup contract for servertool-only outcome', {
      code: 'SERVERTOOL_HANDLER_FAILED',
      category: 'INTERNAL_ERROR',
      details: {
        requestId: args.options.requestId,
        outcomeMode: outcomePlan.outcomeMode,
        followupStrategy: outcomePlan.followupStrategy,
        useLastExecutionFollowup: outcomePlan.useLastExecutionFollowup,
        useGenericFollowup: outcomePlan.useGenericFollowup
      }
    });
  }
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

export async function runServertoolIoExecutionQueue(args: {
  dispatchPlan: ReturnType<typeof planServertoolToolCallDispatchWithNative>;
  options: ServerSideToolEngineOptions;
  contextBase: Omit<import('./types.js').ServerToolHandlerContext, 'toolCall'>;
  baseForExecution: JsonObject;
  appendToolOutput: (base: JsonObject, toolCallId: string, name: string, content: string) => void;
}): Promise<ServertoolExecutionLoopState> {
  const executionState = createServertoolExecutionLoopState();

  for (const toolCall of args.dispatchPlan.executableToolCalls) {
    const entry = getServerToolHandler(toolCall.name);
    if (!entry || entry.trigger !== 'tool_call') {
      continue;
    }
    assertDispatchExecutionMode(args.options, toolCall.name, toolCall.executionMode, entry.registration.executionMode);
    const ctx = { ...args.contextBase, base: args.baseForExecution, toolCall };
    let planned = null;
    let lastErr: unknown;
    try {
      planned = await runServertoolHandler(entry.handler, ctx);
    } catch (err) {
      lastErr = err;
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

  for (const toolCall of args.dispatchPlan.noopToolCalls ?? []) {
    const noopResult = planServertoolNoopOutcomeWithNative({
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      toolArguments: toolCall.arguments,
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
      context: noopResult.executionContext as JsonObject
    });
  }

  return executionState;
}

export const resolveToolCallExecutionOutcomeThinShell = materializeNativeToolCallExecutionOutcome;
export const runToolCallExecutionLoopThinShell = runServertoolIoExecutionQueue;
