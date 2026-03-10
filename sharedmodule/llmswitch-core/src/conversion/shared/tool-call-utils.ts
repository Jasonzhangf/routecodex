import {
  deriveToolCallKeyWithNative,
  mergeToolCallsWithNative
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

type UnknownRecord = Record<string, unknown>;

/**
 * Derive a deterministic key for a tool call by combining the normalized
 * function name and serialized arguments. Used to deduplicate inferred calls.
 */
export function deriveToolCallKey(call: UnknownRecord | null | undefined): string | null {
  return deriveToolCallKeyWithNative(call);
}

/**
 * Merge tool call entries with deduplication (by derived key). Returns the new array.
 */
export function mergeToolCalls(
  existing: UnknownRecord[] | undefined,
  additions: UnknownRecord[] | undefined
): UnknownRecord[] {
  return mergeToolCallsWithNative(existing, additions);
}
