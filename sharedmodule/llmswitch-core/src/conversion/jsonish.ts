// Shared JSON-ish parsing helpers
import {
  parseLenientJsonishWithNative,
  repairArgumentsToStringWithNative
} from '../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

export function tryParseJson<T = unknown>(s: unknown): T | unknown {
  if (typeof s !== 'string') return s as T;
  try { return JSON.parse(s) as T; } catch { return s as T; }
}

// Lenient parsing for function.arguments often produced by models
export function parseLenient(value: unknown): unknown {
  return parseLenientJsonishWithNative(value);
}

// CCR-style repair: JSON -> JSON5-like cleanup -> safe fallback
export function repairArgumentsToString(value: unknown): string {
  return repairArgumentsToStringWithNative(value);
}
