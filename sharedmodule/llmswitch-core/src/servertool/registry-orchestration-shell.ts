import {
  type ServerToolRegisteredHandlerRecord
} from '../native/router-hotpath/native-followup-mainline-semantics.js';
import {
  getBuiltinHandlerEntry,
  listBuiltinAutoHandlerEntries,
  listBuiltinHandlerRecordEntries,
  listBuiltinHandlerNames
} from './builtin-handler-catalog.js';
import {
  planServertoolRegistryLookupFromSkeletonWithNative,
  resolveServertoolRegisteredNameWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import {
  projectAutoServerToolHookDescriptors,
  projectRegistrySources
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

function projectCurrentRegistrySources(): {
  registeredNames: string[];
  autoHandlers: ServerToolHandlerEntry[];
  registeredRecords: ServerToolRegisteredHandlerRecord[];
} {
  return projectRegistrySources({
    builtinNames: listBuiltinHandlerNames(),
    builtinAutoHandlerEntries: listBuiltinAutoHandlerEntries(),
    builtinRecordEntries: listBuiltinHandlerRecordEntries()
  });
}

export function listRegisteredServerToolHandlerNames(): string[] {
  return projectCurrentRegistrySources().registeredNames;
}

export const listAutoServerToolHooks = (): ServerToolAutoHookDescriptor[] => {
  return projectAutoServerToolHookDescriptors({
    entries: projectCurrentRegistrySources().autoHandlers
  });
};

export function isRegisteredServerToolName(name: string): boolean {
  return resolveServertoolRegisteredNameWithNative({ name });
}

export function listRegisteredServerToolHandlerRecords(): ServerToolRegisteredHandlerRecord[] {
  return projectCurrentRegistrySources().registeredRecords;
}
