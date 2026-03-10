import type { ServerToolHandler } from './types.js';

type TriggerMode = 'tool_call' | 'auto';
type AutoHookPhase = 'pre' | 'default' | 'post';

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
  autoHook?: ServerToolAutoHookSpec;
}

export interface ServerToolAutoHookDescriptor {
  id: string;
  phase: AutoHookPhase;
  priority: number;
  order: number;
  handler: ServerToolHandler;
}

const SERVER_TOOL_HANDLERS: Record<string, ServerToolHandlerEntry> = Object.create(null);
const AUTO_SERVER_TOOL_HANDLERS: ServerToolHandlerEntry[] = [];
const DEFAULT_AUTO_HOOK_PRIORITY = 100;
let autoHookRegistrationOrder = 0;

function normalizeAutoHookPhase(value: unknown): AutoHookPhase {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'pre' || normalized === 'before') {
    return 'pre';
  }
  if (normalized === 'post' || normalized === 'after') {
    return 'post';
  }
  return 'default';
}

function normalizeAutoHookPriority(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return DEFAULT_AUTO_HOOK_PRIORITY;
}

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
  const key = name.trim().toLowerCase();
  if (!key) return;
  const trigger: TriggerMode = options?.trigger ?? 'tool_call';
  const entry: ServerToolHandlerEntry = { name: key, trigger, handler };
  if (trigger === 'auto') {
    const priority = normalizeAutoHookPriority(options?.hook?.priority ?? options?.priority);
    const phase = normalizeAutoHookPhase(options?.hook?.phase ?? options?.phase);
    entry.autoHook = {
      id: key,
      phase,
      priority,
      order: autoHookRegistrationOrder++
    };
    AUTO_SERVER_TOOL_HANDLERS.push(entry);
    return;
  }
  SERVER_TOOL_HANDLERS[key] = entry;
}

export function getServerToolHandler(name: string): ServerToolHandlerEntry | undefined {
  if (!name || typeof name !== 'string') return undefined;
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  return SERVER_TOOL_HANDLERS[key];
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

    const priorityDiff = (leftHook?.priority ?? DEFAULT_AUTO_HOOK_PRIORITY) - (rightHook?.priority ?? DEFAULT_AUTO_HOOK_PRIORITY);
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
    priority: entry.autoHook?.priority ?? DEFAULT_AUTO_HOOK_PRIORITY,
    order: entry.autoHook?.order ?? 0,
    handler: entry.handler
  }));
}
