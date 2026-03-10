import {
  clampResponsesInputItemIdWithNative,
  normalizeFunctionCallIdWithNative,
  normalizeFunctionCallOutputIdWithNative,
  normalizeResponsesCallIdWithNative
} from '../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

type NormalizeOptions = {
  callId?: string;
  fallback?: string;
};

export function normalizeFunctionCallId(options: NormalizeOptions): string {
  return normalizeFunctionCallIdWithNative(options);
}

export function normalizeFunctionCallOutputId(options: NormalizeOptions): string {
  return normalizeFunctionCallOutputIdWithNative(options);
}

export function normalizeResponsesCallId(options: NormalizeOptions): string {
  return normalizeResponsesCallIdWithNative(options);
}

export function clampResponsesInputItemId(raw: unknown): string | undefined {
  return clampResponsesInputItemIdWithNative(raw);
}
