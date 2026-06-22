import type { ServerToolHandler } from './types.js';
import {
  type ServerToolHandlerRegistrationSpec,
  type ServerToolRegisteredHandlerRecord
} from './skeleton-config.js';
import {
  getBuiltinHandlerEntry,
  listBuiltinAutoHandlerEntries,
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
  projectAutoServerToolHandlers,
  projectAutoServerToolHookDescriptors,
  projectRegisteredServerToolHandlerRecords,
  projectRegistryHandlerNames
} from './registry-projection-shell.js';

type TriggerMode = 'tool_call' | 'auto';
type AutoHookPhase = 'pre' | 'default' | 'post';

interface ServerToolAutoHookSpec {
  id: string;
  phase: AutoHookPhase;
  priority: number;
  order: number;
}

export interface ServerToolHandlerEntry {
  name: string;
  trigger: TriggerMode;
  handler: ServerToolHandler;
  registration: ServerToolHandlerRegistrationSpec;
  autoHook?: ServerToolAutoHookSpec;
}

export interface ServerToolAutoHookDescriptor {
  id: string;
  phase: AutoHookPhase;
  priority: number;
  order: number;
  registration: ServerToolHandlerRegistrationSpec;
  handler: ServerToolHandler;
}

export const registerServerToolHandler = (
  name: string,
  handler: ServerToolHandler,
  options?: {
    trigger?: TriggerMode;
    priority?: number;
    phase?: AutoHookPhase | string;
    hook?: {
      priority?: number;
      phase?: AutoHookPhase | string;
    };
  }
): void => {
  registerServerToolHandlerViaNativePlan(name, handler, options);
};

export const getServerToolHandler = (
  name: string
): ServerToolHandlerEntry | undefined => getServerToolHandlerViaNativePlan(name);

export function listRegisteredServerToolHandlerNames(): string[] {
  return projectRegistryHandlerNames({
    names: [...listBuiltinHandlerNames(), ...listAdHocHandlerNames()]
  });
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
  return projectAutoServerToolHandlers({
    entries: [...listBuiltinAutoHandlerEntries(), ...listAdHocAutoHandlerEntries()]
  });
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
  const builtinEntries = listBuiltinHandlerNames()
    .map((name) => getBuiltinHandlerEntry(name))
    .filter((entry): entry is ServerToolHandlerEntry => Boolean(entry));
  const rawRecords = [
    ...builtinEntries.map((entry) => ({
      name: entry.name,
      trigger: entry.registration.trigger,
      registration: entry.registration,
      handler: entry.handler
    })),
    ...listAdHocHandlerRecords().map((entry) => ({
      name: entry.registration.name,
      trigger: entry.registration.trigger,
      registration: entry.registration,
      handler: entry.handler
    }))
  ];
  return projectRegisteredServerToolHandlerRecords({
    rawRecords
  });
}
