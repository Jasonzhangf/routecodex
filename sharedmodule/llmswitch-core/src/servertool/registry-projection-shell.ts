import type {
  ServerToolAutoHookDescriptor,
  ServerToolHandlerEntry
} from './registry-types.js';
import {
  planServertoolRegistryAutoHookDescriptorsWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';

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
