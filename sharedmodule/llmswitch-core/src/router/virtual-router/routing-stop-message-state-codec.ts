import type { RoutingInstructionState } from './routing-instructions.js';
import {
  deserializeStopMessageStateWithNative,
  serializeStopMessageStateWithNative
} from './engine-selection/native-virtual-router-stop-message-state-semantics.js';

export const DEFAULT_STOP_MESSAGE_MAX_REPEATS = 10;

export function serializeStopMessageState(state: RoutingInstructionState): Record<string, unknown> {
  return serializeStopMessageStateWithNative(state);
}

export function deserializeStopMessageState(
  data: Record<string, unknown>,
  state: RoutingInstructionState
): void {
  const patch = deserializeStopMessageStateWithNative(data, state);
  deserializeStopMessageStateFallback(patch, state);
}

function deserializeStopMessageStateFallback(
  data: Record<string, unknown>,
  state: RoutingInstructionState
): void {
  if (typeof data.stopMessageSource === 'string' && data.stopMessageSource.trim()) {
    state.stopMessageSource = (data.stopMessageSource as string).trim();
  }

  if (typeof data.stopMessageText === 'string' && data.stopMessageText.trim()) {
    state.stopMessageText = data.stopMessageText;
  }
  const hasPersistedMaxRepeats =
    typeof data.stopMessageMaxRepeats === 'number' && Number.isFinite(data.stopMessageMaxRepeats);
  if (hasPersistedMaxRepeats) {
    state.stopMessageMaxRepeats = Math.floor(data.stopMessageMaxRepeats as number);
  }
  if (typeof data.stopMessageUsed === 'number' && Number.isFinite(data.stopMessageUsed)) {
    state.stopMessageUsed = Math.max(0, Math.floor(data.stopMessageUsed));
  }
  if (typeof data.stopMessageUpdatedAt === 'number' && Number.isFinite(data.stopMessageUpdatedAt)) {
    state.stopMessageUpdatedAt = data.stopMessageUpdatedAt;
  }
  if (typeof data.stopMessageLastUsedAt === 'number' && Number.isFinite(data.stopMessageLastUsedAt)) {
    state.stopMessageLastUsedAt = data.stopMessageLastUsedAt;
  }
  if (typeof data.stopMessageStageMode === 'string' && data.stopMessageStageMode.trim()) {
    const normalized = normalizeStopMessageStageMode(data.stopMessageStageMode);
    if (normalized) {
      state.stopMessageStageMode = normalized;
    }
  }
  if (typeof data.stopMessageAiMode === 'string' && data.stopMessageAiMode.trim()) {
    const normalizedAiMode = normalizeStopMessageAiMode(data.stopMessageAiMode);
    if (normalizedAiMode) {
      state.stopMessageAiMode = normalizedAiMode;
    }
  }
  if (typeof data.stopMessageAiSeedPrompt === 'string' && data.stopMessageAiSeedPrompt.trim()) {
    state.stopMessageAiSeedPrompt = data.stopMessageAiSeedPrompt.trim();
  }
  const history = normalizeStopMessageAiHistoryEntries(data.stopMessageAiHistory);
  if (history.length > 0) {
    state.stopMessageAiHistory = history;
  }
  // Keep stopMessage mode state armed consistently across old/new snapshots.
  if (!hasPersistedMaxRepeats) {
    ensureStopMessageModeMaxRepeats(state);
  }
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

export function ensureStopMessageModeMaxRepeats(state: RoutingInstructionState): boolean {
  const mode = normalizeStopMessageStageMode(state.stopMessageStageMode);
  if (mode !== 'on' && mode !== 'auto') {
    return false;
  }
  const hasValidRepeats =
    typeof state.stopMessageMaxRepeats === 'number' &&
    Number.isFinite(state.stopMessageMaxRepeats) &&
    Math.floor(state.stopMessageMaxRepeats) > 0;
  if (hasValidRepeats) {
    const normalized = Math.floor(state.stopMessageMaxRepeats as number);
    if (state.stopMessageMaxRepeats !== normalized) {
      state.stopMessageMaxRepeats = normalized;
      return true;
    }
    return false;
  }
  state.stopMessageMaxRepeats = DEFAULT_STOP_MESSAGE_MAX_REPEATS;
  return true;
}

export function normalizeStopMessageAiMode(value: unknown): 'on' | 'off' | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'on' || normalized === 'off') {
    return normalized;
  }
  return undefined;
}

function normalizeStopMessageAiHistoryEntries(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    if (typeof record.ts === 'number' && Number.isFinite(record.ts)) {
      normalized.ts = Math.floor(record.ts);
    }
    if (typeof record.round === 'number' && Number.isFinite(record.round)) {
      normalized.round = Math.max(0, Math.floor(record.round));
    }
    for (const key of ['assistantText', 'reasoningText', 'responseExcerpt', 'followupText']) {
      const raw = record[key];
      if (typeof raw === 'string' && raw.trim()) {
        normalized[key] = raw.trim();
      }
    }
    if (Object.keys(normalized).length > 0) {
      out.push(normalized);
    }
  }
  return out.slice(-8);
}
