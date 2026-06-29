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

function canonicalName(name: string): string {
  return name.trim().toLowerCase();
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
      if (!entry || canonicalName(entry.name) !== canonicalName(ref.name)) {
        throw new Error(
          `[servertool] native registry source projection mismatch for auto handler ${ref.source}:${ref.sourceIndex}:${ref.name}`
        );
      }
      return entry;
    }),
    registeredRecords: projection.registeredRecordRefs.map((ref) => {
      const entry = builtinRecords[ref.sourceIndex];
      if (
        !entry ||
        canonicalName(entry.registration.name) !== canonicalName(ref.name) ||
        entry.registration.trigger !== ref.trigger
      ) {
        throw new Error(
          `[servertool] native registry source projection mismatch for registered record ${ref.source}:${ref.sourceIndex}:${ref.trigger}:${ref.name}`
        );
      }
      return {
        registration: entry.registration,
        handler: entry.handler
      };
    })
  };
}
