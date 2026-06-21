import type { ServerToolHandler } from './types.js';
import type { ServerToolHandlerEntry } from './registry-impl.js';
import type { ServerToolHandlerRegistrationSpec } from './skeleton-config.js';
import { normalizeServerToolRegistrationSpec } from './skeleton-config.js';

type TriggerMode = 'tool_call' | 'auto';
type AutoHookPhase = 'pre' | 'default' | 'post';

const adHocToolHandlerRegistry: Record<string, ServerToolHandlerEntry> = Object.create(null);
const adHocAutoHandlerRegistry: ServerToolHandlerEntry[] = [];
let adHocAutoHookOrder = 0;

function buildAdHocRegistration(
  name: string,
  options?: {
    trigger?: TriggerMode;
    priority?: number;
    phase?: AutoHookPhase | string;
    hook?: {
      priority?: number;
      phase?: AutoHookPhase | string;
    };
  }
): ServerToolHandlerRegistrationSpec {
  const canonicalName = name.trim().toLowerCase();
  const trigger = options?.trigger === 'auto' ? 'auto' : 'tool_call';
  const hookPhase = options?.hook?.phase === 'pre' || options?.hook?.phase === 'post'
    ? options.hook.phase
    : 'default';
  const hookPriority = Number.isFinite(options?.hook?.priority)
    ? Number(options?.hook?.priority)
    : 100;
  return {
    name: canonicalName,
    enabled: true,
    trigger,
    executionMode: 'guarded',
    stripAfterExecute: true,
    ...(trigger === 'auto'
      ? {
          autoHook: {
            id: canonicalName,
            phase: hookPhase,
            priority: hookPriority
          }
        }
      : {})
  };
}

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
  const registration =
    normalizeServerToolRegistrationSpec(name, options) ??
    buildAdHocRegistration(name, options);
  if (!registration || !registration.enabled) {
    return;
  }
  const entry: ServerToolHandlerEntry = {
    name: registration.name,
    trigger: registration.trigger,
    handler,
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
  const registration = normalizeServerToolRegistrationSpec(name) ?? buildAdHocRegistration(name);
  if (!registration) {
    return undefined;
  }
  return adHocToolHandlerRegistry[registration.name];
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
    handler: entry.handler
  }));
  const autoHandlers = adHocAutoHandlerRegistry.map((entry) => ({
    registration: entry.registration,
    handler: entry.handler
  }));
  return [...toolCallHandlers, ...autoHandlers];
}
