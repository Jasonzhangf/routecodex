import type { JsonObject, JsonValue } from '../../types/json.js';
import { augmentApplyPatchErrorContentWithNative } from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-semantic-mappers.js';

export interface ChatPayload extends JsonObject {
  messages?: JsonValue[];
  tools?: JsonValue[];
  tool_outputs?: JsonValue[];
}

export function maybeAugmentApplyPatchErrorContent(content: string, toolName?: string): string {
  if (!content) return content;
  return augmentApplyPatchErrorContentWithNative(content, toolName);
}
