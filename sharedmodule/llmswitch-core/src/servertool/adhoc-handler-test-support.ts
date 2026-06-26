import type { ServerToolHandler } from './types.js';
import type { ServerToolHandlerEntry } from './registry-types.js';
import type { ServerToolHandlerRegistrationSpec } from './skeleton-config.js';
import { normalizeServerToolRegistrationSpec } from './skeleton-config.js';

type TriggerMode = 'tool_call' | 'auto';
type AutoHookPhase = 'pre' | 'default' | 'post';

const adHocToolHandlerRegistry: Record<string, ServerToolHandlerEntry> = Object.create(null);
const adHocAutoHandlerRegistry: ServerToolHandlerEntry[] = [];
let adHocAutoHookOrder = 0;

export function registerAdHocHandlerForTests(
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
): void {
  if (!name || typeof name !== 'string' || typeof handler !== 'function') return;
  const registration = normalizeServerToolRegistrationSpec(name, options);
  if (!registration || !registration.enabled) {
    return;
  }
  const entry: ServerToolHandlerEntry = {
    name: registration.name,
    trigger: registration.trigger,
    execution: {
      kind: 'adhoc',
      handler
    },
    registration
  };
  if (registration.trigger === 'auto' && registration.autoHook) {
    entry.autoHook = {
      id: registration.autoHook.id,
      phase: registration.autoHook.phase,
      priority: registration.autoHook.priority,
      order: adHocAutoHookOrder++
    };
    adHocAutoHandlerRegistry.push(entry);
    return;
  }
  adHocToolHandlerRegistry[registration.name] = entry;
}

export function getAdHocHandlerEntry(name: string): ServerToolHandlerEntry | undefined {
  const canonicalName = name.trim().toLowerCase();
  return canonicalName ? adHocToolHandlerRegistry[canonicalName] : undefined;
}

export function listAdHocHandlerNames(): string[] {
  return Object.keys(adHocToolHandlerRegistry).sort();
}

export function listAdHocToolCallHandlerSpecs(): Array<{
  name: string;
  trigger: 'tool_call';
  executionMode: string;
  stripAfterExecute: boolean;
}> {
  return Object.values(adHocToolHandlerRegistry)
    .filter((entry) => entry.registration.trigger === 'tool_call')
    .map((entry) => ({
      name: entry.registration.name,
      trigger: 'tool_call' as const,
      executionMode: entry.registration.executionMode,
      stripAfterExecute: entry.registration.stripAfterExecute
    }));
}

export function listAdHocAutoHandlerEntries(): ServerToolHandlerEntry[] {
  return [...adHocAutoHandlerRegistry];
}

export function listAdHocHandlerRecords(): Array<{
  registration: ServerToolHandlerRegistrationSpec;
  handler: ServerToolHandler;
}> {
  const toolCallHandlers = Object.values(adHocToolHandlerRegistry).map((entry) => ({
    registration: entry.registration,
    handler: entry.execution.kind === 'adhoc' ? entry.execution.handler : (() => {
      throw new Error(`[servertool] expected ad-hoc execution descriptor for ${entry.name}`);
    })()
  }));
  const autoHandlers = adHocAutoHandlerRegistry.map((entry) => ({
    registration: entry.registration,
    handler: entry.execution.kind === 'adhoc' ? entry.execution.handler : (() => {
      throw new Error(`[servertool] expected ad-hoc execution descriptor for ${entry.name}`);
    })()
  }));
  return [...toolCallHandlers, ...autoHandlers];
}
