import type { RoutingInstructionState } from './routing-instructions.js';
import {
  deserializeStopMessageStateWithNative,
  serializeStopMessageStateWithNative
} from './engine-selection/native-virtual-router-stop-message-state-semantics.js';

export const DEFAULT_STOP_MESSAGE_MAX_REPEATS = 10;

export function serializeStopMessageState(state: RoutingInstructionState): Record<string, unknown> {
  const out = serializeStopMessageStateWithNative(state);
  if (
    state.stoplessGoalState &&
    typeof state.stoplessGoalState.status === 'string' &&
    typeof state.stoplessGoalState.objective === 'string' &&
    typeof state.stoplessGoalState.updatedAt === 'number' &&
    Number.isFinite(state.stoplessGoalState.updatedAt) &&
    typeof state.stoplessGoalState.createdAt === 'number' &&
    Number.isFinite(state.stoplessGoalState.createdAt)
  ) {
    out.stoplessGoalState = {
      status: state.stoplessGoalState.status,
      objective: state.stoplessGoalState.objective,
      ...(typeof state.stoplessGoalState.latestNote === 'string' && state.stoplessGoalState.latestNote.trim()
        ? { latestNote: state.stoplessGoalState.latestNote.trim() }
        : {}),
      ...(typeof state.stoplessGoalState.completionEvidence === 'string' && state.stoplessGoalState.completionEvidence.trim()
        ? { completionEvidence: state.stoplessGoalState.completionEvidence.trim() }
        : {}),
      ...(typeof state.stoplessGoalState.nextStep === 'string' && state.stoplessGoalState.nextStep.trim()
        ? { nextStep: state.stoplessGoalState.nextStep.trim() }
        : {}),
      ...(typeof state.stoplessGoalState.userQuestion === 'string' && state.stoplessGoalState.userQuestion.trim()
        ? { userQuestion: state.stoplessGoalState.userQuestion.trim() }
        : {}),
      ...(typeof state.stoplessGoalState.cannotContinueReason === 'string' && state.stoplessGoalState.cannotContinueReason.trim()
        ? { cannotContinueReason: state.stoplessGoalState.cannotContinueReason.trim() }
        : {}),
      ...(typeof state.stoplessGoalState.blockingEvidence === 'string' && state.stoplessGoalState.blockingEvidence.trim()
        ? { blockingEvidence: state.stoplessGoalState.blockingEvidence.trim() }
        : {}),
      ...(state.stoplessGoalState.attemptsExhausted === true ? { attemptsExhausted: true } : {}),
      ...(typeof state.stoplessGoalState.errorClass === 'string' && state.stoplessGoalState.errorClass.trim()
        ? { errorClass: state.stoplessGoalState.errorClass.trim() }
        : {}),
      ...(typeof state.stoplessGoalState.completionSummary === 'string' && state.stoplessGoalState.completionSummary.trim()
        ? { completionSummary: state.stoplessGoalState.completionSummary.trim() }
        : {}),
      ...(typeof state.stoplessGoalState.ssotAssessment === 'string' && state.stoplessGoalState.ssotAssessment.trim()
        ? { ssotAssessment: state.stoplessGoalState.ssotAssessment.trim() }
        : {}),
      ...(typeof state.stoplessGoalState.consecutiveIrrecoverableErrors === 'number' &&
      Number.isFinite(state.stoplessGoalState.consecutiveIrrecoverableErrors)
        ? { consecutiveIrrecoverableErrors: Math.max(0, Math.floor(state.stoplessGoalState.consecutiveIrrecoverableErrors)) }
        : {}),
      ...(typeof state.stoplessGoalState.consecutiveValidationFailures === 'number' &&
      Number.isFinite(state.stoplessGoalState.consecutiveValidationFailures)
        ? { consecutiveValidationFailures: Math.max(0, Math.floor(state.stoplessGoalState.consecutiveValidationFailures)) }
        : {}),
      ...(typeof state.stoplessGoalState.consecutiveNoProgress === 'number' &&
      Number.isFinite(state.stoplessGoalState.consecutiveNoProgress)
        ? { consecutiveNoProgress: Math.max(0, Math.floor(state.stoplessGoalState.consecutiveNoProgress)) }
        : {}),
      updatedAt: Math.max(0, Math.round(state.stoplessGoalState.updatedAt)),
      createdAt: Math.max(0, Math.round(state.stoplessGoalState.createdAt))
    };
  }
  return out;
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
  if (data.stoplessGoalState && typeof data.stoplessGoalState === 'object' && !Array.isArray(data.stoplessGoalState)) {
    const goal = data.stoplessGoalState as Record<string, unknown>;
    const status = typeof goal.status === 'string' ? goal.status.trim().toLowerCase() : '';
    const objective = typeof goal.objective === 'string' ? goal.objective.trim() : '';
    const updatedAt =
      typeof goal.updatedAt === 'number' && Number.isFinite(goal.updatedAt)
        ? Math.max(0, Math.round(goal.updatedAt))
        : undefined;
    const createdAt =
      typeof goal.createdAt === 'number' && Number.isFinite(goal.createdAt)
        ? Math.max(0, Math.round(goal.createdAt))
        : undefined;
    if (
      (status === 'idle' || status === 'active' || status === 'paused' || status === 'stopped' || status === 'completed') &&
      objective &&
      typeof updatedAt === 'number' &&
      typeof createdAt === 'number'
    ) {
      state.stoplessGoalState = {
        status,
        objective,
        ...(typeof goal.latestNote === 'string' && goal.latestNote.trim()
          ? { latestNote: goal.latestNote.trim() }
          : {}),
        ...(typeof goal.completionEvidence === 'string' && goal.completionEvidence.trim()
          ? { completionEvidence: goal.completionEvidence.trim() }
          : {}),
        ...(typeof goal.nextStep === 'string' && goal.nextStep.trim()
          ? { nextStep: goal.nextStep.trim() }
          : {}),
        ...(typeof goal.userQuestion === 'string' && goal.userQuestion.trim()
          ? { userQuestion: goal.userQuestion.trim() }
          : {}),
        ...(typeof goal.cannotContinueReason === 'string' && goal.cannotContinueReason.trim()
          ? { cannotContinueReason: goal.cannotContinueReason.trim() }
          : {}),
        ...(typeof goal.blockingEvidence === 'string' && goal.blockingEvidence.trim()
          ? { blockingEvidence: goal.blockingEvidence.trim() }
          : {}),
        ...(goal.attemptsExhausted === true ? { attemptsExhausted: true } : {}),
        ...(typeof goal.errorClass === 'string' && goal.errorClass.trim()
          ? { errorClass: goal.errorClass.trim() }
          : {}),
        ...(typeof goal.completionSummary === 'string' && goal.completionSummary.trim()
          ? { completionSummary: goal.completionSummary.trim() }
          : {}),
        ...(typeof goal.ssotAssessment === 'string' && goal.ssotAssessment.trim()
          ? { ssotAssessment: goal.ssotAssessment.trim() }
          : {}),
        ...(typeof goal.consecutiveIrrecoverableErrors === 'number' && Number.isFinite(goal.consecutiveIrrecoverableErrors)
          ? { consecutiveIrrecoverableErrors: Math.max(0, Math.floor(goal.consecutiveIrrecoverableErrors)) }
          : {}),
        ...(typeof goal.consecutiveValidationFailures === 'number' && Number.isFinite(goal.consecutiveValidationFailures)
          ? { consecutiveValidationFailures: Math.max(0, Math.floor(goal.consecutiveValidationFailures)) }
          : {}),
        ...(typeof goal.consecutiveNoProgress === 'number' && Number.isFinite(goal.consecutiveNoProgress)
          ? { consecutiveNoProgress: Math.max(0, Math.floor(goal.consecutiveNoProgress)) }
          : {}),
        updatedAt,
        createdAt
      };
    }
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
