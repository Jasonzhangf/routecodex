import { isJsonObject, type JsonObject, type JsonValue } from '../conversion/hub/types/json.js';
import type { ServerSideToolEngineOptions } from './types.js';
import { getServerToolHandler } from './registry-orchestration-shell.js';
import {
  planServertoolNoopOutcomeWithNative,
  buildServertoolHandlerErrorToolOutputPayloadWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  planServertoolToolCallDispatchWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  planServertoolExecutionDispatchErrorWithNative,
  appendServertoolExecutedRecordWithNative,
  createServertoolExecutionLoopStateWithNative,
  materializeServertoolPlannedResultWithNative as materializeServertoolPlannedResult,
  planServertoolHandlerErrorExecutionLoopEffectWithNative,
  planServertoolNoopExecutionLoopEffectWithNative,
  resolveServertoolExecutionLoopInitialDecisionWithNative,
  resolveServertoolExecutionLoopResultDecisionWithNative,
  applyServertoolExecutionLoopInitialDecisionWithNative,
  applyServertoolExecutionLoopResultDecisionWithNative,
  runStoplessBuiltinHandlerForRuntimeWithNative,
  type NativeServertoolExecutedRecord,
  type NativeServertoolExecutionLoopState
} from '../native/router-hotpath/native-servertool-core-semantics.js';
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
    const initialLoopDecision = resolveServertoolExecutionLoopInitialDecisionWithNative({
      hasHandlerEntry: entry != null,
      triggerMode: entry?.trigger,
      nativeExecutionMode: entry?.registration.executionMode,
      tsExecutionMode: toolCall.executionMode
    });
    const shouldContinueToHandler = applyServertoolExecutionLoopInitialDecisionWithNative(initialLoopDecision, {
      skipNonToolCallHandler: () => false,
      throwDispatchSpecMismatch: () => {
        throw createServertoolProviderProtocolErrorFromPlan(
          planServertoolExecutionDispatchErrorWithNative({
            kind: 'dispatch_spec_mismatch',
            requestId: args.options.requestId,
            toolName: toolCall.name,
            nativeExecutionMode: entry.registration.executionMode,
            tsExecutionMode: toolCall.executionMode
          })
        );
      },
      continueToHandler: () => true
    });
    if (!shouldContinueToHandler) {
      continue;
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
    const resultLoopDecision = resolveServertoolExecutionLoopResultDecisionWithNative({
      triggerMode: entry.trigger,
      hasMaterializedResult: result != null,
      hasHandlerError
    });
    const shouldContinueLoop = applyServertoolExecutionLoopResultDecisionWithNative(resultLoopDecision, {
      applyMaterializedResult: () => {
        replaceJsonObjectInPlace(args.baseForExecution, result.chatResponse);
        executionState = appendServertoolExecutedRecordWithNative({
          state: executionState,
          toolCall,
          execution: result.execution
        });
        return true;
      },
      applyHandlerErrorToolOutput: () => {
        const errorEffectPlan = planServertoolHandlerErrorExecutionLoopEffectWithNative({
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
          base: args.baseForExecution,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          message: errorEffectPlan.handlerErrorMessage
        }) as JsonValue;
        if (!isJsonObject(toolOutputPayload)) {
          throw new Error('[servertool] native handler-error tool output payload must be a JSON object');
        }
        replaceJsonObjectInPlace(args.baseForExecution, toolOutputPayload);
        executionState = appendServertoolExecutedRecordWithNative({
          state: executionState,
          toolCall: errorEffectPlan.toolCall,
          execution: errorEffectPlan.execution
        });
        return true;
      },
      continueWithoutEffect: () => false
    });
    if (shouldContinueLoop) {
      continue;
    }
  }

  for (const toolCall of args.dispatchPlan.noopToolCalls ?? []) {
    const noopResult = planServertoolNoopOutcomeWithNative({
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      toolArguments: toolCall.arguments,
      base: args.baseForExecution
    });

    replaceJsonObjectInPlace(args.baseForExecution, noopResult.chatResponse);

    const noopEffectPlan = planServertoolNoopExecutionLoopEffectWithNative({
      toolCall: {
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
        executionMode: toolCall.executionMode ?? 'noop',
        stripAfterExecute: toolCall.stripAfterExecute === true
      },
      noopOutcome: noopResult
    });
    executionState = appendServertoolExecutedRecordWithNative({
      state: executionState,
      toolCall: noopEffectPlan.toolCall,
      execution: noopEffectPlan.execution
    });
  }

  return executionState;
}
