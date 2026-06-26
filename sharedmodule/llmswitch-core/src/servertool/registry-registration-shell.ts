import type { ServerToolHandler } from './types.js';
import type { ServerToolHandlerEntry } from './registry-types.js';
import {
  getBuiltinHandlerEntry
} from './builtin-handler-catalog.js';
import {
  getAdHocHandlerEntry,
  registerAdHocHandlerForTests
} from './adhoc-handler-test-support.js';
import {
  getServertoolToolSpec,
  isServertoolEnabledByConfig
} from './skeleton-config.js';
import {
  planServertoolRegistryLookupActionWithNative,
  planServertoolRegistryRegistrationActionWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';

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
  const canonicalName = typeof name === 'string' ? name.trim().toLowerCase() : '';
  const builtinEntry = resolveBuiltinEntry(name);
  const builtinNameMatched = Boolean(builtinEntry);
  const actionPlan = planServertoolRegistryRegistrationActionWithNative({
    name: typeof name === 'string' ? name : '',
    hasHandler: typeof handler === 'function',
    builtinNameMatched,
    builtinEntryPresent: Boolean(builtinEntry),
    registrationAllowedByConfig: canonicalName ? isServertoolEnabledByConfig(canonicalName) : true
  });
  if (actionPlan.action !== 'register_adhoc') {
    return;
  }
  registerAdHocHandlerForTests(name, handler, options);
};

export const getServerToolHandlerViaNativePlan = (
  name: string
): ServerToolHandlerEntry | undefined => {
  const canonicalName = typeof name === 'string' ? name.trim().toLowerCase() : '';
  const builtinEntry = resolveBuiltinEntry(name);
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

export function isRegisteredServerToolNameViaNativeConfig(name: string): boolean {
  return getServertoolToolSpec(name)?.enabled === true;
}
