import type { RoutingInstructionState } from '../../../native/router-hotpath/native-virtual-router-routing-state.js';
import {
  hasArmedStopMessageStateWithNative,
  normalizeStopMessageStageModeValueWithNative,
  planStopMessageRoutingSnapshotWithNative,
  planStopMessageRoutingStateApplyWithNative,
  planStopMessageRoutingStateClearWithNative
} from '../../../native/router-hotpath/native-servertool-core-semantics.js';

export function hasArmedStopMessageState(state: RoutingInstructionState): boolean {
  return hasArmedStopMessageStateWithNative(state);
}

export function normalizeStopMessageStageMode(value: unknown): 'on' | 'off' | 'auto' | undefined {
  return normalizeStopMessageStageModeValueWithNative(value);
}

export function resolveStopMessageSnapshot(raw: unknown): {
  text: string;
  maxRepeats: number;
  used: number;
  source?: string;
  updatedAt?: number;
  lastUsedAt?: number;
  stageMode?: 'on' | 'off' | 'auto';
  aiMode?: 'on' | 'off';
} | null {
  return planStopMessageRoutingSnapshotWithNative(raw);
}

export function createStopMessageState(snapshot: {
  text: string;
  maxRepeats: number;
  used: number;
  source?: string;
  updatedAt?: number;
  lastUsedAt?: number;
  stageMode?: 'on' | 'off' | 'auto';
  aiMode?: 'on' | 'off';
  aiSeedPrompt?: string;
  aiHistory?: Array<Record<string, unknown>>;
}): RoutingInstructionState {
  return applyStopMessageSnapshotToState(null, snapshot);
}

export function applyStopMessageSnapshotToState(
  state: RoutingInstructionState | null | undefined,
  snapshot: {
    text: string;
    maxRepeats: number;
    used: number;
    source?: string;
    updatedAt?: number;
    lastUsedAt?: number;
    stageMode?: 'on' | 'off' | 'auto';
    aiMode?: 'on' | 'off';
    aiSeedPrompt?: string;
    aiHistory?: Array<Record<string, unknown>>;
  }
): RoutingInstructionState {
  const next = state ?? {
    stoplessGoalState: undefined,
    forcedTarget: undefined,
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
    preCommandSource: undefined,
    preCommandScriptPath: undefined,
    preCommandUpdatedAt: undefined
  };
  const plan = planStopMessageRoutingStateApplyWithNative(snapshot);
  next.stopMessageSource = plan.source;
  next.stopMessageText = plan.text;
  next.stopMessageMaxRepeats = plan.maxRepeats;
  next.stopMessageUsed = plan.used;
  next.stopMessageUpdatedAt = plan.updatedAt;
  next.stopMessageLastUsedAt = plan.lastUsedAt;
  next.stopMessageStageMode = plan.stageMode;
  next.stopMessageAiMode = plan.aiMode;
  next.stopMessageAiSeedPrompt = plan.aiSeedPrompt;
  next.stopMessageAiHistory = plan.aiHistory;
  return next;
}

export function clearStopMessageState(state: RoutingInstructionState, now: number): void {
  const plan = planStopMessageRoutingStateClearWithNative(now);
  state.stopMessageText = undefined;
  state.stopMessageMaxRepeats = undefined;
  state.stopMessageUsed = undefined;
  state.stopMessageSource = undefined;
  state.stopMessageStageMode = undefined;
  state.stopMessageAiMode = undefined;
  state.stopMessageUpdatedAt = plan.timestamp;
  state.stopMessageLastUsedAt = plan.timestamp;
  state.stopMessageAiSeedPrompt = undefined;
  state.stopMessageAiHistory = undefined;
}
