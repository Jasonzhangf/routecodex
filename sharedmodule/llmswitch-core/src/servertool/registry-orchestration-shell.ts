import {
  getBuiltinHandlerEntry,
  listBuiltinAutoHandlerEntries
} from './builtin-handler-catalog.js';
import {
  planServertoolRegistryLookupFromSkeletonWithNative,
  resolveServertoolRegisteredNameWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import {
  projectAutoServerToolHookDescriptors
} from './registry-projection-shell.js';
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
  return projectAutoServerToolHookDescriptors({
    entries: listBuiltinAutoHandlerEntries()
  });
};

export function isRegisteredServerToolName(name: string): boolean {
  return resolveServertoolRegisteredNameWithNative({ name });
}
