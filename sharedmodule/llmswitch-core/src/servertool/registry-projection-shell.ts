import type {
  ServerToolAutoHookDescriptor,
  ServerToolHandlerEntry
} from './registry-types.js';
import type {
  ServerToolRegisteredHandlerRecord
} from './skeleton-config.js';
import {
  planServertoolRegistryAutoHookDescriptorsWithNative,
  planServertoolRegistrySourceProjectionWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';

type RegistrySourceRecordSnapshot = {
  registration: ServerToolRegisteredHandlerRecord['registration'];
  handler?: ServerToolRegisteredHandlerRecord['handler'];
};

type RegistrySourceProjectionResult = {
  registeredNames: string[];
  autoHandlers: ServerToolHandlerEntry[];
  registeredRecords: ServerToolRegisteredHandlerRecord[];
};

export function projectAutoServerToolHookDescriptors(args: {
  entries: ServerToolHandlerEntry[];
}): ServerToolAutoHookDescriptor[] {
  return planServertoolRegistryAutoHookDescriptorsWithNative({
    hooks: args.entries.map((entry) => ({
      id: entry.name,
      phase: entry.autoHook?.phase,
      priority: entry.autoHook?.priority,
      order: entry.autoHook?.order
    }))
  }).map((descriptor) => {
    const entry = args.entries[descriptor.sourceIndex];
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
}

export function projectRegistrySources(args: {
  builtinNames: string[];
  builtinAutoHandlerEntries: ServerToolHandlerEntry[];
  builtinRecordEntries: ServerToolHandlerEntry[];
}): RegistrySourceProjectionResult {
  const builtinRecords: RegistrySourceRecordSnapshot[] = args.builtinRecordEntries.map((entry) => ({
    registration: entry.registration,
    handler: undefined
  }));
  const projection = planServertoolRegistrySourceProjectionWithNative({
    builtinNames: args.builtinNames,
    builtinAutoHandlerNames: args.builtinAutoHandlerEntries.map((entry) => entry.name),
    builtinRecords: builtinRecords.map((entry) => ({
      name: entry.registration.name,
      trigger: entry.registration.trigger
    }))
  });
  return {
    registeredNames: projection.registeredNames,
    autoHandlers: projection.autoHandlerRefs.map((ref) => {
      const entry = args.builtinAutoHandlerEntries[ref.sourceIndex];
      if (!entry) {
        throw new Error(
          `[servertool] native registry source projection missing auto handler ${ref.source}:${ref.sourceIndex}:${ref.name}`
        );
      }
      return entry;
    }),
    registeredRecords: projection.registeredRecordRefs.map((ref) => {
      const entry = builtinRecords[ref.sourceIndex];
      if (!entry) {
        throw new Error(
          `[servertool] native registry source projection missing registered record ${ref.source}:${ref.sourceIndex}:${ref.trigger}:${ref.name}`
        );
      }
      return {
        registration: entry.registration,
        handler: entry.handler
      };
    })
  };
}
