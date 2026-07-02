import type {
  ServerToolAutoHookDescriptor,
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

function buildAutoHookQueuesFromNativePlan(args: {
  hooks: ServerToolAutoHookDescriptor[];
  includeAutoHookIds: Set<string> | null;
  excludeAutoHookIds: Set<string> | null;
}): {
  queueOrder: Array<{
    queueName: ServerToolAutoHookTraceEvent['queue'];
    hooks: ServerToolAutoHookDescriptor[];
  }>;
} {
  const queueConfig = planServertoolSkeletonDerivedConfigWithNative().autoHookQueueConfig as {
    optionalPrimaryOrder: string[];
    mandatoryOrder: string[];
  };
  const nativePlan = planServertoolAutoHookQueueItemsWithNative({
    hooks: args.hooks,
    includeAutoHookIds: args.includeAutoHookIds != null ? [...args.includeAutoHookIds] : null,
    excludeAutoHookIds: args.excludeAutoHookIds != null ? [...args.excludeAutoHookIds] : null,
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
  hooks: ServerToolAutoHookDescriptor[];
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
      args.options.onAutoHookTrace?.(attemptPlan.traceEvent);
      throw error;
    }

    const result = planned != null
      ? await materializeServertoolPlannedResult(planned, args.options)
      : null;

    const attemptPlan = planAutoHookRuntimeAttemptWithNative({
      ...traceBase,
      hasPlannedResult: planned != null,
      hasMaterializedResult: result != null,
      ...(result?.execution != null && typeof result.execution.flowId === 'string'
        ? { materializedFlowId: result.execution.flowId }
        : {})
    });
    args.options.onAutoHookTrace?.(attemptPlan.traceEvent);

    switch (attemptPlan.action) {
      case 'return_result':
        if (result == null) {
          throw new Error('[servertool] invalid auto-hook attempt result action without materialized result');
        }
        return result;
      case 'continue_queue':
        continue;
      case 'rethrow_error':
        throw new Error(
          `[servertool] native auto-hook attempt requested rethrow after successful handler execution: ${hook.id}`
        );
      default:
        throw new Error('[servertool] invalid auto-hook attempt action');
    }
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
      resultPresent: queueResult != null,
      queueIndex: queueIndex + 1,
      queueTotal: queueOrder.length
    });
    switch (finalizationPlan.action) {
      case 'return_result': {
        if (queueResult == null) {
          throw new Error('[servertool] invalid auto-hook caller finalization result action without queue result');
        }
        return {
          mode: finalizationPlan.resultMode,
          finalChatResponse: queueResult.chatResponse,
          execution: queueResult.execution,
          ...(queueResult.metadataWritePlan != null
            ? { metadataWritePlan: queueResult.metadataWritePlan }
            : {})
        };
      }
      case 'continue_next_queue':
        continue;
      case 'return_null':
        return null;
      default:
        throw new Error('[servertool] invalid auto-hook caller finalization action');
    }
  }

  return null;
}
