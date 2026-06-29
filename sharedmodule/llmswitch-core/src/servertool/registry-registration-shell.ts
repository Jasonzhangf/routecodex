import type { ServerToolHandler } from './types.js';
import type { ServerToolHandlerEntry } from './registry-types.js';
import {
  getBuiltinHandlerEntry
} from './builtin-handler-catalog.js';
import {
  isServertoolRegisteredNameByConfig,
  planServertoolRegistryLookupFromSkeleton,
  planServertoolRegistryRegistrationFromSkeleton
} from './skeleton-config.js';

type TriggerMode = 'tool_call' | 'auto';
type AutoHookPhase = 'pre' | 'default' | 'post';

function resolveBuiltinEntry(name: string): ServerToolHandlerEntry | undefined {
  const rawName = typeof name === 'string' ? name.trim() : '';
  if (!rawName) {
    return undefined;
  }
  const canonicalName = rawName.toLowerCase();
  return getBuiltinHandlerEntry(rawName) ?? getBuiltinHandlerEntry(canonicalName);
}

export const registerServerToolHandlerViaNativePlan = (
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
  const actionPlan = planServertoolRegistryRegistrationFromSkeleton({
    name: typeof name === 'string' ? name : '',
    hasHandler: typeof handler === 'function',
  });
  void actionPlan;
  void options;
};

export const getServerToolHandlerViaNativePlan = (
  name: string
): ServerToolHandlerEntry | undefined => {
  const actionPlan = planServertoolRegistryLookupFromSkeleton({
    name: typeof name === 'string' ? name : ''
  });
  if (actionPlan.action === 'return_builtin') {
    return resolveBuiltinEntry(actionPlan.canonicalName ?? name);
  }
  return undefined;
};

export function isRegisteredServerToolNameViaNativeConfig(name: string): boolean {
  return isServertoolRegisteredNameByConfig(name);
}
