import type {
  ServerToolAutoHookDescriptor,
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext,
  ServerToolHandlerResult
} from './types.js';
import type { ServerToolAutoHookTraceEvent } from './types.js';
import {
  materializeServertoolPlannedResultWithNative as materializeServertoolPlannedResult,
  planServertoolBuiltinAutoHandlerEntriesWithNative,
  planServertoolRegistryBuiltinAutoHookEntriesWithNative,
  resolveAutoHookCallerFinalizationDecisionWithNative,
  resolveAutoHookRuntimeAttemptDecisionWithNative,
  runStoplessBuiltinHandlerForRuntimeWithNative
} from 'rcc-llmswitch-core/native/servertool-wrapper';
import {
  planServertoolAutoHookQueueItemsWithNative
} from 'rcc-llmswitch-core/native/servertool-wrapper';

function assertServerToolAutoHookDescriptor(value: unknown): asserts value is ServerToolAutoHookDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('[servertool] native auto-hook queue entry must be an object');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    typeof record.phase !== 'string' ||
    typeof record.priority !== 'number' ||
    typeof record.order !== 'number' ||
    !record.registration ||
    typeof record.registration !== 'object' ||
    Array.isArray(record.registration) ||
    !record.execution ||
    typeof record.execution !== 'object' ||
    Array.isArray(record.execution)
  ) {
    throw new Error('[servertool] native auto-hook queue entry must be a ServerToolAutoHookDescriptor');
  }
}

function readNativeAutoHookQueueEntries(entries: unknown[]): ServerToolAutoHookDescriptor[] {
  return entries.map((entry) => {
    assertServerToolAutoHookDescriptor(entry);
    return entry;
  });
}

const listAutoServerToolHooks = (): ServerToolAutoHookDescriptor[] => {
  const entries = planServertoolBuiltinAutoHandlerEntriesWithNative().entries as unknown as Array<{
    name: string;
    autoHook?: {
      phase?: string;
      priority?: number;
      order?: number;
    };
    registration: unknown;
    execution: unknown;
  }>;
  return planServertoolRegistryBuiltinAutoHookEntriesWithNative({
    hooks: entries.map((entry) => ({
      id: entry.name,
      phase: entry.autoHook?.phase,
      priority: entry.autoHook?.priority,
      order: entry.autoHook?.order,
      registration: entry.registration,
      execution: entry.execution
    }))
  }).map((entry) => ({
    id: entry.id,
    phase: entry.phase,
    priority: entry.priority,
    order: entry.order,
    registration: entry.registration as unknown as ServerToolAutoHookDescriptor['registration'],
    execution: entry.execution as ServerToolAutoHookDescriptor['execution']
  }));
};

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
  const nativePlan = planServertoolAutoHookQueueItemsWithNative({
    hooks: args.hooks,
    includeAutoHookIds: args.includeAutoHookIds != null ? [...args.includeAutoHookIds] : null,
    excludeAutoHookIds: args.excludeAutoHookIds != null ? [...args.excludeAutoHookIds] : null
  });
  return {
    queueOrder: nativePlan.queueOrder.map((queue) => ({
      queueName: queue.queue,
      hooks: readNativeAutoHookQueueEntries(queue.entries)
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
      const attemptDecision = resolveAutoHookRuntimeAttemptDecisionWithNative({
        ...traceBase,
        error
      });
      args.options.onAutoHookTrace?.(attemptDecision.traceEvent);
      if (attemptDecision.rethrowError) {
        throw error;
      }
      if (attemptDecision.returnResult) {
        throw new Error('[servertool] invalid auto-hook attempt result action without materialized result');
      }
      if (!attemptDecision.continueQueue) {
        throw new Error('[servertool] invalid auto-hook attempt action');
      }
      continue;
    }

    const result = planned != null
      ? await materializeServertoolPlannedResult(planned, args.options)
      : null;

    const attemptDecision = resolveAutoHookRuntimeAttemptDecisionWithNative({
      ...traceBase,
      hasPlannedResult: planned != null,
      hasMaterializedResult: result != null,
      ...(result?.execution != null && typeof result.execution.flowId === 'string'
        ? { materializedFlowId: result.execution.flowId }
        : {})
    });
    args.options.onAutoHookTrace?.(attemptDecision.traceEvent);

    if (attemptDecision.returnResult) {
      if (result == null) {
        throw new Error('[servertool] invalid auto-hook attempt result action without materialized result');
      }
      return result;
    }
    if (attemptDecision.rethrowError) {
      throw new Error(
        `[servertool] native auto-hook attempt requested rethrow after successful handler execution: ${hook.id}`
      );
    }
    if (!attemptDecision.continueQueue) {
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
    const finalizationDecision = resolveAutoHookCallerFinalizationDecisionWithNative({
      resultPresent: queueResult != null,
      metadataWritePlanPresent: queueResult?.metadataWritePlan != null,
      chatResponse: queueResult?.chatResponse,
      execution: queueResult?.execution,
      metadataWritePlan: queueResult?.metadataWritePlan,
      queueIndex: queueIndex + 1,
      queueTotal: queueOrder.length
    });
    if (finalizationDecision.returnResult) {
      if (finalizationDecision.result == null) {
        throw new Error('[servertool] invalid auto-hook caller finalization result disposition');
      }
      return finalizationDecision.result;
    }
    if (finalizationDecision.returnNull) {
      return null;
    }
    if (!finalizationDecision.continueNextQueue) {
      throw new Error('[servertool] invalid auto-hook caller finalization action');
    }
  }

  return null;
}
