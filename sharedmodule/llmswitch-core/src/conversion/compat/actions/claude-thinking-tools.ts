import type { JsonObject } from '../../hub/types/json.js';
import { applyClaudeThinkingToolSchemaCompatWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';

export function applyClaudeThinkingToolSchemaCompat(
  payload: JsonObject
): JsonObject {
  return applyClaudeThinkingToolSchemaCompatWithNative(payload);
}
