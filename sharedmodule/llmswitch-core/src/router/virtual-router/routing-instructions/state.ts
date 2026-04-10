import type { RoutingInstruction, RoutingInstructionState } from './types.js';
import { applyStopMessageInstructionToState } from '../routing-stop-message-actions.js';
import { applyPreCommandInstructionToState, clearPreCommandState } from '../routing-pre-command-actions.js';
import { deserializeStopMessageState, serializeStopMessageState } from '../routing-stop-message-state-codec.js';
import { deserializePreCommandState, serializePreCommandState } from '../routing-pre-command-state-codec.js';

export function applyRoutingInstructions(
  instructions: RoutingInstruction[],
  currentState: RoutingInstructionState
): RoutingInstructionState {
  const newState: RoutingInstructionState = {
    forcedTarget: currentState.forcedTarget ? { ...currentState.forcedTarget } : undefined,
    stickyTarget: currentState.stickyTarget ? { ...currentState.stickyTarget } : undefined,
    preferTarget: currentState.preferTarget ? { ...currentState.preferTarget } : undefined,
    allowedProviders: new Set(currentState.allowedProviders),
    disabledProviders: new Set(currentState.disabledProviders),
    disabledKeys: new Map(Array.from(currentState.disabledKeys.entries()).map(([k, v]) => [k, new Set(v)])),
    disabledModels: new Map(Array.from(currentState.disabledModels.entries()).map(([k, v]) => [k, new Set(v)])),
    stopMessageSource: currentState.stopMessageSource,
    stopMessageText: currentState.stopMessageText,
    stopMessageMaxRepeats: currentState.stopMessageMaxRepeats,
    stopMessageUsed: currentState.stopMessageUsed,
    stopMessageUpdatedAt: currentState.stopMessageUpdatedAt,
    stopMessageLastUsedAt: currentState.stopMessageLastUsedAt,
    stopMessageStageMode: currentState.stopMessageStageMode,
    stopMessageAiMode: currentState.stopMessageAiMode,
    stopMessageAiSeedPrompt: currentState.stopMessageAiSeedPrompt,
    stopMessageAiHistory: Array.isArray(currentState.stopMessageAiHistory)
      ? currentState.stopMessageAiHistory.map((entry) =>
          entry && typeof entry === 'object' && !Array.isArray(entry)
            ? ({ ...(entry as Record<string, unknown>) } as Record<string, unknown>)
            : {}
        )
      : undefined,
   reasoningStopMode: currentState.reasoningStopMode,
   reasoningStopArmed: currentState.reasoningStopArmed,
   reasoningStopSummary: currentState.reasoningStopSummary,
   reasoningStopUpdatedAt: currentState.reasoningStopUpdatedAt,
    reasoningStopFailCount: currentState.reasoningStopFailCount,
   preCommandSource: currentState.preCommandSource,
    preCommandScriptPath: currentState.preCommandScriptPath,
    preCommandUpdatedAt: currentState.preCommandUpdatedAt,
    chatProcessLastTotalTokens: currentState.chatProcessLastTotalTokens,
    chatProcessLastInputTokens: currentState.chatProcessLastInputTokens,
    chatProcessLastMessageCount: currentState.chatProcessLastMessageCount,
    chatProcessLastUpdatedAt: currentState.chatProcessLastUpdatedAt
  };
  let allowReset = false;
  let disableReset = false;

  for (const instruction of instructions) {
    switch (instruction.type) {
     case 'force':
        newState.forcedTarget = {
          provider: instruction.provider,
          keyAlias: instruction.keyAlias,
          keyIndex: instruction.keyIndex,
          model: instruction.model,
          pathLength: instruction.pathLength,
          processMode: instruction.processMode
        };
        // force 指令同时设置 stickyTarget，确保后续请求继续使用该 provider
        newState.stickyTarget = {
          provider: instruction.provider,
          keyAlias: instruction.keyAlias,
          keyIndex: instruction.keyIndex,
          model: instruction.model,
          pathLength: instruction.pathLength,
          processMode: instruction.processMode
        };
        break;
      case 'sticky':
        newState.stickyTarget = {
          provider: instruction.provider,
          keyAlias: instruction.keyAlias,
          keyIndex: instruction.keyIndex,
          model: instruction.model,
          pathLength: instruction.pathLength,
          processMode: instruction.processMode
        };
        newState.forcedTarget = undefined;
        break;
      case 'prefer':
        newState.preferTarget = {
          provider: instruction.provider,
          keyAlias: instruction.keyAlias,
          keyIndex: instruction.keyIndex,
          model: instruction.model,
          pathLength: instruction.pathLength,
          processMode: instruction.processMode
        };
        newState.forcedTarget = undefined;
        newState.stickyTarget = undefined;
        break;
      case 'allow':
        if (!allowReset) {
          newState.allowedProviders.clear();
          allowReset = true;
        }
        if (instruction.provider) {
          newState.allowedProviders.add(instruction.provider);
        }
        break;
      case 'disable': {
        if (!disableReset) {
          newState.disabledProviders.clear();
          newState.disabledKeys.clear();
          newState.disabledModels.clear();
          disableReset = true;
        }
        if (instruction.provider) {
          const hasKeySpecifier = instruction.keyAlias || instruction.keyIndex !== undefined;
          const hasModelSpecifier = typeof instruction.model === 'string' && instruction.model.length > 0;
          if (hasKeySpecifier) {
            if (!newState.disabledKeys.has(instruction.provider)) {
              newState.disabledKeys.set(instruction.provider, new Set());
            }
            const keySet = newState.disabledKeys.get(instruction.provider)!;
            if (instruction.keyAlias) {
              keySet.add(instruction.keyAlias);
            }
            if (instruction.keyIndex !== undefined) {
              keySet.add(instruction.keyIndex);
            }
          }
          if (hasModelSpecifier) {
            if (!newState.disabledModels.has(instruction.provider)) {
              newState.disabledModels.set(instruction.provider, new Set());
            }
            newState.disabledModels.get(instruction.provider)!.add(instruction.model);
          }
          if (!hasKeySpecifier && !hasModelSpecifier) {
            newState.disabledProviders.add(instruction.provider);
          }
        }
        break;
      }
      case 'enable': {
        if (instruction.provider) {
          const hasKeySpecifier = instruction.keyAlias || instruction.keyIndex !== undefined;
          const hasModelSpecifier = typeof instruction.model === 'string' && instruction.model.length > 0;
          if (hasKeySpecifier) {
            const keySet = newState.disabledKeys.get(instruction.provider);
            if (keySet) {
              if (instruction.keyAlias) {
                keySet.delete(instruction.keyAlias);
              }
              if (instruction.keyIndex !== undefined) {
                keySet.delete(instruction.keyIndex);
              }
              if (keySet.size === 0) {
                newState.disabledKeys.delete(instruction.provider);
              }
            }
          }
          if (hasModelSpecifier) {
            const modelSet = newState.disabledModels.get(instruction.provider);
            if (modelSet) {
              modelSet.delete(instruction.model);
              if (modelSet.size === 0) {
                newState.disabledModels.delete(instruction.provider);
              }
            }
          }
          if (!hasKeySpecifier && !hasModelSpecifier) {
            newState.disabledProviders.delete(instruction.provider);
            newState.disabledKeys.delete(instruction.provider);
            newState.disabledModels.delete(instruction.provider);
          }
        }
        break;
      }
      case 'clear':
        newState.forcedTarget = undefined;
        newState.stickyTarget = undefined;
        newState.preferTarget = undefined;
        newState.allowedProviders.clear();
        newState.disabledProviders.clear();
        newState.disabledKeys.clear();
        newState.disabledModels.clear();
        applyStopMessageInstructionToState({ type: 'stopMessageClear' }, newState);
       newState.reasoningStopMode = undefined;
       newState.reasoningStopArmed = undefined;
       newState.reasoningStopSummary = undefined;
       newState.reasoningStopUpdatedAt = undefined;
        newState.reasoningStopFailCount = undefined;
       clearPreCommandState(newState);
        break;
      case 'stopMessageSet':
      case 'stopMessageMode':
      case 'stopMessageClear':
        applyStopMessageInstructionToState(instruction, newState);
        break;
      case 'preCommandSet':
      case 'preCommandClear':
        applyPreCommandInstructionToState(instruction, newState);
        break;
    }
  }

  return newState;
}

export function serializeRoutingInstructionState(state: RoutingInstructionState): Record<string, unknown> {
  return {
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
    ...(typeof state.reasoningStopMode === 'string'
      && (state.reasoningStopMode === 'on' || state.reasoningStopMode === 'off' || state.reasoningStopMode === 'endless')
      ? { reasoningStopMode: state.reasoningStopMode }
      : {}),
    ...(typeof state.reasoningStopArmed === 'boolean'
      ? { reasoningStopArmed: state.reasoningStopArmed }
      : {}),
    ...(typeof state.reasoningStopSummary === 'string' && state.reasoningStopSummary.trim()
      ? { reasoningStopSummary: state.reasoningStopSummary.trim() }
      : {}),
   ...(typeof state.reasoningStopUpdatedAt === 'number' && Number.isFinite(state.reasoningStopUpdatedAt)
     ? { reasoningStopUpdatedAt: state.reasoningStopUpdatedAt }
     : {}),
    ...(typeof state.reasoningStopFailCount === 'number' && Number.isFinite(state.reasoningStopFailCount)
      ? { reasoningStopFailCount: state.reasoningStopFailCount }
      : {}),
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
   reasoningStopMode: undefined,
   reasoningStopArmed: undefined,
   reasoningStopSummary: undefined,
   reasoningStopUpdatedAt: undefined,
    reasoningStopFailCount: undefined,
   preCommandSource: undefined,
    preCommandScriptPath: undefined,
    preCommandUpdatedAt: undefined,
    chatProcessLastTotalTokens: undefined,
    chatProcessLastInputTokens: undefined,
    chatProcessLastMessageCount: undefined,
    chatProcessLastUpdatedAt: undefined
  };

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
  if (typeof data.reasoningStopMode === 'string') {
    const normalizedMode = data.reasoningStopMode.trim().toLowerCase();
    if (normalizedMode === 'on' || normalizedMode === 'off' || normalizedMode === 'endless') {
      state.reasoningStopMode = normalizedMode as 'on' | 'off' | 'endless';
    }
  }
  if (typeof data.reasoningStopArmed === 'boolean') {
    state.reasoningStopArmed = data.reasoningStopArmed;
  }
  if (typeof data.reasoningStopSummary === 'string' && data.reasoningStopSummary.trim()) {
    state.reasoningStopSummary = data.reasoningStopSummary.trim();
  }
  if (typeof data.reasoningStopUpdatedAt === 'number' && Number.isFinite(data.reasoningStopUpdatedAt)) {
    state.reasoningStopUpdatedAt = Math.max(0, Math.round(data.reasoningStopUpdatedAt));
  }
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
