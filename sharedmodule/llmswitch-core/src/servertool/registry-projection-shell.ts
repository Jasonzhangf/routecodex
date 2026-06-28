import type {
  ServerToolAutoHookDescriptor,
  ServerToolHandlerEntry
} from './registry-types.js';
import type {
  ServerToolRegisteredHandlerRecord
} from './skeleton-config.js';
import {
  planServertoolRegistryAutoHookDescriptorsWithNative,
  planServertoolRegistrySourceProjectionWithNative,
  type ServertoolRegistrySourceKind
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

function selectSourceArray<T>(args: {
  source: ServertoolRegistrySourceKind;
  builtin: T[];
  adhoc: T[];
}): T[] {
  return args.source === 'builtin' ? args.builtin : args.adhoc;
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
  adHocNames: string[];
  builtinAutoHandlerEntries: ServerToolHandlerEntry[];
  adHocAutoHandlerEntries: ServerToolHandlerEntry[];
  builtinRecordEntries: ServerToolHandlerEntry[];
  adHocHandlerRecords: Array<{
    registration: ServerToolRegisteredHandlerRecord['registration'];
    handler: ServerToolRegisteredHandlerRecord['handler'];
  }>;
}): RegistrySourceProjectionResult {
  const builtinRecords: RegistrySourceRecordSnapshot[] = args.builtinRecordEntries.map((entry) => ({
    registration: entry.registration,
    handler: undefined
  }));
  const adHocRecords: RegistrySourceRecordSnapshot[] = args.adHocHandlerRecords.map((entry) => ({
    registration: entry.registration,
    handler: entry.handler
  }));
  const projection = planServertoolRegistrySourceProjectionWithNative({
    builtinNames: args.builtinNames,
    adHocNames: args.adHocNames,
    builtinAutoHandlerNames: args.builtinAutoHandlerEntries.map((entry) => entry.name),
    adHocAutoHandlerNames: args.adHocAutoHandlerEntries.map((entry) => entry.name),
    builtinRecords: builtinRecords.map((entry) => ({
      name: entry.registration.name,
      trigger: entry.registration.trigger
    })),
    adHocRecords: adHocRecords.map((entry) => ({
      name: entry.registration.name,
      trigger: entry.registration.trigger
    }))
  });
  return {
    registeredNames: projection.registeredNames,
    autoHandlers: projection.autoHandlerRefs.map((ref) => {
      const sourceEntries = selectSourceArray({
        source: ref.source,
        builtin: args.builtinAutoHandlerEntries,
        adhoc: args.adHocAutoHandlerEntries
      });
      const entry = sourceEntries[ref.sourceIndex];
      if (!entry || canonicalName(entry.name) !== canonicalName(ref.name)) {
        throw new Error(
          `[servertool] native registry source projection mismatch for auto handler ${ref.source}:${ref.sourceIndex}:${ref.name}`
        );
      }
      return entry;
    }),
    registeredRecords: projection.registeredRecordRefs.map((ref) => {
      const sourceRecords = selectSourceArray({
        source: ref.source,
        builtin: builtinRecords,
        adhoc: adHocRecords
      });
      const entry = sourceRecords[ref.sourceIndex];
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
