import type { ServerToolHandler } from './types.js';
import {
  type ServertoolAutoHookPhase,
  type ServerToolHandlerRegistrationSpec,
  type ServerToolRegisteredHandlerRecord,
  getServertoolToolSpec,
  isServertoolEnabledByConfig,
  normalizeServerToolRegistrationSpec
} from './skeleton-config.js';

type TriggerMode = 'tool_call' | 'auto';
type AutoHookPhase = ServertoolAutoHookPhase;

interface ServerToolAutoHookSpec {
  id: string;
  phase: AutoHookPhase;
  priority: number;
  order: number;
}

export interface ServerToolHandlerEntry {
  name: string;
  trigger: TriggerMode;
  handler: ServerToolHandler;
  registration: ServerToolHandlerRegistrationSpec;
  autoHook?: ServerToolAutoHookSpec;
}

export interface ServerToolAutoHookDescriptor {
  id: string;
  phase: AutoHookPhase;
  priority: number;
  order: number;
  registration: ServerToolHandlerRegistrationSpec;
  handler: ServerToolHandler;
}

const SERVER_TOOL_HANDLERS: Record<string, ServerToolHandlerEntry> = Object.create(null);
const AUTO_SERVER_TOOL_HANDLERS: ServerToolHandlerEntry[] = [];
let autoHookRegistrationOrder = 0;

function resolveAutoHookPhaseRank(phase: AutoHookPhase): number {
  if (phase === 'pre') return 0;
  if (phase === 'post') return 2;
  return 1;
}

export function registerServerToolHandler(
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
  if (!registration || !registration.enabled || !isServertoolEnabledByConfig(registration.name)) {
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
      order: autoHookRegistrationOrder++
    };
    AUTO_SERVER_TOOL_HANDLERS.push(entry);
    return;
  }
  SERVER_TOOL_HANDLERS[registration.name] = entry;
}

export function getServerToolHandler(name: string): ServerToolHandlerEntry | undefined {
  if (!name || typeof name !== 'string') return undefined;
  const registration = normalizeServerToolRegistrationSpec(name);
  if (!registration) return undefined;
  return SERVER_TOOL_HANDLERS[registration.name];
}

export function listRegisteredServerToolHandlerNames(): string[] {
  return Object.keys(SERVER_TOOL_HANDLERS).sort();
}

export function listAutoServerToolHandlers(): ServerToolHandlerEntry[] {
  return [...AUTO_SERVER_TOOL_HANDLERS].sort((left, right) => {
    const leftHook = left.autoHook;
    const rightHook = right.autoHook;
    const phaseRankDiff =
      resolveAutoHookPhaseRank(leftHook?.phase ?? 'default') -
      resolveAutoHookPhaseRank(rightHook?.phase ?? 'default');
    if (phaseRankDiff !== 0) {
      return phaseRankDiff;
    }

    const priorityDiff = (leftHook?.priority ?? 100) - (rightHook?.priority ?? 100);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    const orderDiff = (leftHook?.order ?? 0) - (rightHook?.order ?? 0);
    if (orderDiff !== 0) {
      return orderDiff;
    }

    return left.name.localeCompare(right.name);
  });
}

export function listAutoServerToolHooks(): ServerToolAutoHookDescriptor[] {
  return listAutoServerToolHandlers().map((entry) => ({
    id: entry.name,
    phase: entry.autoHook?.phase ?? 'default',
    priority: entry.autoHook?.priority ?? 100,
    order: entry.autoHook?.order ?? 0,
    registration: entry.registration,
    handler: entry.handler
  }));
}

export function isRegisteredServerToolName(name: string): boolean {
  return getServertoolToolSpec(name)?.enabled === true;
}

export function listRegisteredServerToolHandlerRecords(): ServerToolRegisteredHandlerRecord[] {
  const toolCallHandlers = Object.values(SERVER_TOOL_HANDLERS).map((entry) => ({
    registration: entry.registration,
    handler: entry.handler
  }));
  const autoHandlers = AUTO_SERVER_TOOL_HANDLERS.map((entry) => ({
    registration: entry.registration,
    handler: entry.handler
  }));
  return [...toolCallHandlers, ...autoHandlers];
}
