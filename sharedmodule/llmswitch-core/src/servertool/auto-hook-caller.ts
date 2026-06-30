import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext,
  ServerToolHandlerResult
} from './types.js';
import { listAutoServerToolHooks } from './registry-orchestration-shell.js';
import type { ServerToolAutoHookTraceEvent } from './types.js';
import {
  planAutoHookCallerFinalizationWithNative,
  planAutoHookRuntimeAttemptWithNative,
  runStoplessBuiltinHandlerForRuntimeWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  planServertoolAutoHookQueuesWithNative,
  planServertoolSkeletonDerivedConfigWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import { materializeServertoolPlannedResult } from './execution-handler-materialization-shell.js';
import type { ServerToolExecutionDescriptor } from './registry-types.js';

type AutoHookExecutionItem = {
  id: string;
  phase: string;
  priority: number;
  order: number;
  execution: ServerToolExecutionDescriptor;
};

function buildAutoHookQueuesFromNativePlan(args: {
  hooks: AutoHookExecutionItem[];
  includeAutoHookIds: Set<string> | null;
  excludeAutoHookIds: Set<string> | null;
}): {
  optionalQueue: AutoHookExecutionItem[];
  mandatoryQueue: AutoHookExecutionItem[];
} {
  const queueConfig = planServertoolSkeletonDerivedConfigWithNative().autoHookQueueConfig as {
    optionalPrimaryOrder: string[];
    mandatoryOrder: string[];
  };
  const nativePlan = planServertoolAutoHookQueuesWithNative({
    hooks: args.hooks.map((hook, sourceIndex) => ({
      id: hook.id,
      phase: hook.phase,
      priority: hook.priority,
      order: hook.order,
      sourceIndex
    })),
    ...(args.includeAutoHookIds ? { includeAutoHookIds: [...args.includeAutoHookIds] } : {}),
    ...(args.excludeAutoHookIds ? { excludeAutoHookIds: [...args.excludeAutoHookIds] } : {}),
    optionalPrimaryHookOrder: queueConfig.optionalPrimaryOrder,
    mandatoryHookOrder: queueConfig.mandatoryOrder
  });
  const mapQueue = (entries: Array<{ sourceIndex: number }>): AutoHookExecutionItem[] =>
    entries.map((entry) => {
      const hook = args.hooks[entry.sourceIndex];
      if (!hook) {
        throw new Error(
          `[servertool] native auto-hook queue returned invalid sourceIndex: ${entry.sourceIndex}`
        );
      }
      return hook;
    });
  return {
    optionalQueue: mapQueue(nativePlan.optionalQueue),
    mandatoryQueue: mapQueue(nativePlan.mandatoryQueue)
  };
}

async function runAutoHookExecutionQueue(args: {
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
      planned = await runStoplessBuiltinHandlerForRuntimeWithNative({
        name: hook.execution.builtinName,
        base: args.contextBase.base,
        requestId: args.contextBase.requestId,
        runtimeMetadata: args.contextBase.runtimeMetadata ?? null
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? 'unknown');
      const attemptPlan = planAutoHookRuntimeAttemptWithNative({
        ...traceBase,
        message
      });
      args.options.onAutoHookTrace?.(attemptPlan.traceEvent as ServerToolAutoHookTraceEvent);
      throw error;
    }

    let result: ServerToolHandlerResult | null = null;

    if (planned) {
      result = await materializeServertoolPlannedResult(planned as any, args.options);
    }

    const attemptPlan = planAutoHookRuntimeAttemptWithNative({
      ...traceBase,
      hasPlannedResult: Boolean(planned),
      hasMaterializedResult: Boolean(result),
      ...(result?.execution && typeof result.execution.flowId === 'string'
        ? { materializedFlowId: result.execution.flowId }
        : {})
    });
    args.options.onAutoHookTrace?.(attemptPlan.traceEvent as ServerToolAutoHookTraceEvent);

    if (attemptPlan.returnResult) {
      if (!result) {
        throw new Error('[servertool] native auto-hook execution requested result but materialization was empty');
      }
      return result;
    }
    if (attemptPlan.continueQueue) {
      continue;
    }
    throw new Error(
      '[servertool] native auto-hook execution returned no materialized disposition',
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
  const { optionalQueue, mandatoryQueue } = buildAutoHookQueuesFromNativePlan({
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
  const finalQueueName = queueOrder[queueOrder.length - 1]?.queueName;

  for (const queue of queueOrder) {
    const queueResult = await runAutoHookExecutionQueue({
      queueName: queue.queueName,
      hooks: queue.hooks,
      options: args.options,
      contextBase: args.contextBase
    });
    const finalQueue = queue.queueName === finalQueueName;
    const finalizationPlan = planAutoHookCallerFinalizationWithNative({
      resultPresent: Boolean(queueResult),
      finalQueue
    });
    if (finalizationPlan.returnResult) {
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
    if (finalizationPlan.continueNextQueue) {
      continue;
    }
    if (finalizationPlan.returnNull) {
      return null;
    }
  }

  return null;
}
