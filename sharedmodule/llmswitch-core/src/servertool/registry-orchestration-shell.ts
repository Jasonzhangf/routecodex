import {
  getBuiltinHandlerEntry,
  listBuiltinAutoHandlerEntries
} from './builtin-handler-catalog.js';
import {
  planServertoolRegistryLookupFromSkeletonWithNative,
  resolveServertoolRegisteredNameWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import {
  planServertoolRegistryAutoHookDescriptorsWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import type {
  ServerToolAutoHookDescriptor,
  ServerToolHandlerEntry
} from './registry-types.js';

export {
  type ServerToolAutoHookDescriptor,
  type ServerToolHandlerEntry
} from './registry-types.js';

export const getServerToolHandler = (
  name: string
): ServerToolHandlerEntry | undefined => {
  const actionPlan = planServertoolRegistryLookupFromSkeletonWithNative({
    name: typeof name === 'string' ? name : ''
  });
  if (actionPlan.action === 'return_builtin') {
    if (!actionPlan.canonicalName) {
      throw new Error('[servertool] native registry lookup returned builtin without canonicalName');
    }
    return getBuiltinHandlerEntry(actionPlan.canonicalName);
  }
  return undefined;
};

export const listAutoServerToolHooks = (): ServerToolAutoHookDescriptor[] => {
  const entries = listBuiltinAutoHandlerEntries();
  return planServertoolRegistryAutoHookDescriptorsWithNative({
    hooks: entries.map((entry) => ({
      id: entry.name,
      phase: entry.autoHook?.phase,
      priority: entry.autoHook?.priority,
      order: entry.autoHook?.order
    }))
  }).map((descriptor) => {
    const entry = entries[descriptor.sourceIndex];
    if (!entry) {
      throw new Error(
        `[servertool] native registry auto-hook descriptor missing entry for sourceIndex: ${descriptor.sourceIndex}`
      );
    }
    return {
      id: descriptor.id,
      phase: descriptor.phase,
      priority: descriptor.priority,
      order: descriptor.order,
      registration: entry.registration,
      execution: entry.execution
    };
  });
};

export function isRegisteredServerToolName(name: string): boolean {
  return resolveServertoolRegisteredNameWithNative({ name });
}
