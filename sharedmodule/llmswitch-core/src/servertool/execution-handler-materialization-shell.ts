import type { JsonObject } from '../conversion/hub/types/json.js';
import { ProviderProtocolError } from '../conversion/provider-protocol-error.js';
import {
  appendServertoolExecutedRecordWithNative,
  planServertoolExecutionDispatchErrorWithNative,
  planServertoolExecutionOutcomeRuntimeActionWithNative,
  createServertoolExecutionLoopStateWithNative,
  planServertoolHandlerContractErrorWithNative,
  planServertoolHandlerRuntimeActionWithNative,
  type NativeServertoolExecutionLoopState,
  type ServertoolErrorPlan
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  buildServertoolOutcomePlanInputWithNative,
  planServertoolOutcomeWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import { replaceJsonObjectInPlace } from './orchestration-blocks.js';
import { createServertoolProviderProtocolErrorFromPlan } from './timeout-error-block.js';
import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolExecution,
  ServerToolFollowupPlan,
  ServerToolHandler,
  ServerToolHandlerContext,
  ServerToolHandlerPlan,
  ServerToolHandlerResult,
  ToolCall
} from './types.js';

export interface ServertoolExecutedRecord {
  toolCall: {
    id: string;
    name: string;
    arguments: string;
    executionMode: string;
    stripAfterExecute: boolean;
  };
  execution?: {
    flowId: string;
    followup?: unknown;
    context?: unknown;
  };
}

export interface ServertoolExecutionLoopState {
  executedToolCalls: ServertoolExecutedRecord[];
  executedIds: Set<string>;
  executedFlowIds: string[];
  lastExecution?: {
    flowId: string;
    followup?: unknown;
    context?: unknown;
  };
}

export function createServertoolExecutionLoopStateFromNative(): ServertoolExecutionLoopState {
  return hydrateExecutionLoopState(createServertoolExecutionLoopStateWithNative());
}

export function appendExecutedToolRecordFromNative(
  state: ServertoolExecutionLoopState,
  toolCall: ServertoolExecutedRecord['toolCall'],
  execution?: ServertoolExecutedRecord['execution']
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

function buildHandlerRuntimeActionInput(
  planned: Partial<ServerToolHandlerPlan & ServerToolHandlerResult>,
  options: ServerSideToolEngineOptions
): Parameters<typeof planServertoolHandlerRuntimeActionWithNative>[0] {
  const execution = planned.execution as { flowId?: unknown } | undefined;
  const backend = planned.backend as { kind?: unknown } | undefined;
  return {
    hasFinalizeFunction: typeof planned.finalize === 'function',
    hasChatResponseObject: Boolean(planned.chatResponse && typeof planned.chatResponse === 'object' && !Array.isArray(planned.chatResponse)),
    hasExecutionObject: Boolean(planned.execution && typeof planned.execution === 'object' && !Array.isArray(planned.execution)),
    hasExecutionFlowId: typeof execution?.flowId === 'string',
    hasPlanMarkers: typeof planned.flowId === 'string' || planned.backend !== undefined || planned.finalize !== undefined,
    hasBackendPlan: planned.backend !== undefined,
    ...(typeof backend?.kind === 'string' ? { backendKind: backend.kind } : {}),
    hasReenterPipeline: false
  };
}

export const materializeServertoolPlannedResult = async (
  planned: ServerToolHandlerPlan | ServerToolHandlerResult,
  options: ServerSideToolEngineOptions
): Promise<ServerToolHandlerResult | null> => {
  const actionPlan = planServertoolHandlerRuntimeActionWithNative(
    buildHandlerRuntimeActionInput(planned as Partial<ServerToolHandlerPlan & ServerToolHandlerResult>, options)
  );
  if (
    actionPlan.action === 'execute_backend_vision_analysis_then_finalize' ||
    actionPlan.action === 'execute_backend_web_search_then_finalize' ||
    actionPlan.action === 'unsupported_backend_plan_kind' ||
    actionPlan.action === 'finalize_without_backend'
  ) {
    const plan = planned as ServerToolHandlerPlan;
    if (
      actionPlan.action === 'execute_backend_vision_analysis_then_finalize' ||
      actionPlan.action === 'execute_backend_web_search_then_finalize' ||
      actionPlan.action === 'unsupported_backend_plan_kind'
    ) {
      throw buildProviderProtocolError(
        planServertoolHandlerContractErrorWithNative({
          kind: 'unsupported_backend_plan_kind',
          requestId: options.requestId,
          backendKind: actionPlan.backendKind ?? String((plan.backend as { kind?: unknown } | undefined)?.kind ?? '')
        })
      );
    }
    return await plan.finalize({});
  }
  if (actionPlan.action === 'invalid_plan_missing_finalize') {
    throw buildProviderProtocolError(
      planServertoolHandlerContractErrorWithNative({
        kind: 'invalid_handler_plan_missing_finalize',
        requestId: options.requestId
      })
    );
  }
  if (actionPlan.action === 'invalid_plan_result') {
    throw buildProviderProtocolError(
      planServertoolHandlerContractErrorWithNative({
        kind: 'invalid_handler_plan_result',
        requestId: options.requestId
      })
    );
  }
  return planned as ServerToolHandlerResult;
};

export const runServertoolHandler = async (
  handler: (ctx: ServerToolHandlerContext) => Promise<ServerToolHandlerPlan | ServerToolHandlerResult | null>,
  ctx: ServerToolHandlerContext
): Promise<ServerToolHandlerPlan | ServerToolHandlerResult | null> => {
  try {
    return await handler(ctx);
  } catch (error) {
    const toolName =
      ctx && ctx.toolCall && typeof ctx.toolCall.name === 'string' && ctx.toolCall.name.trim()
        ? ctx.toolCall.name.trim()
        : 'auto';
    const message = error instanceof Error ? error.message : String(error ?? 'unknown');
    const wrapped = buildProviderProtocolError(
      planServertoolHandlerContractErrorWithNative({
        kind: 'handler_failed',
        toolName,
        requestId: ctx.requestId,
        entryEndpoint: ctx.entryEndpoint,
        providerProtocol: ctx.providerProtocol,
        error: message
      })
    ) as ProviderProtocolError & { status?: number; cause?: unknown };
    wrapped.cause = error;
    throw wrapped;
  }
};

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
    ...(state.lastExecution ? { lastExecution: state.lastExecution as ServertoolExecutedRecord['execution'] } : {})
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
