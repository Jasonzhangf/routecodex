import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext,
  ServerToolHandlerPlan,
  ServerToolHandlerResult
} from './types.js';
import { buildAutoHookQueuesFromConfig } from './orchestration-blocks.js';
import { listAutoServerToolHooks } from './registry-orchestration-shell.js';
import type { ServerToolAutoHookTraceEvent } from './types.js';
import {
  planAutoHookExecutionDecisionWithNative,
  planAutoHookQueueProgressWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  materializeServertoolPlannedResult,
  executeBuiltinServerToolHandler,
  runServertoolHandler
} from './execution-handler-materialization-shell.js';
import type { ServerToolExecutionDescriptor } from './registry-types.js';

type AutoHookExecutionItem = {
  id: string;
  phase: string;
  priority: number;
  execution: ServerToolExecutionDescriptor;
};

export async function runAutoHookExecutionQueue(args: {
  queueName: ServerToolAutoHookTraceEvent['queue'];
  hooks: AutoHookExecutionItem[];
  options: ServerSideToolEngineOptions;
  contextBase: ServerToolHandlerContext;
}): Promise<ServerToolHandlerResult | null> {
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
      planned = hook.execution.kind === 'builtin'
        ? await executeBuiltinServerToolHandler({
            builtinName: hook.execution.builtinName,
            ctx: args.contextBase
          })
        : await runServertoolHandler(hook.execution.handler, args.contextBase);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? 'unknown');
      const decision = planAutoHookExecutionDecisionWithNative({
        ...traceBase,
        message
      });
      try {
        args.options.onAutoHookTrace?.(decision.traceEvent as ServerToolAutoHookTraceEvent);
      } catch {
        // best-effort
      }
      if (decision.action !== 'rethrow_error') {
        throw new Error(
          `[servertool] invalid native auto-hook execution error action: ${String(decision.action)}`,
        );
      }
      throw error;
    }

    let result: ServerToolHandlerResult | null = null;

    if (planned) {
      result = await materializeServertoolPlannedResult(planned as any, args.options);
    }

    const decision = planAutoHookExecutionDecisionWithNative({
      ...traceBase,
      hasPlannedResult: Boolean(planned),
      hasMaterializedResult: Boolean(result),
      ...(result?.execution && typeof result.execution.flowId === 'string' && result.execution.flowId.trim()
        ? { materializedFlowId: result.execution.flowId.trim() }
        : {})
    });
    try {
      args.options.onAutoHookTrace?.(decision.traceEvent as ServerToolAutoHookTraceEvent);
    } catch {
      // best-effort
    }

    if (decision.action === 'return_result') {
      if (!result) {
        throw new Error('[servertool] native auto-hook execution requested result but materialization was empty');
      }
      return result;
    }
    if (decision.action === 'continue_queue') {
      continue;
    }
    throw new Error(
      `[servertool] invalid native auto-hook execution action for non-error outcome: ${String(decision.action)}`,
    );
  }

  return null;
}

export async function runServertoolAutoHookCaller(args: {
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
  const queueOrder: Array<{
    queueName: ServerToolAutoHookTraceEvent['queue'];
    hooks: AutoHookExecutionItem[];
  }> = [
    { queueName: 'A_optional', hooks: optionalQueue },
    { queueName: 'B_mandatory', hooks: mandatoryQueue }
  ];

  for (const queue of queueOrder) {
    const queueResult = await runAutoHookExecutionQueue({
      queueName: queue.queueName,
      hooks: queue.hooks,
      options: args.options,
      contextBase: args.contextBase
    });
    const progressPlan = planAutoHookQueueProgressWithNative({
      queueOrder: queueOrder.map((entry) => entry.queueName),
      currentQueue: queue.queueName,
      resultPresent: Boolean(queueResult)
    });
    if (progressPlan.action === 'return_result') {
      if (!queueResult) {
        throw new Error('[servertool] native auto-hook queue progress requested result but queue result was empty');
      }
      return {
        mode: 'tool_flow',
        finalChatResponse: queueResult.chatResponse,
        execution: queueResult.execution,
        ...(queueResult.metadataWritePlan ? { metadataWritePlan: queueResult.metadataWritePlan } : {})
      };
    }
    if (progressPlan.action === 'continue_next_queue') {
      continue;
    }
    if (progressPlan.action === 'return_null') {
      return null;
    }
  }

  return null;
}
