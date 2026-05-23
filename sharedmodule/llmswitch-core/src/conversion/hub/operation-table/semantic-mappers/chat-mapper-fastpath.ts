import type { JsonObject, JsonValue } from '../../types/json.js';
export interface ChatPayload extends JsonObject {
  messages?: JsonValue[];
  tools?: JsonValue[];
  tool_outputs?: JsonValue[];
}

export function maybeAugmentApplyPatchErrorContent(content: string, toolName?: string): string {
  if (!content) return content;
  void toolName;
  return content;
}
