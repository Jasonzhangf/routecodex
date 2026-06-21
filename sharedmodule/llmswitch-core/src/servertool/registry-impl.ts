import type { ServerToolHandler } from './types.js';
import {
  type ServertoolAutoHookPhase,
  type ServerToolHandlerRegistrationSpec,
  type ServerToolRegisteredHandlerRecord,
  getServertoolToolSpec
} from './skeleton-config.js';
import {
  getBuiltinHandlerEntry,
  listBuiltinAutoHandlerEntries,
  listBuiltinHandlerNames
} from './builtin-handler-catalog.js';
import {
  getAdHocHandlerEntry,
  listAdHocAutoHandlerEntries,
  listAdHocHandlerNames,
  listAdHocHandlerRecords,
  listAdHocToolCallHandlerSpecs,
  registerAdHocHandlerForTests
} from './adhoc-handler-test-support.js';

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

function isRegistrationAllowedByConfig(name: string): boolean {
  const spec = getServertoolToolSpec(name);
  if (!spec) {
    return true;
  }
  return spec.enabled !== false;
}

function resolveAutoHookPhaseRank(phase: AutoHookPhase): number {
  if (phase === 'pre') return 0;
  if (phase === 'post') return 2;
  return 1;
}

export const registerServerToolHandlerImpl = (
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
  if (!name || typeof name !== 'string' || typeof handler !== 'function') {
    return;
  }
  const builtinEntry = getBuiltinHandlerEntry(name);
  if (builtinEntry) {
    return;
  }
  if (!isRegistrationAllowedByConfig(name.trim().toLowerCase())) {
    return;
  }
  registerAdHocHandlerForTests(name, handler, options);
};

export const getServerToolHandlerImpl = (name: string): ServerToolHandlerEntry | undefined => {
  if (!name || typeof name !== 'string') return undefined;
  const builtinEntry = getBuiltinHandlerEntry(name);
  if (builtinEntry) {
    return builtinEntry;
  }
  return getAdHocHandlerEntry(name);
};

export function listRegisteredToolHandlerNamesImpl(): string[] {
  return Array.from(
    new Set([...listBuiltinHandlerNames(), ...listAdHocHandlerNames()])
  ).sort();
}

export function listAdHocRegisteredToolCallHandlerSpecsImpl(): Array<{
  name: string;
  trigger: 'tool_call';
  executionMode: string;
  stripAfterExecute: boolean;
}> {
  return listAdHocToolCallHandlerSpecs();
}

export const listAutoHandlersForRegistryImpl = (): ServerToolHandlerEntry[] => {
  return [...listBuiltinAutoHandlerEntries(), ...listAdHocAutoHandlerEntries()].sort((left, right) => {
    const leftHook = left.autoHook;
    const rightHook = right.autoHook;
    const phaseRankDiff =
      resolveAutoHookPhaseRank(leftHook?.phase ?? 'default') -
      resolveAutoHookPhaseRank(rightHook?.phase ?? 'default');
    if (phaseRankDiff !== 0) {
      return phaseRankDiff;
    }

    const priorityDiff = (leftHook?.priority ?? 100) - (rightHook?.priority ?? 100);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    const orderDiff = (leftHook?.order ?? 0) - (rightHook?.order ?? 0);
    if (orderDiff !== 0) {
      return orderDiff;
    }

    return left.name.localeCompare(right.name);
  });
};

export const collectAutoServerToolHooksImpl = (): ServerToolAutoHookDescriptor[] => {
  return listAutoHandlersForRegistryImpl().map((entry) => ({
    id: entry.name,
    phase: entry.autoHook?.phase ?? 'default',
    priority: entry.autoHook?.priority ?? 100,
    order: entry.autoHook?.order ?? 0,
    registration: entry.registration,
    handler: entry.handler
  }));
};

export function isRegisteredToolNameImpl(name: string): boolean {
  return getServertoolToolSpec(name)?.enabled === true;
}

export function listRegisteredToolHandlerRecordsImpl(): ServerToolRegisteredHandlerRecord[] {
  const builtinEntries = listBuiltinHandlerNames()
    .map((name) => getBuiltinHandlerEntry(name))
    .filter((entry): entry is ServerToolHandlerEntry => Boolean(entry));
  const toolCallHandlers = [
    ...builtinEntries.filter((entry) => entry.registration.trigger === 'tool_call'),
    ...listAdHocHandlerRecords().filter((entry) => entry.registration.trigger === 'tool_call')
  ].map((entry) => ({
    registration: entry.registration,
    handler: entry.handler
  }));
  const autoHandlers = [
    ...builtinEntries.filter((entry) => entry.registration.trigger === 'auto'),
    ...listAdHocHandlerRecords().filter((entry) => entry.registration.trigger === 'auto')
  ].map((entry) => ({
    registration: entry.registration,
    handler: entry.handler
  }));
  return [...toolCallHandlers, ...autoHandlers];
}
