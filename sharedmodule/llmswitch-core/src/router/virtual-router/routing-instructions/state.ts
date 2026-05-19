import type { RoutingInstruction, RoutingInstructionState } from './types.js';
import { deserializeStopMessageState, serializeStopMessageState } from '../routing-stop-message-state-codec.js';
import { deserializePreCommandState, serializePreCommandState } from '../routing-pre-command-state-codec.js';

export function serializeRoutingInstructionState(state: RoutingInstructionState): Record<string, unknown> {
  return {
    ...(state.stoplessGoalState &&
    typeof state.stoplessGoalState === 'object' &&
    typeof state.stoplessGoalState.status === 'string' &&
    typeof state.stoplessGoalState.objective === 'string' &&
    typeof state.stoplessGoalState.updatedAt === 'number' &&
    Number.isFinite(state.stoplessGoalState.updatedAt) &&
    typeof state.stoplessGoalState.createdAt === 'number' &&
    Number.isFinite(state.stoplessGoalState.createdAt)
      ? {
          stoplessGoalState: {
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
          }
        }
      : {}),
    forcedTarget: state.forcedTarget,
    stickyTarget: state.stickyTarget,
    preferTarget: state.preferTarget,
    allowedProviders: Array.from(state.allowedProviders),
    disabledProviders: Array.from(state.disabledProviders),
    disabledKeys: Array.from(state.disabledKeys.entries()).map(([provider, keys]) => ({
      provider,
      keys: Array.from(keys)
    })),
    disabledModels: Array.from(state.disabledModels.entries()).map(([provider, models]) => ({
      provider,
      models: Array.from(models)
    })),
    ...serializeStopMessageState(state),
   ...serializePreCommandState(state),
    ...(typeof state.chatProcessLastTotalTokens === 'number'
      ? { chatProcessLastTotalTokens: state.chatProcessLastTotalTokens }
      : {}),
    ...(typeof state.chatProcessLastInputTokens === 'number'
      ? { chatProcessLastInputTokens: state.chatProcessLastInputTokens }
      : {}),
    ...(typeof state.chatProcessLastMessageCount === 'number'
      ? { chatProcessLastMessageCount: state.chatProcessLastMessageCount }
      : {}),
    ...(typeof state.chatProcessLastUpdatedAt === 'number'
      ? { chatProcessLastUpdatedAt: state.chatProcessLastUpdatedAt }
      : {})
  };
}

export function deserializeRoutingInstructionState(data: Record<string, unknown>): RoutingInstructionState {
  const state: RoutingInstructionState = {
    stoplessGoalState: undefined,
    forcedTarget: undefined,
    stickyTarget: undefined,
    preferTarget: undefined,
    allowedProviders: new Set(),
    disabledProviders: new Set(),
    disabledKeys: new Map(),
    disabledModels: new Map(),
    stopMessageText: undefined,
    stopMessageSource: undefined,
    stopMessageMaxRepeats: undefined,
    stopMessageUsed: undefined,
    stopMessageStageMode: undefined,
    stopMessageAiMode: undefined,
    stopMessageAiSeedPrompt: undefined,
    stopMessageAiHistory: undefined,
   preCommandSource: undefined,
    preCommandScriptPath: undefined,
    preCommandUpdatedAt: undefined,
    chatProcessLastTotalTokens: undefined,
    chatProcessLastInputTokens: undefined,
    chatProcessLastMessageCount: undefined,
    chatProcessLastUpdatedAt: undefined
  };

  if (data.stoplessGoalState && typeof data.stoplessGoalState === 'object' && !Array.isArray(data.stoplessGoalState)) {
    const goal = data.stoplessGoalState as Record<string, unknown>;
    const status =
      typeof goal.status === 'string'
        ? goal.status.trim().toLowerCase()
        : '';
    const objective =
      typeof goal.objective === 'string'
        ? goal.objective.trim()
        : '';
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
      } as RoutingInstructionState['stoplessGoalState'];
    }
  }

  if (data.forcedTarget && typeof data.forcedTarget === 'object') {
    state.forcedTarget = data.forcedTarget as any;
  }
  if (data.stickyTarget && typeof data.stickyTarget === 'object') {
    state.stickyTarget = data.stickyTarget as any;
  }
  if (data.preferTarget && typeof data.preferTarget === 'object') {
    state.preferTarget = data.preferTarget as any;
  }
  if (Array.isArray(data.allowedProviders)) {
    state.allowedProviders = new Set(data.allowedProviders as string[]);
  }
  if (Array.isArray(data.disabledProviders)) {
    state.disabledProviders = new Set(data.disabledProviders as string[]);
  }
  if (Array.isArray(data.disabledKeys)) {
    for (const entry of data.disabledKeys as any[]) {
      if (entry.provider && Array.isArray(entry.keys)) {
        state.disabledKeys.set(entry.provider, new Set(entry.keys));
      }
    }
  }
  if (Array.isArray(data.disabledModels)) {
    for (const entry of data.disabledModels as any[]) {
      if (entry.provider && Array.isArray(entry.models)) {
        state.disabledModels.set(entry.provider, new Set(entry.models));
      }
    }
  }

  deserializeStopMessageState(data, state);
  deserializePreCommandState(data, state);
  if (typeof data.chatProcessLastTotalTokens === 'number' && Number.isFinite(data.chatProcessLastTotalTokens)) {
    state.chatProcessLastTotalTokens = Math.max(0, Math.round(data.chatProcessLastTotalTokens));
  }
  if (typeof data.chatProcessLastInputTokens === 'number' && Number.isFinite(data.chatProcessLastInputTokens)) {
    state.chatProcessLastInputTokens = Math.max(0, Math.round(data.chatProcessLastInputTokens));
  }
  if (typeof data.chatProcessLastMessageCount === 'number' && Number.isFinite(data.chatProcessLastMessageCount)) {
    state.chatProcessLastMessageCount = Math.max(0, Math.round(data.chatProcessLastMessageCount));
  }
  if (typeof data.chatProcessLastUpdatedAt === 'number' && Number.isFinite(data.chatProcessLastUpdatedAt)) {
    state.chatProcessLastUpdatedAt = Math.max(0, Math.round(data.chatProcessLastUpdatedAt));
  }

  return state;
}
