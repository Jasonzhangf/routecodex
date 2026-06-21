import type { JsonObject } from '../conversion/hub/types/json.js';
import type {
  ServerSideToolEngineOptions,
  ServerToolAutoHookTraceEvent,
  ServerToolHandler,
  ServerToolHandlerContext,
  ServerToolHandlerResult,
  ToolCall
} from './types.js';
import { runPreCommandHooks } from './pre-command-hooks.js';
import {
  materializeServertoolPlannedResult as materializeServertoolPlannedResultShell,
  runServertoolHandler,
  type ServertoolExecutedRecord,
  type ServertoolExecutionLoopState
} from './execution-handler-materialization-shell.js';
import {
  applyServertoolExecutionResult as applyServertoolExecutionResultShell,
  appendExecutedToolRecord as appendExecutedToolRecordShell,
  assertDispatchExecutionMode as assertDispatchExecutionModeShell,
  buildServertoolDispatchPlanInputThinShell as buildServertoolDispatchPlanInputThinShellShell,
  buildServertoolOutcomePlanInputThinShell as buildServertoolOutcomePlanInputThinShellShell,
  createServertoolExecutionLoopState as createServertoolExecutionLoopStateShell,
  resolveToolCallExecutionOutcomeThinShell as resolveToolCallExecutionOutcomeThinShellShell,
  runToolCallExecutionLoopThinShell as runToolCallExecutionLoopThinShellShell
} from './execution-dispatch-outcome-shell.js';

export type { ServertoolExecutedRecord, ServertoolExecutionLoopState };

export interface ServertoolAutoHookDescriptor {
  id: string;
  phase: string;
  priority: number;
  handler: ServerToolHandler;
}

export const createServertoolExecutionLoopState = createServertoolExecutionLoopStateShell;

export const appendExecutedToolRecord = appendExecutedToolRecordShell;

export const assertDispatchExecutionMode = assertDispatchExecutionModeShell;

export const materializeServertoolPlannedResult =
  materializeServertoolPlannedResultShell;

export { runServertoolHandler };

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

export const applyServertoolExecutionResult = applyServertoolExecutionResultShell;

export const buildServertoolDispatchPlanInputThinShell =
  buildServertoolDispatchPlanInputThinShellShell;

export const buildServertoolOutcomePlanInputThinShell =
  buildServertoolOutcomePlanInputThinShellShell;

export const resolveToolCallExecutionOutcomeThinShell =
  resolveToolCallExecutionOutcomeThinShellShell;

export const runToolCallExecutionLoopThinShell =
  runToolCallExecutionLoopThinShellShell;

export async function runAutoHookExecutionQueue(args: {
  queueName: ServerToolAutoHookTraceEvent['queue'];
  hooks: ServertoolAutoHookDescriptor[];
  options: ServerSideToolEngineOptions;
  contextBase: ServerToolHandlerContext;
}): Promise<ServerToolHandlerResult | null> {
  const { runAutoHookExecutionQueue } = await import('./auto-hook-caller.js');
  return await runAutoHookExecutionQueue(args as never);
}
