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
  planServertoolToolCallDispatchWithNative,
  buildServertoolHandlerErrorToolOutputPayloadWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import {
  planServertoolExecutionDispatchErrorWithNative,
  planServertoolExecutionLoopEffectWithNative,
  planServertoolExecutionLoopRuntimeActionWithNative,
  planServertoolExecutionOutcomeRuntimeActionWithNative,
  createServertoolExecutionLoopStateWithNative,
  appendServertoolExecutedRecordWithNative,
  type NativeServertoolExecutionLoopState,
  type ServertoolErrorPlan
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import { materializeServertoolPlannedResult, type ServertoolExecutedRecord, type ServertoolExecutionLoopState, runServertoolHandler } from './execution-handler-materialization-shell.js';
import { replaceJsonObjectInPlace } from './orchestration-blocks.js';

export type { ServertoolExecutedRecord, ServertoolExecutionLoopState };

export function createServertoolExecutionLoopState(): ServertoolExecutionLoopState {
  return hydrateExecutionLoopState(createServertoolExecutionLoopStateWithNative());
}

export function appendExecutedToolRecord(
  state: ServertoolExecutionLoopState,
  toolCall: ServertoolExecutedRecord['toolCall'],
  execution?: ServerToolExecution
): void {
  const next = hydrateExecutionLoopState(
    appendServertoolExecutedRecordWithNative({
      state: dehydrateExecutionLoopState(state),
      toolCall,
      ...(execution ? { execution } : {})
    })
  );
  state.executedToolCalls = next.executedToolCalls;
  state.executedIds = next.executedIds;
  state.executedFlowIds = next.executedFlowIds;
  state.lastExecution = next.lastExecution;
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
  throw buildProviderProtocolError(
    planServertoolExecutionDispatchErrorWithNative({
      kind: 'dispatch_spec_mismatch',
      requestId: options.requestId,
      toolName,
      nativeExecutionMode,
      tsExecutionMode
    })
  );
}

export function applyServertoolExecutionResult(
  baseForExecution: JsonObject,
  nextChatResponse: JsonObject
): void {
  replaceJsonObjectInPlace(baseForExecution, nextChatResponse);
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
  adapterContext?: unknown;
  baseForExecution?: unknown;
  sessionId?: string;
  conversationId?: string;
  toolOutputs?: unknown[];
  pendingInjectionMessageKinds?: string[];
}) => {
  return buildServertoolOutcomePlanInputWithNative({
    toolCalls: args.toolCalls,
    executionState: args.executionState,
    ...(args.adapterContext !== undefined ? { adapterContext: args.adapterContext } : {}),
    ...(args.baseForExecution !== undefined ? { baseForExecution: args.baseForExecution } : {}),
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
  const outcomePlan = planServertoolOutcomeWithNative(
    buildServertoolOutcomePlanInputThinShell({
      toolCalls: args.toolCalls,
      executionState: args.executionState,
      adapterContext: args.options.adapterContext,
      baseForExecution: args.baseForExecution,
      pendingInjectionMessageKinds: args.pendingInjectionMessageKinds,
    })
  );

  const outcomeRuntimeActionPlan = planServertoolExecutionOutcomeRuntimeActionWithNative({
    outcomeMode: outcomePlan.outcomeMode,
    requiresPendingInjection: outcomePlan.requiresPendingInjection,
    followupStrategy: outcomePlan.followupStrategy,
    useLastExecutionFollowup: outcomePlan.useLastExecutionFollowup,
    hasLastExecutionFollowup: Boolean(args.executionState.lastExecution?.followup),
    hasResolvedFollowup: Boolean(outcomePlan.resolvedFollowup),
    hasLastExecution: Boolean(args.executionState.lastExecution),
    executedToolCallsLen: args.executionState.executedToolCalls.length,
    lastExecution: args.executionState.lastExecution,
    resolvedFollowup: outcomePlan.resolvedFollowup,
    flowId: outcomePlan.flowId,
    pendingSessionId: outcomePlan.pendingSessionId,
    aliasSessionIds: outcomePlan.aliasSessionIds,
    remainingToolCallIds: outcomePlan.remainingToolCallIds,
    pendingInjectionMessagesResolved: outcomePlan.pendingInjectionMessagesResolved
  });

  if (outcomeRuntimeActionPlan.action === 'return_mixed_client_tools_pending_injection') {
    const clientResponse = JSON.parse(JSON.stringify(args.base)) as JsonObject;
    args.filterOutExecutedToolCalls(clientResponse, args.executionState.executedIds);
    args.stripToolOutputs(clientResponse);
    return {
      mode: 'tool_flow',
      finalChatResponse: clientResponse,
      execution: { flowId: outcomeRuntimeActionPlan.executionFlowId },
      ...(outcomeRuntimeActionPlan.pendingInjection
        ? {
            pendingInjection: outcomeRuntimeActionPlan.pendingInjection as ServerSideToolEngineResult['pendingInjection']
          }
        : {})
    };
  }

  if (outcomeRuntimeActionPlan.action === 'invalid_mixed_client_tools_outcome') {
    throw buildProviderProtocolError(
      planServertoolExecutionDispatchErrorWithNative({
        kind: 'invalid_mixed_client_tools_outcome',
        requestId: args.options.requestId,
        outcomeMode: outcomePlan.outcomeMode,
        followupStrategy: outcomePlan.followupStrategy,
        requiresPendingInjection: outcomePlan.requiresPendingInjection
      })
    );
  }

  const followup = outcomeRuntimeActionPlan.selectedFollowup as ServerToolFollowupPlan | undefined;
  if (!followup) {
    throw buildProviderProtocolError(
      planServertoolExecutionDispatchErrorWithNative({
        kind: 'missing_followup_contract',
        requestId: args.options.requestId,
        outcomeMode: outcomePlan.outcomeMode,
        followupStrategy: outcomePlan.followupStrategy,
        useLastExecutionFollowup: outcomePlan.useLastExecutionFollowup,
        useGenericFollowup: outcomePlan.useGenericFollowup
      })
    );
  }
  return {
    mode: 'tool_flow',
    finalChatResponse: args.baseForExecution,
    execution: {
      ...(outcomeRuntimeActionPlan.reuseLastExecutionEnvelope === true
        ? (outcomeRuntimeActionPlan.selectedExecutionEnvelope as Record<string, unknown> | undefined)
        : ({ flowId: outcomeRuntimeActionPlan.executionFlowId } as any)),
      flowId: outcomeRuntimeActionPlan.executionFlowId,
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
    const initialLoopActionPlan = planServertoolExecutionLoopRuntimeActionWithNative({
      hasHandlerEntry: Boolean(entry),
      triggerMode: entry?.trigger,
      hasMaterializedResult: false,
      hasHandlerError: false
    });
    if (initialLoopActionPlan.action === 'skip_non_tool_call_handler') {
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
    const resultLoopActionPlan = planServertoolExecutionLoopRuntimeActionWithNative({
      hasHandlerEntry: true,
      triggerMode: entry.trigger,
      hasMaterializedResult: Boolean(result),
      hasHandlerError: Boolean(lastErr)
    });
    if (resultLoopActionPlan.action === 'apply_materialized_result') {
      applyServertoolExecutionResult(args.baseForExecution, JSON.parse(JSON.stringify(result.chatResponse)) as JsonObject);
      appendExecutedToolRecord(executionState, toolCall, result.execution);
      continue;
    }
    if (resultLoopActionPlan.action === 'apply_handler_error_tool_output') {
      const message = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown');
      const toolOutputPayload = buildServertoolHandlerErrorToolOutputPayloadWithNative({
        base: args.baseForExecution as Record<string, unknown>,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        message
      }) as JsonObject;
      applyServertoolExecutionResult(
        args.baseForExecution,
        JSON.parse(JSON.stringify(toolOutputPayload)) as JsonObject
      );
      const errorEffectPlan = planServertoolExecutionLoopEffectWithNative({
        mode: 'handler_error',
        toolCall: {
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
          executionMode: toolCall.executionMode,
          stripAfterExecute: toolCall.stripAfterExecute
        }
      });
      appendExecutedToolRecord(
        executionState,
        errorEffectPlan.toolCall as ServertoolExecutedRecord['toolCall'],
        errorEffectPlan.execution as ServerToolExecution
      );
    }
  }

  for (const toolCall of args.dispatchPlan.noopToolCalls ?? []) {
    const noopResult = planServertoolNoopOutcomeWithNative({
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      toolArguments: toolCall.arguments,
      base: args.baseForExecution as Record<string, unknown>
    });
    const {
      flowId: noopFlowId,
      followup: noopFollowup,
      executionContext: noopExecutionContext
    } = noopResult;

    applyServertoolExecutionResult(
      args.baseForExecution,
      JSON.parse(JSON.stringify(noopResult.chatResponse)) as JsonObject
    );

    const noopEffectPlan = planServertoolExecutionLoopEffectWithNative({
      mode: 'noop',
      toolCall: {
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
        executionMode: toolCall.executionMode,
        stripAfterExecute: toolCall.stripAfterExecute
      },
      noopFlowId,
      noopFollowup,
      noopExecutionContext
    });
    appendExecutedToolRecord(
      executionState,
      noopEffectPlan.toolCall as ServertoolExecutedRecord['toolCall'],
      noopEffectPlan.execution as ServerToolExecution
    );
  }

  return executionState;
}

export const resolveToolCallExecutionOutcomeThinShell = materializeNativeToolCallExecutionOutcome;
export const runToolCallExecutionLoopThinShell = runServertoolIoExecutionQueue;

function buildProviderProtocolError(plan: ServertoolErrorPlan): ProviderProtocolError & { status?: number } {
  const err = new ProviderProtocolError(plan.message, {
    code: plan.code as any,
    category: plan.category as any,
    details: plan.details
  }) as ProviderProtocolError & { status?: number };
  err.status = plan.status;
  return err;
}

function hydrateExecutionLoopState(state: NativeServertoolExecutionLoopState): ServertoolExecutionLoopState {
  return {
    executedToolCalls: state.executedToolCalls as ServertoolExecutedRecord[],
    executedIds: new Set(state.executedIds),
    executedFlowIds: state.executedFlowIds,
    ...(state.lastExecution ? { lastExecution: state.lastExecution as ServerToolExecution } : {})
  };
}

function dehydrateExecutionLoopState(state: ServertoolExecutionLoopState): NativeServertoolExecutionLoopState {
  return {
    executedToolCalls: state.executedToolCalls as any,
    executedIds: [...state.executedIds],
    executedFlowIds: state.executedFlowIds,
    ...(state.lastExecution ? { lastExecution: state.lastExecution as any } : {})
  };
}
