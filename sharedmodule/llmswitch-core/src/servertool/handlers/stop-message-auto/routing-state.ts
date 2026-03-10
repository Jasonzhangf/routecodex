import type { RoutingInstructionState } from '../../../router/virtual-router/routing-instructions.js';
import { DEFAULT_STOP_MESSAGE_MAX_REPEATS } from '../../../router/virtual-router/routing-stop-message-state-codec.js';

export function hasArmedStopMessageState(state: RoutingInstructionState): boolean {
  const text = typeof state.stopMessageText === 'string' ? state.stopMessageText.trim() : '';
  const stageMode = normalizeStopMessageModeValue(state.stopMessageStageMode);
  const maxRepeats = resolveStopMessageMaxRepeats(state.stopMessageMaxRepeats, stageMode);
  if (stageMode === 'off') {
    return false;
  }
  return text.length > 0 && maxRepeats > 0;
}

export function normalizeStopMessageModeValue(value: unknown): 'on' | 'off' | 'auto' | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'on' || normalized === 'off' || normalized === 'auto') {
    return normalized;
  }
  return undefined;
}

export function normalizeStopMessageStageMode(value: unknown): 'on' | 'off' | 'auto' | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'on' || normalized === 'off' || normalized === 'auto') {
    return normalized;
  }
  return undefined;
}

export function resolveStopMessageMaxRepeats(
  value: unknown,
  stageMode: 'on' | 'off' | 'auto' | undefined
): number {
  const parsed =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.floor(value)
      : 0;
  if (parsed > 0) {
    return parsed;
  }
  if (stageMode === 'on' || stageMode === 'auto') {
    return DEFAULT_STOP_MESSAGE_MAX_REPEATS;
  }
  return 0;
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
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const text = typeof record.stopMessageText === 'string' ? record.stopMessageText.trim() : '';
  const stageMode = normalizeStopMessageStageMode(record.stopMessageStageMode);
  const aiMode = normalizeStopMessageAiMode(record.stopMessageAiMode) || 'off';
  const maxRepeats = resolveStopMessageMaxRepeats(record.stopMessageMaxRepeats, stageMode);
  if (stageMode === 'off') {
    return null;
  }
  if (!text || maxRepeats <= 0) {
    return null;
  }
  const used =
    typeof record.stopMessageUsed === 'number' && Number.isFinite(record.stopMessageUsed)
      ? Math.max(0, Math.floor(record.stopMessageUsed))
      : 0;
  const updatedAt =
    typeof record.stopMessageUpdatedAt === 'number' && Number.isFinite(record.stopMessageUpdatedAt)
      ? record.stopMessageUpdatedAt
      : undefined;
  const lastUsedAt =
    typeof record.stopMessageLastUsedAt === 'number' && Number.isFinite(record.stopMessageLastUsedAt)
      ? record.stopMessageLastUsedAt
      : undefined;
  const source =
    typeof record.stopMessageSource === 'string' && record.stopMessageSource.trim()
      ? record.stopMessageSource.trim()
      : undefined;
  return {
    text,
    maxRepeats,
    used,
    ...(source ? { source } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(lastUsedAt ? { lastUsedAt } : {}),
    ...(stageMode ? { stageMode } : {}),
    ...(aiMode ? { aiMode } : {})
  };
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
  return {
    forcedTarget: undefined,
    stickyTarget: undefined,
    allowedProviders: new Set<string>(),
    disabledProviders: new Set<string>(),
    disabledKeys: new Map<string, Set<string | number>>(),
    disabledModels: new Map<string, Set<string>>(),
    stopMessageSource: snapshot.source && snapshot.source.trim() ? snapshot.source.trim() : 'explicit',
    stopMessageText: snapshot.text,
    stopMessageMaxRepeats: snapshot.maxRepeats,
    stopMessageUsed: snapshot.used,
    stopMessageUpdatedAt: snapshot.updatedAt,
    stopMessageLastUsedAt: snapshot.lastUsedAt,
    stopMessageStageMode: snapshot.stageMode,
    stopMessageAiMode: snapshot.aiMode || 'off',
    stopMessageAiSeedPrompt: snapshot.aiSeedPrompt,
    stopMessageAiHistory: Array.isArray(snapshot.aiHistory) ? snapshot.aiHistory : undefined
  };
}

export function clearStopMessageState(state: RoutingInstructionState, _now: number): void {
  const now = Number.isFinite(_now) ? Math.floor(_now) : Date.now();
  state.stopMessageText = undefined;
  state.stopMessageMaxRepeats = undefined;
  state.stopMessageUsed = undefined;
  state.stopMessageSource = undefined;
  state.stopMessageStageMode = undefined;
  state.stopMessageAiMode = undefined;
  state.stopMessageUpdatedAt = now;
  state.stopMessageLastUsedAt = undefined;
  state.stopMessageAiSeedPrompt = undefined;
  state.stopMessageAiHistory = undefined;
}

function normalizeStopMessageAiMode(value: unknown): 'on' | 'off' | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'on' || normalized === 'off') {
    return normalized;
  }
  return undefined;
}
