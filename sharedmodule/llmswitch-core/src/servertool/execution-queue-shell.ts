import type { JsonObject } from '../conversion/hub/types/json.js';
import type {
  ServerSideToolEngineOptions,
  ServerToolExecution,
  ToolCall
} from './types.js';
import { getServerToolHandler, listAdHocRegisteredToolCallHandlerSpecs } from './registry.js';
import {
  planServertoolNoopOutcomeWithNative,
  buildServertoolDispatchPlanInputWithNative,
  planServertoolToolCallDispatchWithNative,
  buildServertoolHandlerErrorToolOutputPayloadWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import {
  planServertoolExecutionDispatchErrorWithNative,
  planServertoolExecutionLoopEffectWithNative,
  planServertoolExecutionLoopRuntimeActionWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  appendExecutedToolRecordFromNative,
  createServertoolExecutionLoopStateFromNative,
  executeBuiltinServerToolHandler,
  materializeServertoolPlannedResult,
  type ServertoolExecutedRecord,
  type ServertoolExecutionLoopState,
  runServertoolHandler
} from './execution-handler-materialization-shell.js';
import { replaceJsonObjectInPlace } from './orchestration-blocks.js';
import { createServertoolProviderProtocolErrorFromPlan } from './timeout-error-block.js';

export type { ServertoolExecutedRecord, ServertoolExecutionLoopState };

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

export async function runServertoolIoExecutionQueue(args: {
  dispatchPlan: ReturnType<typeof planServertoolToolCallDispatchWithNative>;
  options: ServerSideToolEngineOptions;
  contextBase: Omit<import('./types.js').ServerToolHandlerContext, 'toolCall'>;
  baseForExecution: JsonObject;
}): Promise<ServertoolExecutionLoopState> {
  const executionState = createServertoolExecutionLoopStateFromNative();

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
      planned = entry.execution.kind === 'builtin'
        ? await executeBuiltinServerToolHandler({
            builtinName: entry.execution.builtinName,
            ctx
          })
        : await runServertoolHandler(entry.execution.handler, ctx);
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
      appendExecutedToolRecordFromNative(executionState, toolCall, result.execution);
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
      appendExecutedToolRecordFromNative(
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
      followup: noopFollowup
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
      noopFollowup
    });
    appendExecutedToolRecordFromNative(
      executionState,
      noopEffectPlan.toolCall as ServertoolExecutedRecord['toolCall'],
      noopEffectPlan.execution as ServerToolExecution
    );
  }

  return executionState;
}
