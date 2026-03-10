import type { JsonObject } from '../../hub/types/json.js';
import { applyToolTextRequestGuidanceWithNative } from '../../../router/virtual-router/engine-selection/native-compat-action-semantics.js';

export interface ToolTextRequestGuidanceConfig {
  enabled?: boolean;
  marker?: string;
  instruction?: string;
  requireTools?: boolean;
  includeToolNames?: boolean;
}

export function applyToolTextRequestGuidance(
  payload: JsonObject,
  config?: ToolTextRequestGuidanceConfig,
): JsonObject {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }

  return applyToolTextRequestGuidanceWithNative(
    payload as unknown as Record<string, unknown>,
    (config ?? {}) as unknown as Record<string, unknown>,
  ) as unknown as JsonObject;
}
