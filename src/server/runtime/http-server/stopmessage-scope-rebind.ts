import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateSync
} from '../../../modules/llmswitch/bridge.js';

type MutableRoutingState = {
  forcedTarget?: unknown;
  stickyTarget?: unknown;
  preferTarget?: unknown;
  allowedProviders: Set<string>;
  disabledProviders: Set<string>;
  disabledKeys: Map<string, Set<string | number>>;
  disabledModels: Map<string, Set<string>>;
  stopMessageSource?: string;
  stopMessageText?: string;
  stopMessageMaxRepeats?: number;
  stopMessageUsed?: number;
  stopMessageUpdatedAt?: number;
  stopMessageLastUsedAt?: number;
  stopMessageStageMode?: string;
  stopMessageAiMode?: string;
  stopMessageAiSeedPrompt?: string;
  stopMessageAiHistory?: Array<Record<string, unknown>>;
  preCommandSource?: string;
  preCommandScriptPath?: string;
  preCommandUpdatedAt?: number;
};

type RebindResult = {
  migrated: boolean;
  clearedOld: boolean;
  reason: string;
  oldScope?: string;
  newScope?: string;
};

function readToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeRoutingState(raw: unknown): MutableRoutingState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const allowedProviders =
    record.allowedProviders instanceof Set ? new Set(Array.from(record.allowedProviders as Set<string>)) : new Set<string>();
  const disabledProviders =
    record.disabledProviders instanceof Set ? new Set(Array.from(record.disabledProviders as Set<string>)) : new Set<string>();
  const disabledKeys =
    record.disabledKeys instanceof Map
      ? new Map(Array.from((record.disabledKeys as Map<string, Set<string | number>>).entries()))
      : new Map<string, Set<string | number>>();
  const disabledModels =
    record.disabledModels instanceof Map
      ? new Map(Array.from((record.disabledModels as Map<string, Set<string>>).entries()))
      : new Map<string, Set<string>>();

  const state: MutableRoutingState = {
    forcedTarget: record.forcedTarget,
    stickyTarget: record.stickyTarget,
    preferTarget: record.preferTarget,
    allowedProviders,
    disabledProviders,
    disabledKeys,
    disabledModels,
    stopMessageSource: readToken(record.stopMessageSource),
    stopMessageText: readToken(record.stopMessageText),
    stopMessageMaxRepeats: isFiniteNumber(record.stopMessageMaxRepeats) ? record.stopMessageMaxRepeats : undefined,
    stopMessageUsed: isFiniteNumber(record.stopMessageUsed) ? record.stopMessageUsed : undefined,
    stopMessageUpdatedAt: isFiniteNumber(record.stopMessageUpdatedAt) ? record.stopMessageUpdatedAt : undefined,
    stopMessageLastUsedAt: isFiniteNumber(record.stopMessageLastUsedAt) ? record.stopMessageLastUsedAt : undefined,
    stopMessageStageMode: readToken(record.stopMessageStageMode),
    stopMessageAiMode: readToken(record.stopMessageAiMode),
    stopMessageAiSeedPrompt: readToken(record.stopMessageAiSeedPrompt),
    stopMessageAiHistory: Array.isArray(record.stopMessageAiHistory)
      ? (record.stopMessageAiHistory as Array<Record<string, unknown>>).map((entry) => ({ ...entry }))
      : undefined,
    preCommandSource: readToken(record.preCommandSource),
    preCommandScriptPath: readToken(record.preCommandScriptPath),
    preCommandUpdatedAt: isFiniteNumber(record.preCommandUpdatedAt) ? record.preCommandUpdatedAt : undefined
  };
  return state;
}

function hasActiveStopMessage(state: MutableRoutingState | null): boolean {
  if (!state) {
    return false;
  }
  return Boolean(
    readToken(state.stopMessageText) ||
      isFiniteNumber(state.stopMessageMaxRepeats) ||
      isFiniteNumber(state.stopMessageUsed) ||
      readToken(state.stopMessageStageMode) ||
      readToken(state.stopMessageAiMode) ||
      readToken(state.stopMessageAiSeedPrompt) ||
      (Array.isArray(state.stopMessageAiHistory) && state.stopMessageAiHistory.length > 0)
  );
}

function applyStopMessage(source: MutableRoutingState, target: MutableRoutingState): void {
  target.stopMessageSource = source.stopMessageSource;
  target.stopMessageText = source.stopMessageText;
  target.stopMessageMaxRepeats = source.stopMessageMaxRepeats;
  target.stopMessageUsed = source.stopMessageUsed;
  target.stopMessageUpdatedAt = source.stopMessageUpdatedAt;
  target.stopMessageLastUsedAt = source.stopMessageLastUsedAt;
  target.stopMessageStageMode = source.stopMessageStageMode;
  target.stopMessageAiMode = source.stopMessageAiMode;
  target.stopMessageAiSeedPrompt = source.stopMessageAiSeedPrompt;
  target.stopMessageAiHistory = Array.isArray(source.stopMessageAiHistory)
    ? source.stopMessageAiHistory.map((entry) => ({ ...entry }))
    : undefined;
}

function clearStopMessage(state: MutableRoutingState): void {
  state.stopMessageSource = undefined;
  state.stopMessageText = undefined;
  state.stopMessageMaxRepeats = undefined;
  state.stopMessageUsed = undefined;
  state.stopMessageUpdatedAt = undefined;
  state.stopMessageLastUsedAt = undefined;
  state.stopMessageStageMode = undefined;
  state.stopMessageAiMode = undefined;
  state.stopMessageAiSeedPrompt = undefined;
  state.stopMessageAiHistory = undefined;
}

function isRoutingStateEffectivelyEmpty(state: MutableRoutingState): boolean {
  return Boolean(
    !state.forcedTarget &&
      !state.stickyTarget &&
      !state.preferTarget &&
      state.allowedProviders.size < 1 &&
      state.disabledProviders.size < 1 &&
      state.disabledKeys.size < 1 &&
      state.disabledModels.size < 1 &&
      !hasActiveStopMessage(state) &&
      !readToken(state.preCommandScriptPath) &&
      !readToken(state.preCommandSource) &&
      !isFiniteNumber(state.preCommandUpdatedAt)
  );
}

function createEmptyRoutingState(): MutableRoutingState {
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
    preCommandSource: undefined,
    preCommandScriptPath: undefined,
    preCommandUpdatedAt: undefined
  };
}

function resolveIsSourceNewer(source: MutableRoutingState, target: MutableRoutingState): boolean {
  const sourceUpdatedAt = isFiniteNumber(source.stopMessageUpdatedAt) ? source.stopMessageUpdatedAt : 0;
  const targetUpdatedAt = isFiniteNumber(target.stopMessageUpdatedAt) ? target.stopMessageUpdatedAt : 0;
  return sourceUpdatedAt >= targetUpdatedAt;
}

export function migrateStopMessageTmuxScope(args: {
  oldTmuxSessionId?: string;
  newTmuxSessionId?: string;
  reason?: string;
}): RebindResult {
  const oldTmuxSessionId = readToken(args.oldTmuxSessionId);
  const newTmuxSessionId = readToken(args.newTmuxSessionId);
  if (!oldTmuxSessionId || !newTmuxSessionId) {
    return { migrated: false, clearedOld: false, reason: 'missing_tmux' };
  }
  if (oldTmuxSessionId === newTmuxSessionId) {
    return { migrated: false, clearedOld: false, reason: 'same_tmux' };
  }

  const oldScope = `tmux:${oldTmuxSessionId}`;
  const newScope = `tmux:${newTmuxSessionId}`;
  const oldState = normalizeRoutingState(loadRoutingInstructionStateSync(oldScope));
  if (!hasActiveStopMessage(oldState)) {
    return { migrated: false, clearedOld: false, reason: 'old_stopmessage_missing', oldScope, newScope };
  }

  const sourceState = oldState as MutableRoutingState;
  const targetState = normalizeRoutingState(loadRoutingInstructionStateSync(newScope)) ?? createEmptyRoutingState();
  const targetHasActiveStop = hasActiveStopMessage(targetState);
  if (!targetHasActiveStop || resolveIsSourceNewer(sourceState, targetState)) {
    applyStopMessage(sourceState, targetState);
    saveRoutingInstructionStateSync(newScope, targetState as unknown as Record<string, unknown>);
  }

  clearStopMessage(sourceState);
  if (isRoutingStateEffectivelyEmpty(sourceState)) {
    saveRoutingInstructionStateSync(oldScope, null);
  } else {
    saveRoutingInstructionStateSync(oldScope, sourceState as unknown as Record<string, unknown>);
  }

  return {
    migrated: true,
    clearedOld: true,
    reason: readToken(args.reason) || 'tmux_rebind',
    oldScope,
    newScope
  };
}
