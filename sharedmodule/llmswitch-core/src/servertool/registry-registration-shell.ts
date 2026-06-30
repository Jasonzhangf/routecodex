import type { ServerToolHandlerEntry } from './registry-types.js';
import {
  getBuiltinHandlerEntry
} from './builtin-handler-catalog.js';
import {
  isServertoolRegisteredNameByConfig,
  planServertoolRegistryLookupFromSkeleton
} from './skeleton-config.js';

export const getServerToolHandlerViaNativePlan = (
  name: string
): ServerToolHandlerEntry | undefined => {
  const registryLookupInput = {
    name: typeof name === 'string' ? name : ''
  };
  const actionPlan = planServertoolRegistryLookupFromSkeleton(registryLookupInput);
  if (actionPlan.action === 'return_builtin') {
    if (!actionPlan.canonicalName) {
      throw new Error('[servertool] native registry lookup returned builtin without canonicalName');
    }
    return getBuiltinHandlerEntry(actionPlan.canonicalName);
  }
  return undefined;
};

export function isRegisteredServerToolNameViaNativeConfig(name: string): boolean {
  return isServertoolRegisteredNameByConfig(name);
}
