import type { JsonObject } from '../conversion/hub/types/json.js';
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
  type NativeServertoolExecutionLoopState
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import { materializeServertoolPlannedResult, type ServertoolExecutedRecord, type ServertoolExecutionLoopState, runServertoolHandler } from './execution-handler-materialization-shell.js';
import { replaceJsonObjectInPlace } from './orchestration-blocks.js';
import { createServertoolProviderProtocolErrorFromPlan } from './timeout-error-block.js';

export type { ServertoolExecutedRecord, ServertoolExecutionLoopState };

function createServertoolExecutionLoopState(): ServertoolExecutionLoopState {
  return hydrateExecutionLoopState(createServertoolExecutionLoopStateWithNative());
}

function appendExecutedToolRecord(
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

export const buildServertoolDispatchPlanInput = (args: {
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

export const buildServertoolOutcomePlanInput = (args: {
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
    buildServertoolOutcomePlanInput({
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
    const clientResponse = structuredClone(args.base);
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
    throw createServertoolProviderProtocolErrorFromPlan(
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
    throw createServertoolProviderProtocolErrorFromPlan(
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
}): Promise<ServertoolExecutionLoopState> {
  const executionState = createServertoolExecutionLoopState();

  for (const toolCall of args.dispatchPlan.executableToolCalls) {
    const entry = getServerToolHandler(toolCall.name);
    const initialLoopActionPlan = planServertoolExecutionLoopRuntimeActionWithNative({
      hasHandlerEntry: Boolean(entry),
      triggerMode: entry?.trigger,
      nativeExecutionMode: entry?.registration.executionMode,
      tsExecutionMode: toolCall.executionMode,
      hasMaterializedResult: false,
      hasHandlerError: false
    });
    if (initialLoopActionPlan.action === 'skip_non_tool_call_handler') {
      continue;
    }
    if (initialLoopActionPlan.action === 'throw_dispatch_spec_mismatch') {
      throw createServertoolProviderProtocolErrorFromPlan(
        planServertoolExecutionDispatchErrorWithNative({
          kind: 'dispatch_spec_mismatch',
          requestId: args.options.requestId,
          toolName: toolCall.name,
          nativeExecutionMode: entry?.registration.executionMode ?? '',
          tsExecutionMode: toolCall.executionMode
        })
      );
    }
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
      replaceJsonObjectInPlace(args.baseForExecution, result.chatResponse as JsonObject);
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
      replaceJsonObjectInPlace(args.baseForExecution, toolOutputPayload);
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

    replaceJsonObjectInPlace(args.baseForExecution, noopResult.chatResponse as JsonObject);

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
