import type {
  ServerToolAutoHookDescriptor,
  ServerToolHandlerEntry
} from './registry-types.js';
import type {
  ServerToolRegisteredHandlerRecord
} from './skeleton-config.js';
import {
  planServertoolRegistryAutoHookDescriptorsWithNative,
  planServertoolRegistryProjectionWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';

export function projectRegistryHandlerNames(args: {
  names: string[];
}): string[] {
  return planServertoolRegistryProjectionWithNative({
    registeredNames: args.names,
    registeredRecords: [],
    autoHandlerNames: []
  }).registeredNames;
}

export function projectAutoServerToolHandlers(args: {
  entries: ServerToolHandlerEntry[];
}): ServerToolHandlerEntry[] {
  const entryByName = new Map(
    args.entries.map((entry) => [entry.name.trim().toLowerCase(), entry] as const)
  );
  return planServertoolRegistryProjectionWithNative({
    registeredNames: [],
    registeredRecords: [],
    autoHandlerNames: args.entries.map((entry) => entry.name)
  }).autoHandlerNames.map((name) => {
    const entry = entryByName.get(name.trim().toLowerCase());
    if (!entry) {
      throw new Error(`[servertool] native registry auto handler order missing entry for name: ${name}`);
    }
    return entry;
  });
}

export function projectAutoServerToolHookDescriptors(args: {
  entries: ServerToolHandlerEntry[];
}): ServerToolAutoHookDescriptor[] {
  const entryById = new Map(
    args.entries.map((entry) => [entry.name.trim().toLowerCase(), entry] as const)
  );
  return planServertoolRegistryAutoHookDescriptorsWithNative({
    hooks: args.entries.map((entry) => ({
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
      execution: entry.execution
    };
  });
}

export function projectRegisteredServerToolHandlerRecords(args: {
  rawRecords: Array<{
    name: string;
    trigger: string;
    registration: ServerToolRegisteredHandlerRecord['registration'];
    handler?: ServerToolRegisteredHandlerRecord['handler'];
  }>;
}): ServerToolRegisteredHandlerRecord[] {
  const projection = planServertoolRegistryProjectionWithNative({
    registeredNames: [],
    registeredRecords: args.rawRecords.map((entry, sourceIndex) => ({
      name: entry.name,
      trigger: entry.trigger,
      sourceIndex
    })),
    autoHandlerNames: []
  });
  return projection.registeredRecords.map((recordPlan) => {
    const entry = args.rawRecords[recordPlan.sourceIndex];
    if (
      !entry ||
      entry.name.trim().toLowerCase() !== recordPlan.name.trim().toLowerCase() ||
      entry.trigger !== recordPlan.trigger
    ) {
      throw new Error(
        `[servertool] native registry record projection mismatch at sourceIndex=${recordPlan.sourceIndex} for ${recordPlan.trigger}:${recordPlan.name}`
      );
    }
    return {
      registration: entry.registration,
      handler: entry.handler
    };
  });
}
