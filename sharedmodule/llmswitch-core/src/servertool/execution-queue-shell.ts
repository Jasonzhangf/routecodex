import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ServerSideToolEngineOptions } from './types.js';
import { getServerToolHandler } from './registry-orchestration-shell.js';
import {
  planServertoolNoopOutcomeWithNative,
  planServertoolToolCallDispatchWithNative,
  buildServertoolHandlerErrorToolOutputPayloadWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import {
  planServertoolExecutionDispatchErrorWithNative,
  planServertoolExecutionLoopEffectWithNative,
  planServertoolExecutionLoopRuntimeActionWithNative,
  appendServertoolExecutedRecordWithNative,
  createServertoolExecutionLoopStateWithNative,
  runStoplessBuiltinHandlerForRuntimeWithNative,
  type NativeServertoolExecutedRecord,
  type NativeServertoolExecutionLoopState
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import { materializeServertoolPlannedResult } from './execution-handler-materialization-shell.js';
import { replaceJsonObjectInPlace } from './orchestration-blocks.js';
import { createServertoolProviderProtocolErrorFromPlan } from './timeout-error-block.js';

export type {
  NativeServertoolExecutedRecord as ServertoolExecutedRecord,
  NativeServertoolExecutionLoopState as ServertoolExecutionLoopState
};

export async function runServertoolIoExecutionQueue(args: {
  dispatchPlan: ReturnType<typeof planServertoolToolCallDispatchWithNative>;
  options: ServerSideToolEngineOptions;
  contextBase: Omit<import('./types.js').ServerToolHandlerContext, 'toolCall'>;
  baseForExecution: JsonObject;
}): Promise<NativeServertoolExecutionLoopState> {
  let executionState = createServertoolExecutionLoopStateWithNative();

  for (const toolCall of args.dispatchPlan.executableToolCalls) {
    const entry = getServerToolHandler(toolCall.name);
    const initialLoopActionPlan = planServertoolExecutionLoopRuntimeActionWithNative({
      hasHandlerEntry: entry != null,
      triggerMode: entry?.trigger,
      nativeExecutionMode: entry?.registration.executionMode,
      tsExecutionMode: toolCall.executionMode,
      hasMaterializedResult: false,
      hasHandlerError: false
    });
    switch (initialLoopActionPlan.action) {
      case 'skip_non_tool_call_handler':
        continue;
      case 'throw_dispatch_spec_mismatch':
        throw createServertoolProviderProtocolErrorFromPlan(
          planServertoolExecutionDispatchErrorWithNative({
            kind: 'dispatch_spec_mismatch',
            requestId: args.options.requestId,
            toolName: toolCall.name,
            nativeExecutionMode: entry.registration.executionMode,
            tsExecutionMode: toolCall.executionMode
          })
        );
      case 'continue_without_effect':
        break;
      default:
        throw new Error('[servertool] invalid execution loop initial action');
    }
    const ctx = { ...args.contextBase, base: args.baseForExecution, toolCall };
    let planned = null;
    let lastErr: unknown;
    let hasHandlerError = false;
    try {
      planned = await runStoplessBuiltinHandlerForRuntimeWithNative({
        name: entry.execution.builtinName,
        base: ctx.base,
        requestId: ctx.requestId,
        runtimeMetadata: ctx.runtimeMetadata ?? null
      });
    } catch (err) {
      lastErr = err;
      hasHandlerError = true;
    }
    const result = planned != null ? await materializeServertoolPlannedResult(planned, args.options) : null;
    const resultLoopActionPlan = planServertoolExecutionLoopRuntimeActionWithNative({
      hasHandlerEntry: true,
      triggerMode: entry.trigger,
      hasMaterializedResult: result != null,
      hasHandlerError
    });
    switch (resultLoopActionPlan.action) {
      case 'apply_materialized_result':
        replaceJsonObjectInPlace(args.baseForExecution, result.chatResponse as JsonObject);
        executionState = appendServertoolExecutedRecordWithNative({
          state: executionState,
          toolCall,
          execution: result.execution
        });
        continue;
      case 'apply_handler_error_tool_output': {
        const errorEffectPlan = planServertoolExecutionLoopEffectWithNative({
          mode: 'handler_error',
          toolCall: {
            id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
            executionMode: toolCall.executionMode,
            stripAfterExecute: toolCall.stripAfterExecute
          },
          handlerErrorMessage: lastErr
        });
        const toolOutputPayload = buildServertoolHandlerErrorToolOutputPayloadWithNative({
          base: args.baseForExecution as Record<string, unknown>,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          message: errorEffectPlan.handlerErrorMessage
        }) as JsonObject;
        replaceJsonObjectInPlace(args.baseForExecution, toolOutputPayload);
        executionState = appendServertoolExecutedRecordWithNative({
          state: executionState,
          toolCall: errorEffectPlan.toolCall,
          execution: errorEffectPlan.execution
        });
        break;
      }
      case 'continue_without_effect':
        break;
      default:
        throw new Error('[servertool] invalid execution loop result action');
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
      flowId: noopFlowId
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
      noopFlowId
    });
    executionState = appendServertoolExecutedRecordWithNative({
      state: executionState,
      toolCall: noopEffectPlan.toolCall,
      execution: noopEffectPlan.execution
    });
  }

  return executionState;
}
