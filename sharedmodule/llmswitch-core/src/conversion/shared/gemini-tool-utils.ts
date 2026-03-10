import type { BridgeToolDefinition } from '../types/bridge-message-types.js';
import type { MissingField } from '../hub/types/chat-envelope.js';
import type { JsonValue, JsonObject } from '../hub/types/json.js';
import {
  buildGeminiToolsFromBridgeWithNative,
  prepareGeminiToolsForBridgeWithNative
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

export function prepareGeminiToolsForBridge(
  rawTools: JsonValue | undefined,
  missing?: MissingField[]
): BridgeToolDefinition[] | undefined {
  if (!rawTools) {
    return undefined;
  }
  const result = prepareGeminiToolsForBridgeWithNative(rawTools, Array.isArray(missing) ? (missing as unknown[]) : []);
  if (Array.isArray(missing)) {
    missing.splice(0, missing.length, ...(result.missing as MissingField[]));
  }
  const defs = result.defs as BridgeToolDefinition[] | undefined;
  return defs && defs.length ? defs : undefined;
}

export function buildGeminiToolsFromBridge(
  defs: BridgeToolDefinition[] | undefined,
  options?: { mode?: 'antigravity' | 'default' }
): JsonObject[] | undefined {
  if (!defs || !defs.length) {
    return undefined;
  }
  const mode = options?.mode === 'antigravity' ? 'antigravity' : 'default';
  const out = buildGeminiToolsFromBridgeWithNative(defs as unknown, mode) as JsonObject[] | undefined;
  return out && out.length ? out : undefined;
}
