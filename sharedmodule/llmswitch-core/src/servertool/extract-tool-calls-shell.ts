import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ToolCall } from './types.js';
import { runServertoolResponseStageWithNative } from 'rcc-llmswitch-core/native/servertool-wrapper';
import { replaceJsonObjectInPlace } from './orchestration-blocks.js';

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
