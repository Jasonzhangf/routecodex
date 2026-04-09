import type { RoutingInstructionState } from './routing-instructions.js';

type StopMessageSubset = Pick<
  RoutingInstructionState,
  | 'stopMessageSource'
  | 'stopMessageText'
  | 'stopMessageMaxRepeats'
  | 'stopMessageUsed'
  | 'stopMessageStageMode'
  | 'stopMessageAiMode'
  | 'stopMessageAiSeedPrompt'
  | 'stopMessageAiHistory'
  | 'stopMessageUpdatedAt'
  | 'stopMessageLastUsedAt'
  | 'reasoningStopMode'
  | 'reasoningStopArmed'
  | 'reasoningStopSummary'
  | 'reasoningStopUpdatedAt'
>;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function updatedAtOf(state: StopMessageSubset | null | undefined): number | null {
  if (!state) return null;
  return isFiniteNumber(state.stopMessageUpdatedAt) ? state.stopMessageUpdatedAt : null;
}

function lastUsedAtOf(state: StopMessageSubset | null | undefined): number | null {
  if (!state) return null;
  return isFiniteNumber(state.stopMessageLastUsedAt) ? state.stopMessageLastUsedAt : null;
}

function usedOf(state: StopMessageSubset | null | undefined): number | null {
  if (!state) return null;
  return isFiniteNumber(state.stopMessageUsed) ? state.stopMessageUsed : null;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sameStopMessageConfig(existing: StopMessageSubset, persisted: StopMessageSubset): boolean {
  return normalizeText(existing.stopMessageText) === normalizeText(persisted.stopMessageText)
    && existing.stopMessageMaxRepeats === persisted.stopMessageMaxRepeats
    && normalizeText(existing.stopMessageStageMode) === normalizeText(persisted.stopMessageStageMode)
    && normalizeText(existing.stopMessageAiMode) === normalizeText(persisted.stopMessageAiMode);
}

function overlayPersistedUsage(existing: StopMessageSubset, persisted: StopMessageSubset): StopMessageSubset {
  return {
    ...existing,
    stopMessageUsed: persisted.stopMessageUsed,
    stopMessageLastUsedAt: persisted.stopMessageLastUsedAt,
    stopMessageAiSeedPrompt: persisted.stopMessageAiSeedPrompt,
    stopMessageAiHistory: persisted.stopMessageAiHistory,
    reasoningStopMode: persisted.reasoningStopMode,
    reasoningStopArmed: persisted.reasoningStopArmed,
    reasoningStopSummary: persisted.reasoningStopSummary,
    reasoningStopUpdatedAt: persisted.reasoningStopUpdatedAt
  };
}

/**
 * Decide whether we should overwrite in-memory stopMessage fields with persisted ones.
 *
 * Key invariant:
 * - In-memory state may be ahead of disk because persistence is async (tmp+rename).
 * - Persisted state must still be able to update usage counters (stop_message_auto).
 *
 * Strategy:
 * - If existing has a newer stopMessageUpdatedAt than persisted → keep existing config by default.
 * - However, when persisted carries the same stopMessage config but newer usage progress,
 *   prefer the persisted counters so Virtual Router logs/state reflect real stop_message_auto consumption.
 * - Otherwise → adopt persisted fully.
 */
export function mergeStopMessageFromPersisted(
  existing: StopMessageSubset,
  persisted: StopMessageSubset | null
): StopMessageSubset {
  if (!persisted) {
    return { ...existing };
  }

  const existingUpdatedAt = updatedAtOf(existing);
  const persistedUpdatedAt = updatedAtOf(persisted);
  const existingIsNewer =
    existingUpdatedAt !== null && (persistedUpdatedAt === null || persistedUpdatedAt < existingUpdatedAt);

  if (existingIsNewer) {
    const existingUsed = usedOf(existing) ?? 0;
    const persistedUsed = usedOf(persisted) ?? 0;
    const existingLastUsedAt = lastUsedAtOf(existing);
    const persistedLastUsedAt = lastUsedAtOf(persisted);
    const persistedHasUsageProgress =
      persistedUsed > existingUsed
      && (existingLastUsedAt === null || (persistedLastUsedAt !== null && persistedLastUsedAt >= existingLastUsedAt));

    if (persistedHasUsageProgress && sameStopMessageConfig(existing, persisted)) {
      return overlayPersistedUsage(existing, persisted);
    }

    return { ...existing };
  }

  return {
    ...existing,
    stopMessageSource: persisted.stopMessageSource,
    stopMessageText: persisted.stopMessageText,
    stopMessageMaxRepeats: persisted.stopMessageMaxRepeats,
    stopMessageUsed: persisted.stopMessageUsed,
    stopMessageStageMode: persisted.stopMessageStageMode,
    stopMessageAiMode: persisted.stopMessageAiMode,
    stopMessageAiSeedPrompt: persisted.stopMessageAiSeedPrompt,
    stopMessageAiHistory: persisted.stopMessageAiHistory,
    stopMessageUpdatedAt: persisted.stopMessageUpdatedAt,
    stopMessageLastUsedAt: persisted.stopMessageLastUsedAt,
    reasoningStopMode: persisted.reasoningStopMode,
    reasoningStopArmed: persisted.reasoningStopArmed,
    reasoningStopSummary: persisted.reasoningStopSummary,
    reasoningStopUpdatedAt: persisted.reasoningStopUpdatedAt
  };
}
