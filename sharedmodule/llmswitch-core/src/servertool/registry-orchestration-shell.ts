import {
  type ServerToolRegisteredHandlerRecord
} from './skeleton-config.js';
import {
  listBuiltinAutoHandlerEntries,
  listBuiltinHandlerRecordEntries,
  listBuiltinHandlerNames
} from './builtin-handler-catalog.js';
import {
  getServerToolHandlerViaNativePlan
} from './registry-registration-shell.js';
import { resolveServertoolRegisteredNameWithNative } from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
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
): ServerToolHandlerEntry | undefined => getServerToolHandlerViaNativePlan(name);

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

export const listAutoServerToolHandlers = (): ServerToolHandlerEntry[] => {
  return projectCurrentRegistrySources().autoHandlers;
};

export const listAutoServerToolHooks = (): ServerToolAutoHookDescriptor[] => {
  return projectAutoServerToolHookDescriptors({
    entries: listAutoServerToolHandlers()
  });
};

export function isRegisteredServerToolName(name: string): boolean {
  return resolveServertoolRegisteredNameWithNative({ name });
}

export function listRegisteredServerToolHandlerRecords(): ServerToolRegisteredHandlerRecord[] {
  return projectCurrentRegistrySources().registeredRecords;
}
