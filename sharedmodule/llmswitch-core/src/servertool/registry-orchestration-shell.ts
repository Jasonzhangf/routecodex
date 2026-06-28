import type { ServerToolHandler } from './types.js';
import {
  type ServerToolHandlerRegistrationSpec,
  type ServerToolRegisteredHandlerRecord
} from './skeleton-config.js';
import {
  listBuiltinAutoHandlerEntries,
  listBuiltinHandlerRecordEntries,
  listBuiltinHandlerNames
} from './builtin-handler-catalog.js';
import {
  listAdHocAutoHandlerEntries,
  listAdHocHandlerNames,
  listAdHocHandlerRecords,
  listAdHocToolCallHandlerSpecs
} from './adhoc-handler-test-support.js';
import {
  getServerToolHandlerViaNativePlan,
  isRegisteredServerToolNameViaNativeConfig,
  registerServerToolHandlerViaNativePlan
} from './registry-registration-shell.js';
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

export const registerServerToolHandler = (
  name: string,
  handler: ServerToolHandler,
  options?: {
    trigger?: 'tool_call' | 'auto';
    priority?: number;
    phase?: 'pre' | 'default' | 'post' | string;
    hook?: {
      priority?: number;
      phase?: 'pre' | 'default' | 'post' | string;
    };
  }
): void => {
  registerServerToolHandlerViaNativePlan(name, handler, options);
};

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
    adHocNames: listAdHocHandlerNames(),
    builtinAutoHandlerEntries: listBuiltinAutoHandlerEntries(),
    adHocAutoHandlerEntries: listAdHocAutoHandlerEntries(),
    builtinRecordEntries: listBuiltinHandlerRecordEntries(),
    adHocHandlerRecords: listAdHocHandlerRecords()
  });
}

export function listRegisteredServerToolHandlerNames(): string[] {
  return projectCurrentRegistrySources().registeredNames;
}

export function listAdHocRegisteredToolCallHandlerSpecs(): Array<{
  name: string;
  trigger: 'tool_call';
  executionMode: string;
  stripAfterExecute: boolean;
}> {
  return listAdHocToolCallHandlerSpecs();
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
  return isRegisteredServerToolNameViaNativeConfig(name);
}

export function listRegisteredServerToolHandlerRecords(): ServerToolRegisteredHandlerRecord[] {
  return projectCurrentRegistrySources().registeredRecords;
}
