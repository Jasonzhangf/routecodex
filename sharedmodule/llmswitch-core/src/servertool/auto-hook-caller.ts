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
  planServertoolAutoHookQueueItemsWithNative,
  planServertoolSkeletonDerivedConfigWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import { materializeServertoolPlannedResult } from './execution-handler-materialization-shell.js';
import type { ServerToolExecutionDescriptor } from './types.js';

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
  queueOrder: Array<{
    queueName: ServerToolAutoHookTraceEvent['queue'];
    hooks: AutoHookExecutionItem[];
  }>;
} {
  const queueConfig = planServertoolSkeletonDerivedConfigWithNative().autoHookQueueConfig as {
    optionalPrimaryOrder: string[];
    mandatoryOrder: string[];
  };
  const nativePlan = planServertoolAutoHookQueueItemsWithNative({
    hooks: args.hooks.map((hook) => ({
      id: hook.id,
      phase: hook.phase,
      priority: hook.priority,
      order: hook.order,
      execution: hook.execution
    })),
    ...(args.includeAutoHookIds ? { includeAutoHookIds: [...args.includeAutoHookIds] } : {}),
    ...(args.excludeAutoHookIds ? { excludeAutoHookIds: [...args.excludeAutoHookIds] } : {}),
    optionalPrimaryHookOrder: queueConfig.optionalPrimaryOrder,
    mandatoryHookOrder: queueConfig.mandatoryOrder
  });
  return {
    queueOrder: nativePlan.queueOrder.map((queue) => ({
      queueName: queue.queue,
      hooks: queue.entries
    }))
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
      const attemptPlan = planAutoHookRuntimeAttemptWithNative({
        ...traceBase,
        error
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
      return result as ServerToolHandlerResult;
    }
    continue;
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
  const { queueOrder } = buildAutoHookQueuesFromNativePlan({
    hooks: autoHookExecutionList,
    includeAutoHookIds: args.includeAutoHookIds,
    excludeAutoHookIds: args.excludeAutoHookIds
  });

  for (let queueIndex = 0; queueIndex < queueOrder.length; queueIndex += 1) {
    const queue = queueOrder[queueIndex];
    const queueResult = await runAutoHookExecutionQueue({
      queueName: queue.queueName,
      hooks: queue.hooks,
      options: args.options,
      contextBase: args.contextBase
    });
    const finalizationPlan = planAutoHookCallerFinalizationWithNative({
      resultPresent: Boolean(queueResult),
      queueIndex: queueIndex + 1,
      queueTotal: queueOrder.length
    });
    if (finalizationPlan.returnResult) {
      const queueResultForReturn = queueResult as ServerToolHandlerResult;
      return {
        mode: 'tool_flow',
        finalChatResponse: queueResultForReturn.chatResponse,
        execution: queueResultForReturn.execution,
        ...(queueResultForReturn.metadataWritePlan
          ? { metadataWritePlan: queueResultForReturn.metadataWritePlan }
          : {})
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
