import type { RoutingInstructionState } from '../../router/virtual-router/routing-instructions.js';
import type { JsonObject } from '../../conversion/hub/types/json.js';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateSync
} from '../../router/virtual-router/sticky-session-store.js';
import { readRuntimeMetadata } from '../../conversion/runtime-metadata.js';
import { extractCapturedChatSeed } from './followup-request-builder.js';
import { resolveServertoolPersistentScopeKey } from '../state-scope.js';
import {
  REASONING_STOP_REASON_VALUES,
  REASONING_STOP_TOOL_DESCRIPTION,
  REASONING_STOP_TOOL_PARAMETERS_PROPERTIES
} from './reasoning-stop-schema.js';
import type { ReasoningStopReason } from './reasoning-stop-schema.js';
import type { ReasoningStopMode } from './reasoning-stop-stopless-directive.js';
import {
  extractStoplessDirectiveModeFromAdapterContext,
  normalizeReasoningStopMode
} from './reasoning-stop-stopless-directive.js';

const REASONING_STOP_SUMMARY_MAX_CHARS = 4000;
const REASONING_STOP_MODE_ENV_KEYS = [
  'ROUTECODEX_REASONING_STOP_MODE',
  'RCC_REASONING_STOP_MODE'
] as const;

export const DEFAULT_REASONING_STOP_MODE: ReasoningStopMode = 'off';
export type { ReasoningStopReason } from './reasoning-stop-schema.js';
export type { ReasoningStopMode } from './reasoning-stop-stopless-directive.js';

export const REASONING_STOP_TOOL_DEF: JsonObject = {
  type: 'function',
  function: {
    name: 'reasoning.stop',
    description: REASONING_STOP_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: REASONING_STOP_TOOL_PARAMETERS_PROPERTIES,
      required: ['task_goal', 'is_completed'],
      additionalProperties: false
    }
  }
} as const satisfies JsonObject;

function createEmptyRoutingInstructionState(): RoutingInstructionState {
  return {
    forcedTarget: undefined,
    stickyTarget: undefined,
    preferTarget: undefined,
    allowedProviders: new Set<string>(),
    disabledProviders: new Set<string>(),
    disabledKeys: new Map<string, Set<string | number>>(),
    disabledModels: new Map<string, Set<string>>(),
    stopMessageSource: undefined,
    stopMessageText: undefined,
    stopMessageMaxRepeats: undefined,
    stopMessageUsed: undefined,
    stopMessageUpdatedAt: undefined,
    stopMessageLastUsedAt: undefined,
    stopMessageStageMode: undefined,
    stopMessageAiMode: undefined,
    stopMessageAiSeedPrompt: undefined,
    stopMessageAiHistory: undefined,
   reasoningStopMode: undefined,
   reasoningStopArmed: undefined,
   reasoningStopSummary: undefined,
   reasoningStopUpdatedAt: undefined,
    reasoningStopFailCount: undefined,
    reasoningStopGuardTriggerCount: undefined,
    reasoningStopGuardTriggerAt: undefined,
    preCommandSource: undefined,
    preCommandScriptPath: undefined,
    preCommandUpdatedAt: undefined
  };
}

function resolveStickyKey(adapterContext: unknown): string {
  return resolveServertoolPersistentScopeKey(adapterContext) ?? '';
}

function normalizeSummary(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.length <= REASONING_STOP_SUMMARY_MAX_CHARS) {
    return trimmed;
  }
  return trimmed.slice(0, REASONING_STOP_SUMMARY_MAX_CHARS);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}

function hasReasoningStopState(state: RoutingInstructionState | null | undefined): boolean {
  if (!state) {
    return false;
  }
  const mode = normalizeReasoningStopMode((state as RoutingInstructionState).reasoningStopMode);
  if (mode) {
    return true;
  }
  if (state.reasoningStopArmed === true) {
    return true;
  }
  if (typeof state.reasoningStopSummary === 'string' && state.reasoningStopSummary.trim()) {
    return true;
  }
  return typeof state.reasoningStopUpdatedAt === 'number' && Number.isFinite(state.reasoningStopUpdatedAt);
}

function isStateEmpty(state: RoutingInstructionState): boolean {
  const noForced = !state.forcedTarget;
  const noSticky = !state.stickyTarget;
  const noPrefer = !state.preferTarget;
  const noAllowed = state.allowedProviders.size === 0;
  const noDisabledProviders = state.disabledProviders.size === 0;
  const noDisabledKeys = state.disabledKeys.size === 0;
  const noDisabledModels = state.disabledModels.size === 0;
  const noStopMessage =
    (!state.stopMessageText || !state.stopMessageText.trim()) &&
    (typeof state.stopMessageMaxRepeats !== 'number' || !Number.isFinite(state.stopMessageMaxRepeats)) &&
    (typeof state.stopMessageUsed !== 'number' || !Number.isFinite(state.stopMessageUsed)) &&
    (typeof state.stopMessageStageMode !== 'string' || !state.stopMessageStageMode.trim()) &&
    (typeof state.stopMessageAiMode !== 'string' || !state.stopMessageAiMode.trim());
  const noReasoningStop =
    (typeof state.reasoningStopMode !== 'string' || !state.reasoningStopMode.trim()) &&
    state.reasoningStopArmed !== true &&
    (typeof state.reasoningStopUpdatedAt !== 'number' || !Number.isFinite(state.reasoningStopUpdatedAt)) &&
    (typeof state.reasoningStopFailCount !== 'number' || !Number.isFinite(state.reasoningStopFailCount));
  const noPreCommand =
    (!state.preCommandScriptPath || !state.preCommandScriptPath.trim()) &&
    (typeof state.preCommandUpdatedAt !== 'number' || !Number.isFinite(state.preCommandUpdatedAt));

  return (
    noForced &&
    noSticky &&
    noPrefer &&
    noAllowed &&
    noDisabledProviders &&
    noDisabledKeys &&
    noDisabledModels &&
    noStopMessage &&
    noReasoningStop &&
    noPreCommand
  );
}

export function resolveConfiguredReasoningStopModeDefault(): ReasoningStopMode {
  for (const key of REASONING_STOP_MODE_ENV_KEYS) {
    const normalized = normalizeReasoningStopMode(process.env[key]);
    if (normalized) {
      return normalized;
    }
  }
  return DEFAULT_REASONING_STOP_MODE;
}


export function readReasoningStopMode(
  adapterContext: unknown,
  fallbackMode?: ReasoningStopMode
): ReasoningStopMode {
  const resolvedFallback = normalizeReasoningStopMode(fallbackMode) ?? resolveConfiguredReasoningStopModeDefault();
  const stickyKey = resolveStickyKey(adapterContext);
  if (!stickyKey) {
    return resolvedFallback;
  }
  let state: RoutingInstructionState | null = null;
  state = loadRoutingInstructionStateSync(stickyKey);
  return normalizeReasoningStopMode(state?.reasoningStopMode) ?? resolvedFallback;
}

export function syncReasoningStopModeFromRequest(
  adapterContext: unknown,
  fallbackMode?: ReasoningStopMode
): ReasoningStopMode {
  const resolvedFallback = normalizeReasoningStopMode(fallbackMode) ?? resolveConfiguredReasoningStopModeDefault();
  const stickyKey = resolveStickyKey(adapterContext);
  const directiveMode = extractStoplessDirectiveModeFromAdapterContext(adapterContext);
  if (!stickyKey) {
    // stopless switch is strictly session-bound. If we cannot bind a session scope,
    // the directive must be ignored.
    return resolvedFallback;
  }

  let state: RoutingInstructionState | null = null;
  state = loadRoutingInstructionStateSync(stickyKey);

  if (!directiveMode) {
    const persistedMode = normalizeReasoningStopMode(state?.reasoningStopMode);
    if (persistedMode) {
      return persistedMode;
    }
    return resolvedFallback;
  }

  const next = state ?? createEmptyRoutingInstructionState();
  next.reasoningStopMode = directiveMode;
  if (directiveMode === 'off') {
    next.reasoningStopArmed = undefined;
    next.reasoningStopSummary = undefined;
    next.reasoningStopUpdatedAt = undefined;
  }
  saveRoutingInstructionStateSync(stickyKey, next);
  return directiveMode;
}

export function readReasoningStopState(adapterContext: unknown): {
  stickyKey: string;
  armed: boolean;
  summary: string;
  updatedAt?: number;
} {
  const stickyKey = resolveStickyKey(adapterContext);
  if (!stickyKey) {
    return { stickyKey: '', armed: false, summary: '' };
  }
  let state: RoutingInstructionState | null = null;
  state = loadRoutingInstructionStateSync(stickyKey);
  if (!hasReasoningStopState(state)) {
    return { stickyKey, armed: false, summary: '' };
  }
  const summary = normalizeSummary(state?.reasoningStopSummary);
  const updatedAt = readNumber(state?.reasoningStopUpdatedAt);
  return {
    stickyKey,
    armed: state?.reasoningStopArmed === true && summary.length > 0,
    summary,
    ...(typeof updatedAt === 'number' ? { updatedAt } : {})
  };
}

export function armReasoningStopState(adapterContext: unknown, summary: string): boolean {
  const stickyKey = resolveStickyKey(adapterContext);
  const normalizedSummary = normalizeSummary(summary);
  if (!stickyKey || !normalizedSummary) {
    return false;
  }
  let state: RoutingInstructionState | null = null;
  state = loadRoutingInstructionStateSync(stickyKey);
  const next = state ?? createEmptyRoutingInstructionState();
  next.reasoningStopArmed = true;
  next.reasoningStopSummary = normalizedSummary;
  next.reasoningStopUpdatedAt = Date.now();
  saveRoutingInstructionStateSync(stickyKey, next);
  return true;
}

export function clearReasoningStopState(adapterContext: unknown): void {
  const stickyKey = resolveStickyKey(adapterContext);
  if (!stickyKey) {
    return;
  }
  let state: RoutingInstructionState | null = null;
  state = loadRoutingInstructionStateSync(stickyKey);
  if (!state) {
    return;
  }
 state.reasoningStopArmed = undefined;
 state.reasoningStopSummary = undefined;
 state.reasoningStopUpdatedAt = undefined;
  state.reasoningStopFailCount = undefined;
 if (isStateEmpty(state)) {
    saveRoutingInstructionStateSync(stickyKey, null);
    return;
  }
  saveRoutingInstructionStateSync(stickyKey, state);
}

export function readReasoningStopFailCount(adapterContext: unknown): number {
  const stickyKey = resolveStickyKey(adapterContext);
  if (!stickyKey) {
    return 0;
  }
  let state: RoutingInstructionState | null = null;
  state = loadRoutingInstructionStateSync(stickyKey);
  if (!state) {
    return 0;
  }
  const count = state.reasoningStopFailCount;
  return typeof count === 'number' && Number.isFinite(count) ? count : 0;
}

export function incrementReasoningStopFailCount(adapterContext: unknown): number {
  const stickyKey = resolveStickyKey(adapterContext);
  if (!stickyKey) {
    return 0;
  }
  let state: RoutingInstructionState | null = null;
  state = loadRoutingInstructionStateSync(stickyKey);
  const next = state ?? createEmptyRoutingInstructionState();
  const currentCount = typeof next.reasoningStopFailCount === 'number' && Number.isFinite(next.reasoningStopFailCount)
    ? next.reasoningStopFailCount
    : 0;
  const newCount = currentCount + 1;
  next.reasoningStopFailCount = newCount;
  saveRoutingInstructionStateSync(stickyKey, next);
  return newCount;
}

export function resetReasoningStopFailCount(adapterContext: unknown): void {
  const stickyKey = resolveStickyKey(adapterContext);
  if (!stickyKey) {
    return;
  }
  let state: RoutingInstructionState | null = null;
  state = loadRoutingInstructionStateSync(stickyKey);
  if (!state) {
    return;
  }
  state.reasoningStopFailCount = undefined;
  if (isStateEmpty(state)) {
    saveRoutingInstructionStateSync(stickyKey, null);
    return;
  }
  saveRoutingInstructionStateSync(stickyKey, state);
}

// Storm protection: guard trigger tracking
export function readReasoningStopGuardTriggerCount(adapterContext: unknown): { count: number; lastTriggerAt: number | undefined } {
  const stickyKey = resolveStickyKey(adapterContext);
  if (!stickyKey) {
    return { count: 0, lastTriggerAt: undefined };
  }
  let state: RoutingInstructionState | null = null;
  state = loadRoutingInstructionStateSync(stickyKey);
  if (!state) {
    return { count: 0, lastTriggerAt: undefined };
  }
  const count = state.reasoningStopGuardTriggerCount;
  const lastTriggerAt = state.reasoningStopGuardTriggerAt;
  return {
    count: typeof count === 'number' && Number.isFinite(count) ? count : 0,
    lastTriggerAt: typeof lastTriggerAt === 'number' && Number.isFinite(lastTriggerAt) ? lastTriggerAt : undefined
  };
}

export function incrementReasoningStopGuardTriggerCount(adapterContext: unknown): number {
  const stickyKey = resolveStickyKey(adapterContext);
  if (!stickyKey) {
    return 0;
  }
  let state: RoutingInstructionState | null = null;
  state = loadRoutingInstructionStateSync(stickyKey);
  const next = state ?? createEmptyRoutingInstructionState();
  const currentCount = typeof next.reasoningStopGuardTriggerCount === 'number' && Number.isFinite(next.reasoningStopGuardTriggerCount)
    ? next.reasoningStopGuardTriggerCount
    : 0;
  const newCount = currentCount + 1;
  next.reasoningStopGuardTriggerCount = newCount;
  next.reasoningStopGuardTriggerAt = Date.now();
  saveRoutingInstructionStateSync(stickyKey, next);
  return newCount;
}

export function resetReasoningStopGuardTriggerCount(adapterContext: unknown): void {
  const stickyKey = resolveStickyKey(adapterContext);
  if (!stickyKey) {
    return;
  }
  let state: RoutingInstructionState | null = null;
  state = loadRoutingInstructionStateSync(stickyKey);
  if (!state) {
    return;
  }
  state.reasoningStopGuardTriggerCount = undefined;
  state.reasoningStopGuardTriggerAt = undefined;
  if (isStateEmpty(state)) {
    saveRoutingInstructionStateSync(stickyKey, null);
    return;
  }
  saveRoutingInstructionStateSync(stickyKey, state);
}
