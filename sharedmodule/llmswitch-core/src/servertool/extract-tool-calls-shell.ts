import type { JsonObject, ToolCall } from './types.js';
import { runServertoolResponseStageWithNative } from 'rcc-llmswitch-core/native/servertool-wrapper';

function replaceJsonObjectInPlace(target: JsonObject, next: JsonObject): void {
  const newKeys = new Set(Object.keys(next));
  for (const [key, value] of Object.entries(next)) {
    target[key] = value;
  }
  for (const key of Object.keys(target)) {
    if (!newKeys.has(key)) {
      delete target[key];
    }
  }
}

export const extractToolCallsFromResponseStage = (chatResponse: JsonObject, requestId = ''): ToolCall[] => {
  const stage = runServertoolResponseStageWithNative(chatResponse, requestId);
  const normalizedPayload =
    stage.normalizedPayload != null && typeof stage.normalizedPayload === 'object' && !Array.isArray(stage.normalizedPayload)
      ? stage.normalizedPayload
      : chatResponse;
  replaceJsonObjectInPlace(chatResponse, normalizedPayload);
  return stage.toolCalls.map((entry) => ({
    id: entry.id,
    name: entry.name,
    arguments: entry.arguments
  }));
};
