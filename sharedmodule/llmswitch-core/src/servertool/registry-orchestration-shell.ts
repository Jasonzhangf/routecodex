import {
  planServertoolBuiltinAutoHandlerEntriesWithNative,
  resolveServertoolRegistryHandlerWithNative
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
  const entry = resolveServertoolRegistryHandlerWithNative({
    name: typeof name === 'string' ? name : '',
  });
  return entry ? entry as unknown as ServerToolHandlerEntry : undefined;
};

export const listAutoServerToolHooks = (): ServerToolAutoHookDescriptor[] => {
  const entries = planServertoolBuiltinAutoHandlerEntriesWithNative().entries as unknown as ServerToolHandlerEntry[];
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
    registration: entry.registration as unknown as ServerToolHandlerEntry['registration'],
    execution: entry.execution as ServerToolHandlerEntry['execution']
  }));
};
