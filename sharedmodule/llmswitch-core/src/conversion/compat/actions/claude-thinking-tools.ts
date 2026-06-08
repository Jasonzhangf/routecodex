import type { JsonObject } from '../../hub/types/json.js';
import { applyClaudeThinkingToolSchemaCompatWithNative } from '../../../native/router-hotpath/native-hub-pipeline-req-outbound-semantics.js';

export function applyClaudeThinkingToolSchemaCompat(
  payload: JsonObject
): JsonObject {
  return applyClaudeThinkingToolSchemaCompatWithNative(payload);
}
