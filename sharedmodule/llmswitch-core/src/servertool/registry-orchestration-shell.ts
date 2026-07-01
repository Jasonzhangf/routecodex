import {
  planServertoolBuiltinAutoHandlerEntriesWithNative,
  planServertoolRegistryLookupFromSkeletonWithNative,
  resolveServertoolBuiltinHandlerEntryWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import {
  planServertoolRegistryBuiltinAutoHookEntriesWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import type {
  ServerToolAutoHookDescriptor,
  ServerToolHandlerEntry
} from './types.js';

export const getServerToolHandler = (
  name: string
): ServerToolHandlerEntry | undefined => {
  const actionPlan = planServertoolRegistryLookupFromSkeletonWithNative({
    name: typeof name === 'string' ? name : ''
  });
  switch (actionPlan.action) {
    case 'return_builtin': {
      const entry = resolveServertoolBuiltinHandlerEntryWithNative({
        name: actionPlan.canonicalName as string
      });
      return entry ? entry as unknown as ServerToolHandlerEntry : undefined;
    }
    case 'return_none':
      return undefined;
    default:
      throw new Error(`[servertool] invalid registry lookup action: ${String(actionPlan.action)}`);
  }
};

export const listAutoServerToolHooks = (): ServerToolAutoHookDescriptor[] => {
  const entries = planServertoolBuiltinAutoHandlerEntriesWithNative().entries as unknown as ServerToolHandlerEntry[];
  return planServertoolRegistryBuiltinAutoHookEntriesWithNative({
    hooks: entries.map((entry) => ({
      id: entry.name,
      phase: entry.autoHook?.phase,
      priority: entry.autoHook?.priority,
      order: entry.autoHook?.order,
      registration: entry.registration as unknown as Record<string, unknown>,
      execution: entry.execution as Record<string, unknown>
    }))
  }).map((entry) => ({
    id: entry.id,
    phase: entry.phase,
    priority: entry.priority,
    order: entry.order,
    registration: entry.registration as unknown as ServerToolHandlerEntry['registration'],
    execution: entry.execution as ServerToolHandlerEntry['execution']
  }));
};
