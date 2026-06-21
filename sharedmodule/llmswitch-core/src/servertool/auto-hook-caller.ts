import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext,
  ServerToolHandlerPlan,
  ServerToolHandlerResult
} from './types.js';
import { buildAutoHookQueuesFromConfig } from './orchestration-blocks.js';
import { listAutoServerToolHooks } from './registry.js';
import type { ServerToolAutoHookTraceEvent } from './types.js';

function toEngineResult(result: ServerToolHandlerResult): ServerSideToolEngineResult {
  return {
    mode: 'tool_flow',
    finalChatResponse: result.chatResponse,
    execution: result.execution
  };
}

export async function runAutoHookExecutionQueue(args: {
  queueName: ServerToolAutoHookTraceEvent['queue'];
  hooks: Array<{
    id: string;
    phase: string;
    priority: number;
    handler: (ctx: ServerToolHandlerContext) => Promise<ServerToolHandlerPlan | ServerToolHandlerResult | null>;
  }>;
  options: ServerSideToolEngineOptions;
  contextBase: ServerToolHandlerContext;
}): Promise<ServerToolHandlerResult | null> {
  const { runServertoolHandler, materializeServertoolPlannedResult } = await import('./execution-shell.js');
  const queueTotal = args.hooks.length;
  for (let idx = 0; idx < args.hooks.length; idx += 1) {
    const hook = args.hooks[idx];
    const traceBase = {
      hookId: hook.id,
      phase: hook.phase,
      priority: hook.priority,
      queue: args.queueName,
      queueIndex: idx + 1,
      queueTotal
    };

    let planned: unknown = null;
    try {
      planned = await runServertoolHandler(hook.handler, args.contextBase);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? 'unknown');
      try {
        args.options.onAutoHookTrace?.({
          ...traceBase,
          result: 'error',
          reason: message
        } as ServerToolAutoHookTraceEvent);
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
        } as ServerToolAutoHookTraceEvent);
      } catch {
        // best-effort
      }
      continue;
    }

    const result = await materializeServertoolPlannedResult(planned as any, args.options);
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
        } as ServerToolAutoHookTraceEvent);
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
      } as ServerToolAutoHookTraceEvent);
    } catch {
      // best-effort
    }
  }

  return null;
}

export async function runServertoolAutoHookCallerViaThinShell(args: {
  options: ServerSideToolEngineOptions;
  contextBase: ServerToolHandlerContext;
  includeAutoHookIds: Set<string> | null;
  excludeAutoHookIds: Set<string> | null;
}): Promise<ServerSideToolEngineResult | null> {
  const autoHookExecutionList = listAutoServerToolHooks();
  const { optionalQueue, mandatoryQueue } = buildAutoHookQueuesFromConfig({
    hooks: autoHookExecutionList,
    includeAutoHookIds: args.includeAutoHookIds,
    excludeAutoHookIds: args.excludeAutoHookIds
  });

  const optionalResult = await runAutoHookExecutionQueue({
    queueName: 'A_optional',
    hooks: optionalQueue,
    options: args.options,
    contextBase: args.contextBase
  });
  if (optionalResult) {
    return toEngineResult(optionalResult);
  }

  const mandatoryResult = await runAutoHookExecutionQueue({
    queueName: 'B_mandatory',
    hooks: mandatoryQueue,
    options: args.options,
    contextBase: args.contextBase
  });
  if (mandatoryResult) {
    return toEngineResult(mandatoryResult);
  }

  return null;
}
