import type { RoutingInstructionState } from '../../router/virtual-router/routing-instructions.js';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateSync
} from '../../router/virtual-router/sticky-session-store.js';
import { readRuntimeMetadata } from '../../conversion/runtime-metadata.js';
import { resolveStopMessageSessionScope } from './stop-message-auto/runtime-utils.js';

const REASONING_STOP_SUMMARY_MAX_CHARS = 4000;

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
    reasoningStopArmed: undefined,
    reasoningStopSummary: undefined,
    reasoningStopUpdatedAt: undefined,
    preCommandSource: undefined,
    preCommandScriptPath: undefined,
    preCommandUpdatedAt: undefined
  };
}

function resolveStickyKey(adapterContext: unknown): string {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return '';
  }
  const record = adapterContext as Record<string, unknown>;
  const runtime = readRuntimeMetadata(record);
  const scope = resolveStopMessageSessionScope(record, runtime);
  return typeof scope === 'string' ? scope.trim() : '';
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
    state.reasoningStopArmed !== true &&
    (typeof state.reasoningStopSummary !== 'string' || !state.reasoningStopSummary.trim()) &&
    (typeof state.reasoningStopUpdatedAt !== 'number' || !Number.isFinite(state.reasoningStopUpdatedAt));
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
  try {
    state = loadRoutingInstructionStateSync(stickyKey);
  } catch {
    return { stickyKey, armed: false, summary: '' };
  }
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
  try {
    state = loadRoutingInstructionStateSync(stickyKey);
  } catch {
    state = null;
  }
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
  try {
    state = loadRoutingInstructionStateSync(stickyKey);
  } catch {
    state = null;
  }
  if (!state) {
    return;
  }
  state.reasoningStopArmed = undefined;
  state.reasoningStopSummary = undefined;
  state.reasoningStopUpdatedAt = undefined;
  if (isStateEmpty(state)) {
    saveRoutingInstructionStateSync(stickyKey, null);
    return;
  }
  saveRoutingInstructionStateSync(stickyKey, state);
}
