import type { JsonObject } from '../conversion/hub/types/json.js';
import type {
  ServerSideToolEngineOptions,
  ToolCall
} from './types.js';
import { runPreCommandHooks } from './pre-command-hooks.js';
export {
  materializeServertoolPlannedResult,
  runServertoolHandler,
  type ServertoolExecutedRecord,
  type ServertoolExecutionLoopState
} from './execution-handler-materialization-shell.js';
export {
  appendExecutedToolRecord,
  assertDispatchExecutionMode,
  buildServertoolDispatchPlanInputThinShell,
  buildServertoolOutcomePlanInputThinShell,
  createServertoolExecutionLoopState,
  materializeNativeToolCallExecutionOutcome as resolveToolCallExecutionOutcomeThinShell,
  runServertoolIoExecutionQueue as runToolCallExecutionLoopThinShell
} from './execution-dispatch-outcome-shell.js';

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
