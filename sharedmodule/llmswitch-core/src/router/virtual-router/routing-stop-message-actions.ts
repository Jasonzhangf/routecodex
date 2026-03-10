import type { RoutingInstruction, RoutingInstructionState } from './routing-instructions.js';
import {
  normalizeStopMessageStageMode
} from './routing-stop-message-state-codec.js';
import {
  applyStopMessageInstructionWithNative,
  type NativeStopMessageActionPatch
} from './engine-selection/native-virtual-router-stop-message-actions-semantics.js';

type StopMessageFieldName =
  | 'stopMessageSource'
  | 'stopMessageText'
  | 'stopMessageMaxRepeats'
  | 'stopMessageUsed'
  | 'stopMessageUpdatedAt'
  | 'stopMessageLastUsedAt'
  | 'stopMessageStageMode'
  | 'stopMessageAiMode'
  | 'stopMessageAiSeedPrompt'
  | 'stopMessageAiHistory';

type StopMessageStateSnapshot = Partial<Pick<RoutingInstructionState, StopMessageFieldName>>;

const STOP_MESSAGE_FIELDS: StopMessageFieldName[] = [
  'stopMessageSource',
  'stopMessageText',
  'stopMessageMaxRepeats',
  'stopMessageUsed',
  'stopMessageUpdatedAt',
  'stopMessageLastUsedAt',
  'stopMessageStageMode',
  'stopMessageAiMode',
  'stopMessageAiSeedPrompt',
  'stopMessageAiHistory'
];

const SKIP_PATCH_VALUE = Symbol('skipPatchValue');

export function applyStopMessageInstructionToState(
  instruction: RoutingInstruction,
  state: RoutingInstructionState
): boolean {
  const nowMs = Date.now();
  const before = snapshotStopMessageState(state);
  const patch = applyStopMessageInstructionWithNative(instruction, before, nowMs);
  applyStopMessagePatch(state, patch);
  return patch.applied;
}

function snapshotStopMessageState(state: RoutingInstructionState): StopMessageStateSnapshot {
  return {
    stopMessageSource: state.stopMessageSource,
    stopMessageText: state.stopMessageText,
    stopMessageMaxRepeats: state.stopMessageMaxRepeats,
    stopMessageUsed: state.stopMessageUsed,
    stopMessageUpdatedAt: state.stopMessageUpdatedAt,
    stopMessageLastUsedAt: state.stopMessageLastUsedAt,
    stopMessageStageMode: state.stopMessageStageMode,
    stopMessageAiMode: state.stopMessageAiMode,
    stopMessageAiSeedPrompt: state.stopMessageAiSeedPrompt,
    stopMessageAiHistory: Array.isArray(state.stopMessageAiHistory) ? cloneHistory(state.stopMessageAiHistory) : undefined
  };
}

function applyStopMessagePatch(
  state: RoutingInstructionState,
  patch: NativeStopMessageActionPatch
): void {
  for (const field of patch.unset) {
    if (!STOP_MESSAGE_FIELDS.includes(field as StopMessageFieldName)) {
      continue;
    }
    (state as unknown as Record<string, unknown>)[field] = undefined;
  }

  for (const [field, rawValue] of Object.entries(patch.set)) {
    const value = coerceStopMessagePatchValue(field, rawValue);
    if (value === SKIP_PATCH_VALUE) {
      continue;
    }
    (state as unknown as Record<string, unknown>)[field] = value;
  }
}

function coerceStopMessagePatchValue(
  field: string,
  value: unknown
): unknown | typeof SKIP_PATCH_VALUE {
  switch (field) {
    case 'stopMessageSource':
    case 'stopMessageText':
    case 'stopMessageAiSeedPrompt':
      return typeof value === 'string' ? value : SKIP_PATCH_VALUE;
    case 'stopMessageStageMode': {
      const normalized = normalizeStopMessageStageMode(value);
      return normalized ?? SKIP_PATCH_VALUE;
    }
    case 'stopMessageAiMode': {
      const normalizedAiMode = normalizeStopMessageAiMode(value);
      return normalizedAiMode ?? SKIP_PATCH_VALUE;
    }
    case 'stopMessageMaxRepeats':
    case 'stopMessageUsed':
    case 'stopMessageUpdatedAt':
    case 'stopMessageLastUsedAt':
      return typeof value === 'number' && Number.isFinite(value) ? value : SKIP_PATCH_VALUE;
    case 'stopMessageAiHistory': {
      if (!Array.isArray(value)) {
        return SKIP_PATCH_VALUE;
      }
      return cloneHistory(value as Array<Record<string, unknown>>);
    }
  }
  return SKIP_PATCH_VALUE;
}

function cloneHistory(
  value: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    out.push({ ...(item as Record<string, unknown>) });
  }
  return out;
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
