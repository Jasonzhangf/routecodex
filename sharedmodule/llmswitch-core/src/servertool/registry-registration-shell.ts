import type { ServerToolHandlerEntry } from './registry-types.js';
import {
  getBuiltinHandlerEntry
} from './builtin-handler-catalog.js';
import {
  planServertoolRegistryLookupFromSkeleton
} from './skeleton-config.js';

export const getServerToolHandlerViaNativePlan = (
  name: string
): ServerToolHandlerEntry | undefined => {
  const actionPlan = planServertoolRegistryLookupFromSkeleton({
    name: typeof name === 'string' ? name : ''
  });
  if (actionPlan.action === 'return_builtin') {
    if (!actionPlan.canonicalName) {
      throw new Error('[servertool] native registry lookup returned builtin without canonicalName');
    }
    return getBuiltinHandlerEntry(actionPlan.canonicalName);
  }
  return undefined;
};
