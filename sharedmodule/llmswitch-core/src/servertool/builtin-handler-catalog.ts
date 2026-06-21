import type { ServerToolHandler } from './types.js';
import type { ServerToolHandlerEntry } from './registry-impl.js';
import type { ServerToolHandlerRegistrationSpec } from './skeleton-config.js';
import { getServertoolToolSpec } from './skeleton-config.js';

function readSkeletonOwnedRegistration(name: string): ServerToolHandlerRegistrationSpec | null {
  const spec = getServertoolToolSpec(name);
  if (!spec || spec.enabled === false) {
    return null;
  }
  const autoHook =
    spec.trigger.type === 'auto'
      ? {
          id: spec.name,
          phase: spec.trigger.phase ?? 'default',
          priority: spec.trigger.priority ?? 100
        }
      : undefined;
  return {
    name: spec.name,
    enabled: true,
    trigger: spec.trigger.type,
    executionMode: spec.execution.mode,
    stripAfterExecute: spec.execution.stripAfterExecute,
    ...(autoHook ? { autoHook } : {})
  };
}

const BUILTIN_TOOL_HANDLERS: Record<string, ServerToolHandler> = {
  web_search: async (ctx) => {
    const mod = await import('./handlers/web-search.js');
    return await mod.webSearchServerToolHandler(ctx);
  },
  vision_auto: async (ctx) => {
    const mod = await import('./handlers/vision.js');
    return await mod.visionAutoServerToolHandler(ctx);
  },
  stop_message_auto: async (ctx) => {
    const mod = await import('./handlers/stop-message-auto.js');
    return await mod.stopMessageAutoServerToolHandler(ctx);
  }
};

export function getBuiltinHandlerEntry(name: string): ServerToolHandlerEntry | undefined {
  const registration = readSkeletonOwnedRegistration(name);
  if (!registration) {
    return undefined;
  }
  const handler = BUILTIN_TOOL_HANDLERS[registration.name];
  if (typeof handler !== 'function') {
    return undefined;
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
      order: -1
    };
  }
  return entry;
}

export function listBuiltinHandlerNames(): string[] {
  return Object.keys(BUILTIN_TOOL_HANDLERS).sort();
}

export function listBuiltinAutoHandlerEntries(): ServerToolHandlerEntry[] {
  return listBuiltinHandlerNames()
    .map((name) => getBuiltinHandlerEntry(name))
    .filter((entry): entry is ServerToolHandlerEntry => Boolean(entry?.autoHook));
}
