import type { ServerToolHandlerEntry } from './registry-types.js';
import {
  getBuiltinHandlerEntry
} from './builtin-handler-catalog.js';
import {
  isServertoolRegisteredNameByConfig,
  planServertoolRegistryLookupFromSkeleton
} from './skeleton-config.js';

function resolveBuiltinEntry(name: string): ServerToolHandlerEntry | undefined {
  const rawName = typeof name === 'string' ? name.trim() : '';
  if (!rawName) {
    return undefined;
  }
  const canonicalName = rawName.toLowerCase();
  return getBuiltinHandlerEntry(rawName) ?? getBuiltinHandlerEntry(canonicalName);
}

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
