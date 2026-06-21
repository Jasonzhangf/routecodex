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
import {
  planServertoolRegistryAutoHookDescriptorsWithNative,
  planServertoolRegistryLookupActionWithNative,
  planServertoolRegistryProjectionWithNative,
  planServertoolRegistryRegistrationActionWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';

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
  if (!listBuiltinHandlerNames().includes(name)) {
    return true;
  }
  const spec = getServertoolToolSpec(name);
  if (!spec) {
    return true;
  }
  return spec.enabled !== false;
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
  const canonicalName = typeof name === 'string' ? name.trim().toLowerCase() : '';
  const builtinNameMatched = listBuiltinHandlerNames().includes(canonicalName);
  const builtinEntry = builtinNameMatched
    ? getBuiltinHandlerEntry(canonicalName)
    : undefined;
  const actionPlan = planServertoolRegistryRegistrationActionWithNative({
    name: typeof name === 'string' ? name : '',
    hasHandler: typeof handler === 'function',
    builtinNameMatched,
    builtinEntryPresent: Boolean(builtinEntry),
    registrationAllowedByConfig: canonicalName ? isRegistrationAllowedByConfig(canonicalName) : true
  });
  if (actionPlan.action !== 'register_adhoc') {
    return;
  }
  registerAdHocHandlerForTests(name, handler, options);
};

export const getServerToolHandlerImpl = (name: string): ServerToolHandlerEntry | undefined => {
  const canonicalName = typeof name === 'string' ? name.trim().toLowerCase() : '';
  const builtinEntry = listBuiltinHandlerNames().includes(canonicalName)
    ? getBuiltinHandlerEntry(canonicalName)
    : undefined;
  const adHocEntry = canonicalName ? getAdHocHandlerEntry(canonicalName) : undefined;
  const actionPlan = planServertoolRegistryLookupActionWithNative({
    name: typeof name === 'string' ? name : '',
    builtinEntryPresent: Boolean(builtinEntry),
    adHocEntryPresent: Boolean(adHocEntry)
  });
  if (actionPlan.action === 'return_builtin') {
    return builtinEntry;
  }
  if (actionPlan.action === 'return_adhoc') {
    return adHocEntry;
  }
  return undefined;
};

export function listRegisteredToolHandlerNamesImpl(): string[] {
  return planServertoolRegistryProjectionWithNative({
    registeredNames: [...listBuiltinHandlerNames(), ...listAdHocHandlerNames()],
    registeredRecords: [],
    autoHandlerNames: []
  }).registeredNames;
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
  const entries = [...listBuiltinAutoHandlerEntries(), ...listAdHocAutoHandlerEntries()];
  const entryByName = new Map(
    entries.map((entry) => [entry.name.trim().toLowerCase(), entry] as const)
  );
  return planServertoolRegistryProjectionWithNative({
    registeredNames: [],
    registeredRecords: [],
    autoHandlerNames: entries.map((entry) => entry.name)
  }).autoHandlerNames.map((name) => {
    const entry = entryByName.get(name.trim().toLowerCase());
    if (!entry) {
      throw new Error(`[servertool] native registry auto handler order missing entry for name: ${name}`);
    }
    return entry;
  });
};

export const collectAutoServerToolHooksImpl = (): ServerToolAutoHookDescriptor[] => {
  const entries = listAutoHandlersForRegistryImpl();
  const entryById = new Map(
    entries.map((entry) => [entry.name.trim().toLowerCase(), entry] as const)
  );
  return planServertoolRegistryAutoHookDescriptorsWithNative({
    hooks: entries.map((entry) => ({
      id: entry.name,
      phase: entry.autoHook?.phase,
      priority: entry.autoHook?.priority,
      order: entry.autoHook?.order
    }))
  }).map((descriptor) => {
    const entry = entryById.get(descriptor.id.trim().toLowerCase());
    if (!entry) {
      throw new Error(
        `[servertool] native registry auto-hook descriptor missing entry for id: ${descriptor.id}`
      );
    }
    return {
      id: descriptor.id,
      phase: descriptor.phase,
      priority: descriptor.priority,
      order: descriptor.order,
      registration: entry.registration,
      handler: entry.handler
    };
  });
};

export function isRegisteredToolNameImpl(name: string): boolean {
  return getServertoolToolSpec(name)?.enabled === true;
}

export function listRegisteredToolHandlerRecordsImpl(): ServerToolRegisteredHandlerRecord[] {
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
  const projection = planServertoolRegistryProjectionWithNative({
    registeredNames: [],
    registeredRecords: rawRecords.map((entry) => ({
      name: entry.name,
      trigger: entry.trigger
    })),
    autoHandlerNames: []
  });
  const used = new Set<number>();
  return projection.registeredRecords.map((recordPlan) => {
    const matchIndex = rawRecords.findIndex((entry, index) => (
      !used.has(index) &&
      entry.name.trim().toLowerCase() === recordPlan.name.trim().toLowerCase() &&
      entry.trigger === recordPlan.trigger
    ));
    if (matchIndex < 0) {
      throw new Error(
        `[servertool] native registry record order missing entry for ${recordPlan.trigger}:${recordPlan.name}`
      );
    }
    used.add(matchIndex);
    const entry = rawRecords[matchIndex];
    return {
      registration: entry.registration,
      handler: entry.handler
    };
  });
}
